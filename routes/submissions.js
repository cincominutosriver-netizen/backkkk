const path = require('path');
const fs = require('fs/promises');
const express = require('express');
const multer = require('multer');
const PendingSubmission = require('../models/PendingSubmission');
const Event = require('../models/Event');
const Contact = require('../models/Contact');
const Owner = require('../models/Owner');
const OwnerSession = require('../models/OwnerSession');
const {
  processImageUpload,
  processVideoUpload
} = require('../services/mediaProcessor');
const { sendTransactionalEmail } = require('../services/transactionalEmail');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024
  }
});

const EVENT_TYPES = new Set([
  'boda',
  'cumpleaÃ±os',
  'cumpleaÃ±os-infantil',
  'empresarial',
  'quinceaÃ±os',
  'despedida',
  'asado',
  'reunion',
  'otro'
]);

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const normalizePublicationName = (value) => String(value || '').trim();
const normalizeStatus = (value) => String(value || '').trim().toLowerCase();
const MAX_REVIEW_NOTE_LENGTH = 500;
const DEFAULT_PUBLICATION_LIMIT = 5;
const PUBLICATION_LIMIT = (() => {
  const parsed = Number.parseInt(process.env.MAX_PUBLICATIONS_PER_OWNER || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PUBLICATION_LIMIT;
})();
const SPAM_ALERT_EMAIL = String(
  process.env.SPAM_ALERT_EMAIL || 'juliansolaririveiro@yahoo.com'
)
  .trim()
  .toLowerCase();
const BLOCKED_OWNER_MESSAGE =
  'Usuario bloqueado preventivamente por spam. Contacta a soporte para continuar.';

const MASTER_SUBMISSION_MODE = 'master-register';
const MASTER_OWNER_EMAIL_DOMAIN = 'eventin.internal';

const getExpectedReviewToken = () =>
  String(process.env.ADMIN_REVIEW_TOKEN || process.env.CONTRA_VALIDACION || '').trim();

const hasValidReviewToken = (req) => {
  const expected = getExpectedReviewToken();
  if (!expected) return true;
  const provided = String(req.headers['x-review-token'] || '').trim();
  return Boolean(provided) && provided === expected;
};

const isMasterSubmissionRequest = (req) =>
  String(req.body?.submissionMode || '').trim() === MASTER_SUBMISSION_MODE && hasValidReviewToken(req);

const buildSyntheticOwnerEmail = (seed = '') => {
  const normalizedSeed = String(seed || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const fallback = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const localPart = normalizedSeed || fallback;
  return `master-${localPart}@${MASTER_OWNER_EMAIL_DOMAIN}`;
};

const isSyntheticMasterOwnerEmail = (email = '') =>
  normalizeEmail(email).endsWith(`@${MASTER_OWNER_EMAIL_DOMAIN}`);

const isMasterDraft = (draft = {}) =>
  String(draft?.submissionMode || '').trim() === MASTER_SUBMISSION_MODE ||
  isSyntheticMasterOwnerEmail(draft?.ownerEmail || '');

const ensureReviewAccess = (req, res, next) => {
  const expected = getExpectedReviewToken();
  if (!expected) return next();

  if (!hasValidReviewToken(req)) {
    return res.status(401).json({ message: 'No autorizado para revisar publicaciones' });
  }
  return next();
};

const buildContactUpsert = (eventDoc) => {
  const ownerEmail = normalizeEmail(eventDoc.ownerEmail || eventDoc?.contactInfo?.email);
  if (!ownerEmail) return null;

  const membershipTier = eventDoc?.membership?.tier || eventDoc.ownerTier || 'basic';
  const membershipPeriod = eventDoc?.membership?.period || 'year';
  return {
    email: ownerEmail,
    doc: {
      name: eventDoc.name,
      email: ownerEmail,
      phone: eventDoc.contactInfo?.phone || '',
      whatsapp: eventDoc.contactInfo?.whatsapp || '',
      website: eventDoc.contactInfo?.website || '',
      contactPreference: eventDoc.preferredContactMethod || 'email',
      membership: {
        tier: membershipTier,
        period: membershipPeriod
      }
    }
  };
};

const sanitizeFilename = (value = '') =>
  String(value)
    .replace(/[^a-zA-Z0-9.\-_]/g, '_')
    .replace(/^_+/, '') || 'file';

const sanitizeReviewerNote = (value = '') =>
  String(value || '').trim().slice(0, MAX_REVIEW_NOTE_LENGTH);

const escapeRegex = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeHtml = (value = '') =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const buildOwnerEmailQuery = (email) => ({
  $or: [{ ownerEmail: email }, { 'contactInfo.email': email }]
});

const normalizeText = (value = '') =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const tokenize = (value = '') =>
  normalizeText(value)
    .split(/\s+/)
    .filter(Boolean);

const getDraftCoordinates = (source = {}) => {
  const coordinates = source?.location?.coordinates?.coordinates || source?.location?.coordinates || [];
  const lng = Number(coordinates?.[0]);
  const lat = Number(coordinates?.[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
};

const getNameSimilarity = (left = '', right = '') => {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let matches = 0;
  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) matches += 1;
  });
  return matches / Math.max(leftTokens.size, rightTokens.size);
};

const getDistanceMeters = (leftCoords, rightCoords) => {
  if (!leftCoords || !rightCoords) return null;
  const toRad = (value) => (value * Math.PI) / 180;
  const earthRadius = 6371000;
  const latDelta = toRad(rightCoords.lat - leftCoords.lat);
  const lngDelta = toRad(rightCoords.lng - leftCoords.lng);
  const lat1 = toRad(leftCoords.lat);
  const lat2 = toRad(rightCoords.lat);

  const a =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(lngDelta / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadius * c;
};

const buildDuplicateCandidates = async (draft = {}, { excludeEventId = null, limit = 5 } = {}) => {
  const draftName = String(draft?.name || '').trim();
  const draftAddress = normalizeText(draft?.location?.address || '');
  const draftCoords = getDraftCoordinates(draft);
  const draftEmail = normalizeEmail(draft?.contactInfo?.email || draft?.ownerEmail || '');
  const draftWhatsapp = String(draft?.contactInfo?.whatsapp || '').replace(/\D/g, '');

  const query = {};
  if (excludeEventId) {
    query._id = { $ne: excludeEventId };
  }

  const events = await Event.find(query)
    .select('name type location capacity contactInfo media moderation featured createdAt')
    .lean();

  const candidates = events
    .map((event) => {
      const reasons = [];
      let score = 0;

      const nameSimilarity = getNameSimilarity(draftName, event?.name || '');
      if (nameSimilarity >= 0.75) {
        score += 4;
        reasons.push(`nombre muy parecido (${Math.round(nameSimilarity * 100)}%)`);
      } else if (nameSimilarity >= 0.45) {
        score += 2;
        reasons.push(`nombre parecido (${Math.round(nameSimilarity * 100)}%)`);
      }

      const eventAddress = normalizeText(event?.location?.address || '');
      if (draftAddress && eventAddress && draftAddress === eventAddress) {
        score += 4;
        reasons.push('misma direccion');
      } else if (draftAddress && eventAddress && (draftAddress.includes(eventAddress) || eventAddress.includes(draftAddress))) {
        score += 2;
        reasons.push('direccion muy similar');
      }

      const distanceMeters = getDistanceMeters(draftCoords, getDraftCoordinates(event));
      if (distanceMeters != null && distanceMeters <= 25) {
        score += 5;
        reasons.push(`coordenadas casi identicas (${Math.round(distanceMeters)} m)`);
      } else if (distanceMeters != null && distanceMeters <= 80) {
        score += 3;
        reasons.push(`muy cerca (${Math.round(distanceMeters)} m)`);
      }

      const eventEmail = normalizeEmail(event?.contactInfo?.email || event?.ownerEmail || '');
      if (draftEmail && eventEmail && draftEmail === eventEmail) {
        score += 2;
        reasons.push('mismo email');
      }

      const eventWhatsapp = String(event?.contactInfo?.whatsapp || '').replace(/\D/g, '');
      if (draftWhatsapp && eventWhatsapp && draftWhatsapp === eventWhatsapp) {
        score += 2;
        reasons.push('mismo whatsapp');
      }

      if (event?.type && draft?.type && String(event.type) === String(draft.type)) {
        score += 1;
      }

      if (score < 3 || reasons.length === 0) return null;

      return {
        eventId: event?._id,
        name: event?.name || 'Espacio',
        type: event?.type || '',
        address: event?.location?.address || '',
        city: event?.location?.city || '',
        province: event?.location?.province || '',
        district: event?.location?.district || '',
        capacityMax: event?.capacity?.max ?? null,
        photoUrl: event?.media?.photos?.[0]?.url || '',
        featured: Boolean(event?.featured),
        moderationStatus: event?.moderation?.status || '',
        createdAt: event?.createdAt || null,
        score,
        reasons,
        distanceMeters: distanceMeters != null ? Math.round(distanceMeters) : null
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return (left.distanceMeters ?? Number.MAX_SAFE_INTEGER) - (right.distanceMeters ?? Number.MAX_SAFE_INTEGER);
    })
    .slice(0, limit);

  return {
    count: candidates.length,
    candidates
  };
};

const findDuplicateEventByOwner = async ({
  ownerEmail,
  name,
  excludeEventId = null
}) => {
  const normalizedOwnerEmail = normalizeEmail(ownerEmail);
  const normalizedName = normalizePublicationName(name);
  if (!normalizedOwnerEmail || !normalizedName) return null;

  const query = {
    ...buildOwnerEmailQuery(normalizedOwnerEmail),
    name: { $regex: `^${escapeRegex(normalizedName)}$`, $options: 'i' }
  };
  if (excludeEventId) query._id = { $ne: excludeEventId };
  return Event.findOne(query).select('_id name');
};

const isOwnerBlocked = async (email) => {
  const ownerEmail = normalizeEmail(email);
  if (!ownerEmail) return false;
  const owner = await Owner.findOne({ email: ownerEmail }).select('moderation');
  return Boolean(owner?.moderation?.isBlocked);
};

const countOwnerPublications = async (email) => {
  const ownerEmail = normalizeEmail(email);
  if (!ownerEmail) {
    return { eventCount: 0, pendingCount: 0, totalPublications: 0 };
  }

  const [eventCount, pendingCount] = await Promise.all([
    Event.countDocuments(buildOwnerEmailQuery(ownerEmail)),
    PendingSubmission.countDocuments({
      status: { $in: ['pending', 'rejected'] },
      $or: [
        { 'eventDraft.ownerEmail': ownerEmail },
        { 'eventDraft.contactInfo.email': ownerEmail }
      ]
    })
  ]);

  return {
    eventCount,
    pendingCount,
    totalPublications: eventCount + pendingCount
  };
};

const maybeSendPublicationLimitAlert = async (email) => {
  const ownerEmail = normalizeEmail(email);
  if (!ownerEmail || !SPAM_ALERT_EMAIL) return null;

  const stats = await countOwnerPublications(ownerEmail);
  if (stats.totalPublications <= PUBLICATION_LIMIT) return stats;

  const owner = await Owner.findOne({ email: ownerEmail }).select('moderation');
  const alreadyAlertedForTotal = Number(owner?.moderation?.spamAlertLastTotal || 0);
  if (alreadyAlertedForTotal >= stats.totalPublications) return stats;

  const subject = `Alerta de spam: ${ownerEmail} supero ${PUBLICATION_LIMIT} publicaciones`;
  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;line-height:1.45;color:#222;">',
    '<h2 style="margin:0 0 12px;">Alerta preventiva de publicaciones</h2>',
    `<p style="margin:0 0 8px;"><strong>Email:</strong> ${escapeHtml(ownerEmail)}</p>`,
    `<p style="margin:0 0 8px;"><strong>Publicadas:</strong> ${stats.eventCount}</p>`,
    `<p style="margin:0 0 8px;"><strong>Pendientes/Rechazadas:</strong> ${stats.pendingCount}</p>`,
    `<p style="margin:0 0 8px;"><strong>Total:</strong> ${stats.totalPublications}</p>`,
    `<p style="margin:0 0 8px;"><strong>Limite:</strong> ${PUBLICATION_LIMIT}</p>`,
    '<p style="margin:12px 0 0;">Puedes bloquear preventivamente al usuario desde /revision.</p>',
    '</div>'
  ].join('');

  let mailResult = { sent: false };
  try {
    mailResult = await sendTransactionalEmail({
      to: SPAM_ALERT_EMAIL,
      subject,
      html,
      text: `Alerta de spam. Email: ${ownerEmail}. Publicadas: ${stats.eventCount}. Pendientes/Rechazadas: ${stats.pendingCount}. Total: ${stats.totalPublications}. Limite: ${PUBLICATION_LIMIT}.`
    });
  } catch {
    mailResult = { sent: false };
  }

  if (!mailResult.sent) return stats;

  await Owner.findOneAndUpdate(
    { email: ownerEmail },
    {
      $set: {
        'moderation.spamAlertLastSentAt': new Date(),
        'moderation.spamAlertLastTotal': stats.totalPublications
      }
    },
    {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true
    }
  );

  return stats;
};

const cleanupSubmissionLocalMedia = async (submission) => {
  const submissionId = submission?._id ? String(submission._id) : '';
  if (!submissionId) return;

  const submissionDir = path.join(__dirname, '..', 'uploads', 'pending', submissionId);
  try {
    await fs.rm(submissionDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors to avoid breaking approval flow
  }
};

const sendRejectionEmail = async ({ to, eventName = 'tu publicacion', reason = '' }) => {
  const email = normalizeEmail(to);
  if (!email) {
    return { attempted: false, sent: false, reason: 'missing-recipient' };
  }

  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  const from = String(process.env.RESEND_FROM_EMAIL || '').trim();
  if (!apiKey || !from) {
    return { attempted: false, sent: false, reason: 'mail-not-configured' };
  }

  const safeEventName = String(eventName || 'tu publicacion').trim() || 'tu publicacion';
  const safeReason = String(reason || '').trim();
  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;line-height:1.45;color:#222;">',
    `<h2 style="margin:0 0 12px;">Revision de publicacion: ${safeEventName}</h2>`,
    '<p style="margin:0 0 8px;">Tu publicacion fue rechazada durante la revision.</p>',
    safeReason
      ? `<p style="margin:0 0 8px;"><strong>Motivo:</strong> ${safeReason}</p>`
      : '<p style="margin:0 0 8px;"><strong>Motivo:</strong> Sin detalle adicional.</p>',
    '<p style="margin:12px 0 0;">Puedes editarla y volver a enviarla a revision.</p>',
    '</div>'
  ].join('');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: `Publicacion rechazada: ${safeEventName}`,
      html
    })
  });

  if (!response.ok) {
    const payload = await response.text().catch(() => '');
    throw new Error(`No se pudo enviar email de rechazo (${response.status}): ${payload || 'sin detalle'}`);
  }

  return { attempted: true, sent: true };
};

