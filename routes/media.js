const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fsp = require('fs/promises');
const express = require('express');
const multer = require('multer');
const {
  processImageUpload,
  processVideoUpload,
  processClippedVideoUpload,
  cleanupTempFile,
  VIDEO_MAX_BYTES
} = require('../services/mediaProcessor');

const router = express.Router();

const tempStorage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, os.tmpdir());
  },
  filename: (_req, file, callback) => {
    const id = crypto.randomBytes(10).toString('hex');
    const ext = path.extname(String(file?.originalname || '')) || '.bin';
    callback(null, `eventin-media-${id}${ext.toLowerCase()}`);
  }
});

const upload = multer({
  storage: tempStorage,
  limits: {
    fileSize: VIDEO_MAX_BYTES
  }
});

router.post('/upload', upload.single('file'), async (req, res) => {
  let tempVideoPath = '';
  try {
    const { kind, approvedByOwner, clipStartSeconds, clipDurationSeconds } = req.body || {};
    if (approvedByOwner !== 'true') {
      return res.status(400).json({
        message: 'Debes aprobar manualmente la previsualizacion antes de subir'
      });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'Archivo requerido' });
    }
    if (!kind || !['image', 'video'].includes(kind)) {
      return res.status(400).json({ message: 'Tipo de media invalido' });
    }

    tempVideoPath = req.file.path || '';

    if (kind === 'image') {
      const buffer = await fsp.readFile(tempVideoPath);
      const result = await processImageUpload({
        ...req.file,
        buffer
      });
      return res.status(201).json(result);
    }

    const videoFile = req.file;
    const wantsClip =
      String(clipStartSeconds || '').trim() !== '' || String(clipDurationSeconds || '').trim() !== '';
    const result = wantsClip
      ? await processClippedVideoUpload(videoFile, {
          clipStartSeconds,
          clipDurationSeconds
        })
      : await processVideoUpload(videoFile);
    return res.status(201).json(result);
  } catch (error) {
    return res.status(400).json({
      message: error?.message || 'No pudimos procesar el archivo'
    });
  } finally {
    await cleanupTempFile(tempVideoPath);
  }
});

module.exports = router;
