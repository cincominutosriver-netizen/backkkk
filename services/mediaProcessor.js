const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const VIDEO_MAX_BYTES = 80 * 1024 * 1024;
const VIDEO_MAX_DURATION_SECONDS = 20;
const CLIPPED_VIDEO_DURATION_SECONDS = 4;
const FILE_TYPE_SNIFF_BYTES = 8192;
const FFMPEG_THREAD_COUNT = Math.max(1, Math.min(2, Number(os.cpus()?.length || 1)));
const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
  'image/tiff',
  'image/bmp',
  'image/x-ms-bmp'
]);
const VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
  'video/x-msvideo',
  'video/msvideo',
  'video/x-ms-wmv',
  'video/x-m4v'
]);
const MODERATION_LEVELS = ['UNKNOWN', 'VERY_UNLIKELY', 'UNLIKELY', 'POSSIBLE', 'LIKELY', 'VERY_LIKELY'];
const MODERATION_BLOCK_SET = new Set(['LIKELY', 'VERY_LIKELY']);

const R2_ENDPOINT = String(process.env.R2_ENDPOINT || '').trim();
const R2_REGION = String(process.env.R2_REGION || 'auto').trim();
const R2_BUCKET = String(process.env.R2_BUCKET || '').trim();
const R2_ACCESS_KEY_ID = String(process.env.R2_ACCESS_KEY_ID || '').trim();
const R2_SECRET_ACCESS_KEY = String(process.env.R2_SECRET_ACCESS_KEY || '').trim();
const R2_PUBLIC_BASE_URL = String(process.env.R2_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');

const hasR2Config =
  Boolean(R2_ENDPOINT) &&
  Boolean(R2_BUCKET) &&
  Boolean(R2_ACCESS_KEY_ID) &&
  Boolean(R2_SECRET_ACCESS_KEY);

const r2Client = hasR2Config
  ? new S3Client({
      region: R2_REGION,
      endpoint: R2_ENDPOINT,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY
      }
    })
  : null;

const makeId = () => crypto.randomBytes(16).toString('hex');
let fileTypeModulePromise = null;

const detectFileTypeFromBuffer = async (buffer) => {
  if (!fileTypeModulePromise) {
    fileTypeModulePromise = import('file-type');
  }
  const mod = await fileTypeModulePromise;
  return mod.fileTypeFromBuffer(buffer);
};