router.post(
  '/',
  upload.fields([
    { name: 'photos', maxCount: 100 },
    { name: 'videos', maxCount: 10 }
  ]),
  async (req, res) => {
    try {
      const draftRaw = String(req.body?.eventDraft || '').trim();
      const approvedByOwner = String(req.body?.approvedByOwner || '').trim() === 'true';

      if (!approvedByOwner) {
        return res.status(400).json({
          message: 'Debes aprobar manualmente la previsualizacion antes de enviar a revision'
        });
      }

      if (!draftRaw) {
        return res.status(400).json({ message: 'eventDraft requerido' });
      }

      let eventDraft;
      try {
        eventDraft = JSON.parse(draftRaw);
      } catch {
        return res.status(400).json({ message: 'eventDraft invalido' });
      }

      const isMasterMode = isMasterSubmissionRequest(req);
      let ownerEmail = normalizeEmail(eventDraft?.contactInfo?.email || eventDraft?.ownerEmail);

      if (!ownerEmail && !isMasterMode) {
        return res.status(400).json({ message: 'Email de contacto requerido' });
      }
      if (!ownerEmail && isMasterMode) {
        ownerEmail = buildSyntheticOwnerEmail(`${eventDraft?.name || 'evento'}-${Date.now()}`);
      }

      if (!isSyntheticMasterOwnerEmail(ownerEmail) && (await isOwnerBlocked(ownerEmail))) {
        return res.status(403).json({ message: BLOCKED_OWNER_MESSAGE });
      }
      if (!isSyntheticMasterOwnerEmail(ownerEmail)) {
        const duplicate = await findDuplicateEventByOwner({
          ownerEmail,
          name: eventDraft?.name
        });
        if (duplicate) {
          return res.status(409).json({
            message: 'Ya existe una publicacion con ese nombre para este usuario'
          });
        }
      }

      const pending = await PendingSubmission.create({
        status: 'pending',
        eventDraft: {
          ...eventDraft,
          ownerEmail,
          submissionMode: isMasterMode ? MASTER_SUBMISSION_MODE : ''
        },
        localMedia: { photos: [], videos: [] },
        moderation: { approvedByOwner: true }
      });

      const submissionDir = path.join(
        __dirname,
        '..',
        'uploads',
        'pending',
        String(pending._id)
      );
      await fs.mkdir(submissionDir, { recursive: true });

      const photos = Array.isArray(req.files?.photos) ? req.files.photos : [];
      const videos = Array.isArray(req.files?.videos) ? req.files.videos : [];

      const saveBatch = async (items, kind) => {
        const saved = [];
        for (let index = 0; index < items.length; index += 1) {
          const file = items[index];
          const safeName = sanitizeFilename(file.originalname);
          const finalName = `${kind}-${index + 1}-${Date.now()}-${safeName}`;
          const absPath = path.join(submissionDir, finalName);
          await fs.writeFile(absPath, file.buffer);
          saved.push({
            filename: file.originalname,
            path: absPath,
            publicUrl: `/uploads/pending/${pending._id}/${finalName}`,
            mime: file.mimetype || '',
            bytes: file.size || 0
          });
        }
        return saved;
      };

      const [savedPhotos, savedVideos] = await Promise.all([
        saveBatch(photos, 'photo'),
        saveBatch(videos, 'video')
      ]);

      pending.localMedia = {
        photos: savedPhotos,
        videos: savedVideos
      };
      await pending.save();
      if (!isSyntheticMasterOwnerEmail(ownerEmail)) {
        await maybeSendPublicationLimitAlert(ownerEmail);
      }

      return res.status(201).json({
        id: pending._id,
        status: pending.status,
        message: 'Publicacion enviada a revision correctamente'
      });
    } catch (error) {
      return res.status(400).json({
        message: error?.message || 'No pudimos crear la solicitud de revision'
      });
    }
  }
);

router.get('/', ensureReviewAccess, async (req, res) => {
  try {
    const status = normalizeStatus(req.query?.status || 'pending');
    const query = {};
    if (['pending', 'approved', 'rejected'].includes(status)) {
      query.status = status;
    }

    const submissions = await PendingSubmission.find(query).sort({ createdAt: 1 });
    return res.json({ count: submissions.length, submissions });
  } catch (error) {
    return res.status(500).json({ message: error?.message || 'No pudimos listar revisiones' });
  }
});

router.get('/users', ensureReviewAccess, async (req, res) => {
  try {
    const thresholdParsed = Number.parseInt(String(req.query?.threshold || ''), 10);
    const threshold =
      Number.isFinite(thresholdParsed) && thresholdParsed > 0
        ? thresholdParsed
        : PUBLICATION_LIMIT;

    const [events, submissions, owners] = await Promise.all([
      Event.find({}).select('ownerEmail contactInfo.email').lean(),
      PendingSubmission.find({
        status: { $in: ['pending', 'rejected'] }
      })
        .select('eventDraft.ownerEmail eventDraft.contactInfo.email')
        .lean(),
      Owner.find({})
        .select(
          'email moderation.isBlocked moderation.blockedAt moderation.blockedBy moderation.blockedReason moderation.spamAlertLastSentAt moderation.spamAlertLastTotal'
        )
        .lean()
    ]);

    const map = new Map();
    const getOrCreate = (email) => {
      const normalized = normalizeEmail(email);
      if (!normalized) return null;
      if (!map.has(normalized)) {
        map.set(normalized, {
          email: normalized,
          eventCount: 0,
          pendingCount: 0,
          totalPublications: 0,
          isBlocked: false,
          blockedAt: null,
          blockedBy: '',
          blockedReason: '',
          spamAlertLastSentAt: null,
          spamAlertLastTotal: 0
        });
      }
      return map.get(normalized);
    };

    events.forEach((event) => {
      const ownerEmail = normalizeEmail(event?.ownerEmail || event?.contactInfo?.email);
      const row = getOrCreate(ownerEmail);
      if (!row) return;
      row.eventCount += 1;
    });

    submissions.forEach((submission) => {
      const email = normalizeEmail(
        submission?.eventDraft?.ownerEmail || submission?.eventDraft?.contactInfo?.email
      );
      const row = getOrCreate(email);
      if (!row) return;
      row.pendingCount += 1;
    });

    owners.forEach((owner) => {
      const row = getOrCreate(owner?.email);
      if (!row) return;
      row.isBlocked = Boolean(owner?.moderation?.isBlocked);
      row.blockedAt = owner?.moderation?.blockedAt || null;
      row.blockedBy = String(owner?.moderation?.blockedBy || '');
      row.blockedReason = String(owner?.moderation?.blockedReason || '');
      row.spamAlertLastSentAt = owner?.moderation?.spamAlertLastSentAt || null;
      row.spamAlertLastTotal = Number(owner?.moderation?.spamAlertLastTotal || 0);
    });

    const users = Array.from(map.values())
      .map((row) => {
        const totalPublications = row.eventCount + row.pendingCount;
        return {
          ...row,
          totalPublications,
          hasExceededLimit: totalPublications > threshold
        };
      })
      .sort((a, b) => {
        if (b.totalPublications !== a.totalPublications) {
          return b.totalPublications - a.totalPublications;
        }
        return a.email.localeCompare(b.email);
      });

    return res.json({
      count: users.length,
      threshold,
      users
    });
  } catch (error) {
    return res.status(500).json({ message: error?.message || 'No pudimos listar usuarios' });
  }
});