const readFileChunk = async (filePath, maxBytes = FILE_TYPE_SNIFF_BYTES) => {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

const buildPublicUrl = (key) => {
  if (R2_PUBLIC_BASE_URL) return `${R2_PUBLIC_BASE_URL}/${key}`;
  return `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;
};

const uploadBufferToR2 = async ({ key, body, contentType }) => {
  if (!r2Client) {
    throw new Error('R2 no esta configurado. Falta endpoint/bucket/keys en .env');
  }

  await r2Client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType
    })
  );

  return buildPublicUrl(key);
};

const uploadFileToR2 = async ({ key, filePath, contentType }) => {
  if (!r2Client) {
    throw new Error('R2 no esta configurado. Falta endpoint/bucket/keys en .env');
  }

  const stat = await fsp.stat(filePath);
  await r2Client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentType: contentType,
      ContentLength: stat.size
    })
  );

  return buildPublicUrl(key);
};

const moderateImageBuffer = async (buffer) => {
  const apiKey = String(process.env.GOOGLE_CLOUD_VISION_API_KEY || '').trim();
  if (!apiKey) {
    return {
      allowed: true,
      skipped: true,
      reason: 'Moderacion automatica no configurada'
    };
  }

  try {
    const body = {
      requests: [{
        image: {
          content: buffer.toString('base64')
        },
        features: [{ type: 'SAFE_SEARCH_DETECTION' }]
      }]
    };
    const response = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );
    if (!response.ok) {
      return {
        allowed: false,
        skipped: false,
        reason: 'No se pudo ejecutar moderacion automatica'
      };
    }
    const payload = await response.json();
    const annotation = payload?.responses?.[0]?.safeSearchAnnotation || {};
    const adult = MODERATION_LEVELS.includes(annotation.adult) ? annotation.adult : 'UNKNOWN';
    const racy = MODERATION_LEVELS.includes(annotation.racy) ? annotation.racy : 'UNKNOWN';

    if (MODERATION_BLOCK_SET.has(adult) || MODERATION_BLOCK_SET.has(racy)) {
      return {
        allowed: false,
        skipped: false,
        reason: `Contenido sensible detectado (adult=${adult}, racy=${racy})`
      };
    }

    return {
      allowed: true,
      skipped: false,
      reason: `safeSearch adult=${adult}, racy=${racy}`
    };
  } catch {
    return {
      allowed: false,
      skipped: false,
      reason: 'Fallo la moderacion automatica'
    };
  }
};

const probeVideo = (inputPath) =>
  new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (error, metadata) => {
      if (error) return reject(error);
      return resolve(metadata);
    });
  });

const buildScaleFilter = ({ maxWidth, maxHeight }) =>
  `scale=w=${maxWidth}:h=${maxHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2`;

const transcodeVideo = (
  inputPath,
  outputPath,
  {
    startSeconds = 0,
    durationSeconds = null,
    includeAudio = true,
    maxWidth = 1080,
    maxHeight = 1920,
    preset = 'veryfast',
    crf = 21,
    maxrate = '4500k',
    bufsize = '9000k',
    audioBitrate = '128k',
    enableFastSeek = false
  } = {}
) =>
  new Promise((resolve, reject) => {
    const command = ffmpeg(inputPath);
    if (Number.isFinite(startSeconds) && startSeconds > 0) {
      if (enableFastSeek) {
        command.inputOptions(['-ss', startSeconds.toFixed(3)]);
      } else {
        command.setStartTime(startSeconds);
      }
    }
    if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
      command.duration(durationSeconds);
    }

    command
      .outputOptions([
        '-movflags +faststart',
        `-threads ${FFMPEG_THREAD_COUNT}`,
        `-preset ${preset}`,
        `-crf ${crf}`,
        `-maxrate ${maxrate}`,
        `-bufsize ${bufsize}`,
        `-vf ${buildScaleFilter({ maxWidth, maxHeight })}`,
        '-pix_fmt yuv420p'
      ])
      .videoCodec('libx264')
      .format('mp4')
      .on('end', resolve)
      .on('error', reject)
    if (includeAudio) {
      command.audioCodec('aac').audioBitrate(audioBitrate);
    } else {
      command.noAudio();
    }
    command.save(outputPath);
  });

const validateVideoUpload = async (file, { allowLongSource = false, maxBytes = VIDEO_MAX_BYTES } = {}) => {
  if (!file?.path || !file?.size) {
    throw new Error('Archivo de video invalido');
  }
  if (file.size > maxBytes) {
    throw new Error(`El video supera el maximo de ${Math.round(maxBytes / (1024 * 1024))}MB`);
  }

  const initialBytes = await readFileChunk(file.path);
  const detectedType = await detectFileTypeFromBuffer(initialBytes);
  const mime = detectedType?.mime || '';
  if (!VIDEO_MIME_TYPES.has(mime)) {
    throw new Error('Formato de video no permitido. Usa MP4, MOV, WEBM, MKV, AVI, WMV o M4V');
  }

  const metadata = await probeVideo(file.path);
  const duration = Number(metadata?.format?.duration || 0);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('No pudimos validar la duracion del video');
  }
  if (!allowLongSource && duration > VIDEO_MAX_DURATION_SECONDS) {
    throw new Error('El video supera la duracion maxima de 20 segundos');
  }

  const videoStream = (metadata?.streams || []).find((stream) => stream.codec_type === 'video');
  if (!videoStream) {
    throw new Error('El archivo no contiene una pista de video valida');
  }

  return {
    duration,
    metadata,
    mime
  };
};

const transcodeVideoLowRes = (
  inputPath,
  outputPath,
  {
    includeAudio = true,
    maxWidth = 720,
    maxHeight = 1280,
    preset = 'veryfast',
    crf = 24,
    maxrate = '1800k',
    bufsize = '3600k',
    audioBitrate = '96k'
  } = {}
) =>
  new Promise((resolve, reject) => {
    const command = ffmpeg(inputPath)
      .outputOptions([
        '-movflags +faststart',
        `-threads ${FFMPEG_THREAD_COUNT}`,
        `-preset ${preset}`,
        `-crf ${crf}`,
        `-maxrate ${maxrate}`,
        `-bufsize ${bufsize}`,
        `-vf ${buildScaleFilter({ maxWidth, maxHeight })}`,
        '-pix_fmt yuv420p'
      ])
      .videoCodec('libx264')
      .format('mp4')
      .on('end', resolve)
      .on('error', reject)
    if (includeAudio) {
      command.audioCodec('aac').audioBitrate(audioBitrate);
    } else {
      command.noAudio();
    }
    command.save(outputPath);
  });

const generateThumbnail = (inputPath, outputPath) =>
  new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .on('end', resolve)
      .on('error', reject)
      .screenshots({
        timestamps: ['00:00:01.000'],
        filename: path.basename(outputPath),
        folder: path.dirname(outputPath),
        size: '720x?'
      });
  });

const processImageUpload = async (file) => {
  if (!file?.buffer) {
    throw new Error('Archivo de imagen invalido');
  }
  if (file.size > IMAGE_MAX_BYTES) {
    throw new Error('La imagen supera el maximo de 5MB');
  }

  const detectedType = await detectFileTypeFromBuffer(file.buffer);
  const mime = detectedType?.mime || '';
  if (!IMAGE_MIME_TYPES.has(mime)) {
    throw new Error('Formato de imagen no permitido. Usa JPG, PNG, WEBP, AVIF, HEIC, HEIF, TIFF o BMP');
  }

  const imageMetadata = await sharp(file.buffer, { failOn: 'error', animated: true }).metadata();
  if (Number(imageMetadata?.pages || 1) > 1) {
    throw new Error('No se permiten GIF ni imagenes animadas para portada');
  }

  const moderation = await moderateImageBuffer(file.buffer);
  if (!moderation.allowed) {
    throw new Error(`Imagen bloqueada por seguridad: ${moderation.reason}`);
  }

  const id = makeId();
  const key = `media/images/${id}.webp`;
  const outputBuffer = await sharp(file.buffer, { failOn: 'error' })
    .rotate()
    .resize({
      width: 1200,
      withoutEnlargement: true
    })
    .webp({ quality: 78 })
    .toBuffer();
  const url = await uploadBufferToR2({
    key,
    body: outputBuffer,
    contentType: 'image/webp'
  });

  return {
    kind: 'image',
    url,
    thumbnail: null,
    bytes: outputBuffer.length,
    mime: 'image/webp',
    moderation
  };
};

const processVideoUpload = async (file) => {
  const { duration } = await validateVideoUpload(file);

  const id = makeId();
  const outputPath = path.join(os.tmpdir(), `eventin-video-${id}.mp4`);
  const lowResOutputPath = path.join(os.tmpdir(), `eventin-video-${id}-360p.mp4`);
  const thumbPath = path.join(os.tmpdir(), `eventin-thumb-${id}.jpg`);
  const videoKey = `media/videos/${id}.mp4`;
  const lowResVideoKey = `media/videos/${id}-360p.mp4`;
  const thumbKey = `media/thumbnails/${id}.jpg`;

  try {
    await transcodeVideo(file.path, outputPath);
    await transcodeVideoLowRes(outputPath, lowResOutputPath);
    await generateThumbnail(outputPath, thumbPath);
    const thumbBuffer = await fsp.readFile(thumbPath);

    const moderation = await moderateImageBuffer(thumbBuffer);
    if (!moderation.allowed) {
      throw new Error(`Video bloqueado por seguridad: ${moderation.reason}`);
    }

    const [videoUrl, lowResUrl, thumbnailUrl, stat] = await Promise.all([
      uploadFileToR2({
        key: videoKey,
        filePath: outputPath,
        contentType: 'video/mp4'
      }),
      uploadFileToR2({
        key: lowResVideoKey,
        filePath: lowResOutputPath,
        contentType: 'video/mp4'
      }),
      uploadBufferToR2({
        key: thumbKey,
        body: thumbBuffer,
        contentType: 'image/jpeg'
      }),
      fsp.stat(outputPath)
    ]);

    return {
      kind: 'video',
      url: videoUrl,
      lowResUrl,
      thumbnail: thumbnailUrl,
      bytes: stat.size,
      mime: 'video/mp4',
      durationSeconds: duration,
      moderation
    };
  } finally {
    await Promise.allSettled([
      cleanupTempFile(outputPath),
      cleanupTempFile(lowResOutputPath),
      cleanupTempFile(thumbPath)
    ]);
  }
};

const processClippedVideoUpload = async (
  file,
  { clipStartSeconds = 0, clipDurationSeconds = CLIPPED_VIDEO_DURATION_SECONDS } = {}
) => {
  const { duration: sourceDuration } = await validateVideoUpload(file, {
    allowLongSource: true,
    maxBytes: VIDEO_MAX_BYTES
  });

  const requestedDuration = Number(clipDurationSeconds);
  const finalDuration =
    Number.isFinite(requestedDuration) && requestedDuration > 0
      ? Math.min(requestedDuration, CLIPPED_VIDEO_DURATION_SECONDS)
      : CLIPPED_VIDEO_DURATION_SECONDS;

  if (sourceDuration < finalDuration) {
    throw new Error(`El video debe durar al menos ${finalDuration} segundos para recortarlo`);
  }

  const maxClipStart = Math.max(0, sourceDuration - finalDuration);
  const requestedStart = Number(clipStartSeconds);
  const finalClipStart = Number.isFinite(requestedStart)
    ? Math.min(Math.max(requestedStart, 0), maxClipStart)
    : 0;

  const id = makeId();
  const outputPath = path.join(os.tmpdir(), `eventin-video-clip-${id}.mp4`);
  const lowResOutputPath = path.join(os.tmpdir(), `eventin-video-clip-${id}-360p.mp4`);
  const thumbPath = path.join(os.tmpdir(), `eventin-thumb-clip-${id}.jpg`);
  const videoKey = `media/videos/${id}.mp4`;
  const lowResVideoKey = `media/videos/${id}-360p.mp4`;
  const thumbKey = `media/thumbnails/${id}.jpg`;

  try {
    await transcodeVideo(file.path, outputPath, {
      startSeconds: finalClipStart,
      durationSeconds: finalDuration,
      includeAudio: false,
      maxWidth: 960,
      maxHeight: 1280,
      crf: 23,
      maxrate: '2200k',
      bufsize: '4400k',
      enableFastSeek: true
    });
    await transcodeVideoLowRes(outputPath, lowResOutputPath, {
      includeAudio: false,
      maxWidth: 540,
      maxHeight: 960,
      crf: 27,
      maxrate: '900k',
      bufsize: '1800k'
    });
    await generateThumbnail(outputPath, thumbPath);
    const thumbBuffer = await fsp.readFile(thumbPath);

    const moderation = await moderateImageBuffer(thumbBuffer);
    if (!moderation.allowed) {
      throw new Error(`Video bloqueado por seguridad: ${moderation.reason}`);
    }

    const [videoUrl, lowResUrl, thumbnailUrl, stat] = await Promise.all([
      uploadFileToR2({
        key: videoKey,
        filePath: outputPath,
        contentType: 'video/mp4'
      }),
      uploadFileToR2({
        key: lowResVideoKey,
        filePath: lowResOutputPath,
        contentType: 'video/mp4'
      }),
      uploadBufferToR2({
        key: thumbKey,
        body: thumbBuffer,
        contentType: 'image/jpeg'
      }),
      fsp.stat(outputPath)
    ]);

    return {
      kind: 'video',
      url: videoUrl,
      lowResUrl,
      thumbnail: thumbnailUrl,
      bytes: stat.size,
      mime: 'video/mp4',
      durationSeconds: finalDuration,
      clipStartSeconds: finalClipStart,
      sourceDurationSeconds: sourceDuration,
      moderation
    };
  } finally {
    await Promise.allSettled([
      cleanupTempFile(outputPath),
      cleanupTempFile(lowResOutputPath),
      cleanupTempFile(thumbPath)
    ]);
  }
};

const cleanupTempFile = async (filePath) => {
  if (!filePath) return;
  try {
    await fsp.unlink(filePath);
  } catch {
    // ignore cleanup errors
  }
};

module.exports = {
  CLIPPED_VIDEO_DURATION_SECONDS,
  IMAGE_MAX_BYTES,
  VIDEO_MAX_BYTES,
  processImageUpload,
  processVideoUpload,
  processClippedVideoUpload,
  cleanupTempFile
};