router.put('/users/:email/block', ensureReviewAccess, async (req, res) => {
  try {
    const email = normalizeEmail(decodeURIComponent(String(req.params.email || '')));
    if (!email) {
      return res.status(400).json({ message: 'Email requerido' });
    }

    const rawBlocked = String(req.body?.blocked ?? 'true').trim().toLowerCase();
    const blocked = !(rawBlocked === 'false' || rawBlocked === '0' || rawBlocked === 'no');
    const reason = sanitizeReviewerNote(req.body?.reason || '');
    const actor = normalizeEmail(req.body?.blockedBy || req.body?.reviewer || 'revision-panel');

    let owner;
    if (blocked) {
      owner = await Owner.findOneAndUpdate(
        { email },
        {
          $set: {
            'moderation.isBlocked': true,
            'moderation.blockedAt': new Date(),
            'moderation.blockedBy': actor || 'revision-panel',
            'moderation.blockedReason': reason || 'Bloqueo preventivo por spam'
          }
        },
        {
          upsert: true,
          new: true,
          runValidators: true,
          setDefaultsOnInsert: true
        }
      );
      if (owner?._id) {
        await OwnerSession.deleteMany({ ownerId: owner._id });
      }
    } else {
      owner = await Owner.findOneAndUpdate(
        { email },
        {
          $set: { 'moderation.isBlocked': false },
          $unset: {
            'moderation.blockedAt': 1,
            'moderation.blockedBy': 1,
            'moderation.blockedReason': 1
          }
        },
        {
          upsert: true,
          new: true,
          runValidators: true,
          setDefaultsOnInsert: true
        }
      );
    }

    return res.json({
      ok: true,
      owner: {
        email: owner.email,
        moderation: {
          isBlocked: Boolean(owner?.moderation?.isBlocked),
          blockedAt: owner?.moderation?.blockedAt || null,
          blockedBy: owner?.moderation?.blockedBy || '',
          blockedReason: owner?.moderation?.blockedReason || ''
        }
      }
    });
  } catch (error) {
    return res.status(400).json({ message: error?.message || 'No pudimos actualizar el bloqueo' });
  }
});

router.get('/:id', ensureReviewAccess, async (req, res) => {
  try {
    const submission = await PendingSubmission.findById(req.params.id).lean();
    if (!submission) {
      return res.status(404).json({ message: 'Solicitud no encontrada' });
    }
    const duplicateCandidates = await buildDuplicateCandidates(submission.eventDraft || {});
    return res.json({
      ...submission,
      duplicateCandidates
    });
  } catch (error) {
    return res.status(500).json({ message: error?.message || 'No pudimos obtener la solicitud' });
  }
});

router.put('/:id', ensureReviewAccess, async (req, res) => {
  try {
    const submission = await PendingSubmission.findById(req.params.id);
    if (!submission) {
      return res.status(404).json({ message: 'Solicitud no encontrada' });
    }

    if (!['pending', 'rejected'].includes(submission.status)) {
      return res.status(400).json({ message: 'Solo se pueden editar solicitudes pendientes o rechazadas' });
    }

    const incomingDraft = req.body?.eventDraft;
    if (!incomingDraft || typeof incomingDraft !== 'object' || Array.isArray(incomingDraft)) {
      return res.status(400).json({ message: 'eventDraft invalido' });
    }

    const currentDraft = submission.eventDraft || {};
    const isMasterMode = isMasterDraft(incomingDraft) || isMasterDraft(currentDraft);
    let ownerEmail = normalizeEmail(
      incomingDraft?.ownerEmail || incomingDraft?.contactInfo?.email || currentDraft?.ownerEmail
    );

    if (!ownerEmail && !isMasterMode) {
      return res.status(400).json({ message: 'Email de contacto requerido' });
    }

    if (!ownerEmail && isMasterMode) {
      ownerEmail = buildSyntheticOwnerEmail(`${incomingDraft?.name || currentDraft?.name || 'evento'}-${Date.now()}`);
    }

    if (!isSyntheticMasterOwnerEmail(ownerEmail)) {
      const duplicate = await findDuplicateEventByOwner({
        ownerEmail,
        name: incomingDraft?.name
      });
      if (duplicate) {
        return res.status(409).json({
          message: 'Ya existe una publicacion con ese nombre para este usuario'
        });
      }
    }

    const providedContactEmail = normalizeEmail(incomingDraft?.contactInfo?.email);
    submission.eventDraft = {
      ...currentDraft,
      ...incomingDraft,
      ownerEmail,
      submissionMode: isMasterMode ? MASTER_SUBMISSION_MODE : String(incomingDraft?.submissionMode || '').trim(),
      contactInfo: {
        ...(currentDraft.contactInfo || {}),
        ...(incomingDraft.contactInfo || {}),
        email:
          isSyntheticMasterOwnerEmail(ownerEmail) && !providedContactEmail
            ? ''
            : ownerEmail
      }
    };

    await submission.save();
    return res.json({ ok: true, submission });
  } catch (error) {
    return res.status(400).json({ message: error?.message || 'No pudimos actualizar la solicitud' });
  }
});

router.post('/:id/reject', ensureReviewAccess, async (req, res) => {
  try {
    const submission = await PendingSubmission.findById(req.params.id);
    if (!submission) {
      return res.status(404).json({ message: 'Solicitud no encontrada' });
    }

    if (!['pending', 'rejected'].includes(submission.status)) {
      return res.status(400).json({ message: 'Solo se pueden rechazar o actualizar solicitudes rechazadas' });
    }

    const reviewerNote = sanitizeReviewerNote(req.body?.note || '');
    if (!reviewerNote) {
      return res.status(400).json({ message: 'Debes indicar un motivo de rechazo' });
    }

    const draft = submission.eventDraft || {};
    const ownerEmail = normalizeEmail(draft?.ownerEmail || draft?.contactInfo?.email);
    const eventName = String(draft?.name || 'tu publicacion').trim();

    submission.status = 'rejected';
    submission.reviewerNote = reviewerNote;
    submission.reviewedAt = new Date();
    await submission.save();

    let notification = { attempted: false, sent: false, reason: 'missing-recipient' };
    if (ownerEmail) {
      try {
        notification = await sendRejectionEmail({
          to: ownerEmail,
          eventName,
          reason: reviewerNote
        });
      } catch (mailError) {
        notification = {
          attempted: true,
          sent: false,
          reason: mailError?.message || 'mail-error'
        };
      }
    }

    return res.json({ ok: true, submission, notification });
  } catch (error) {
    return res.status(400).json({ message: error?.message || 'No pudimos rechazar la solicitud' });
  }
});

router.post('/:id/approve', ensureReviewAccess, async (req, res) => {
  try {
    const submission = await PendingSubmission.findById(req.params.id);
    if (!submission) {
      return res.status(404).json({ message: 'Solicitud no encontrada' });
    }
    if (submission.status !== 'pending') {
      return res.status(400).json({ message: 'Solo se pueden aprobar solicitudes pendientes' });
    }

    const draft = submission.eventDraft || {};
    const ownerEmail = normalizeEmail(draft?.ownerEmail || draft?.contactInfo?.email);
    const isMasterMode = String(draft?.submissionMode || '').trim() === MASTER_SUBMISSION_MODE;
    if (!ownerEmail) {
      return res.status(400).json({ message: 'La solicitud no tiene email de contacto valido' });
    }
    if (!isSyntheticMasterOwnerEmail(ownerEmail) && (await isOwnerBlocked(ownerEmail))) {
      return res.status(403).json({ message: BLOCKED_OWNER_MESSAGE });
    }
    if (!isSyntheticMasterOwnerEmail(ownerEmail)) {
      const duplicate = await findDuplicateEventByOwner({
        ownerEmail,
        name: draft?.name
      });
      if (duplicate) {
        return res.status(409).json({
          message: 'Ya existe una publicacion con ese nombre para este usuario'
        });
      }
    }

    const uploadedPhotos = [];
    for (const item of submission.localMedia?.photos || []) {
      const buffer = await fs.readFile(item.path);
      const result = await processImageUpload({
        buffer,
        size: item.bytes || buffer.length,
        mimetype: item.mime || ''
      });
      uploadedPhotos.push({ url: result.url });
    }

    const uploadedVideos = [];
    for (const item of submission.localMedia?.videos || []) {
      const result = await processVideoUpload({
        path: item.path,
        size: item.bytes || 0,
        mimetype: item.mime || ''
      });
      uploadedVideos.push({
        url: result.url,
        lowResUrl: result.lowResUrl || '',
        thumbnail: result.thumbnail || ''
      });
    }

    const draftPhotoLinks = Array.isArray(draft?.media?.photoLinks)
      ? draft.media.photoLinks.filter((url) => String(url || '').trim() !== '')
      : [];
    const draftUploadedVideos = Array.isArray(draft?.media?.videos)
      ? draft.media.videos
          .filter((item) => String(item?.url || '').trim() !== '')
          .map((item) => ({
            url: String(item.url || '').trim(),
            lowResUrl: String(item.lowResUrl || '').trim(),
            thumbnail: String(item.thumbnail || '').trim()
          }))
      : [];
    const draftVideoLinks = Array.isArray(draft?.media?.videoLinks)
      ? draft.media.videoLinks.filter((url) => String(url || '').trim() !== '')
      : [];

    let eventType = String(draft?.eventType || '').trim();
    if (!eventType) {
      const firstPartyType = Array.isArray(draft?.partyTypes)
        ? draft.partyTypes.find((item) => typeof item === 'string' && item.trim())
        : null;
      eventType = firstPartyType || 'otro';
    }
    if (!EVENT_TYPES.has(eventType)) {
      eventType = 'otro';
    }

    const finalEventPayload = {
      ...draft,
      ownerEmail,
      eventType,
      contactInfo: {
        ...(draft.contactInfo || {}),
        email: isSyntheticMasterOwnerEmail(ownerEmail)
          ? normalizeEmail(draft?.contactInfo?.email || '')
          : ownerEmail
      },
      moderation: {
        status: 'approved',
        reviewedAt: new Date(),
        reviewedBy: 'manual-review'
      },
      media: {
        photos: [
          ...uploadedPhotos.map((item, index) => ({
            url: item.url,
            order: index
          })),
          ...draftPhotoLinks.map((url, index) => ({
            url,
            order: uploadedPhotos.length + index
          }))
        ],
        videos: [
          ...uploadedVideos.map((item, index) => ({
            url: item.url,
            lowResUrl: item.lowResUrl || '',
            thumbnail: item.thumbnail || '',
            order: index
          })),
          ...draftUploadedVideos.map((item, index) => ({
            url: item.url,
            lowResUrl: item.lowResUrl || '',
            thumbnail: item.thumbnail || '',
            order: uploadedVideos.length + index
          })),
          ...draftVideoLinks.map((url, index) => ({
            url,
            order: uploadedVideos.length + draftUploadedVideos.length + index
          }))
        ]
      }
    };

    const event = await Event.create(finalEventPayload);

    const contactUpsert =
      isSyntheticMasterOwnerEmail(ownerEmail) && !normalizeEmail(draft?.contactInfo?.email || '')
        ? null
        : buildContactUpsert(event);
    if (contactUpsert) {
      await Contact.findOneAndUpdate(
        { email: contactUpsert.email },
        {
          $set: contactUpsert.doc,
          $addToSet: { events: event._id }
        },
        {
          upsert: true,
          new: true,
          runValidators: true,
          setDefaultsOnInsert: true
        }
      );
    }

    submission.status = 'approved';
    submission.reviewerNote = String(req.body?.note || '').trim();
    submission.reviewedAt = new Date();
    submission.createdEventId = event._id;
    submission.localMedia = { photos: [], videos: [] };
    await submission.save();
    await cleanupSubmissionLocalMedia(submission);
    if (!isSyntheticMasterOwnerEmail(ownerEmail)) {
      await maybeSendPublicationLimitAlert(ownerEmail);
    }

    return res.json({
      ok: true,
      eventId: event._id,
      submission
    });
  } catch (error) {
    return res.status(400).json({ message: error?.message || 'No pudimos aprobar la solicitud' });
  }
});

module.exports = router;
