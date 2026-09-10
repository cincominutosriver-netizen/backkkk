const express = require('express');
const mongoose = require('mongoose');
const Aporte = require('../models/Aporte');
const Contact = require('../models/Contact');
const Event = require('../models/Event');
const Owner = require('../models/Owner');
const { requireOwnerAuth } = require('./auth');

const router = express.Router();

const MAX_REVIEW_NOTE_LENGTH = 500;
const PRICE_MODE_CONFIG = {
  per_hour: {
    amountKey: 'perHour',
    currencyKey: 'perHourCurrency'
  },
  per_day: {
    amountKey: 'perDay',
    currencyKey: 'perDayCurrency'
  },
  per_night: {
    amountKey: 'perNight',
    currencyKey: 'perNightCurrency'
  },
  per_person: {
    amountKey: 'perPerson',
    currencyKey: 'perPersonCurrency'
  }
};
const ALLOWED_FIELDS = new Set([
  'description',
  'type',
  'capacity.max',
  'pricing',
  'location.address',
  'contactInfo.phone',
  'contactInfo.whatsapp',
  'contactInfo.website',
  'media.photos',
  'media.videos'
]);

const normalizeStatus = (value) => String(value || '').trim().toLowerCase();
const normalizeReviewerNote = (value) =>
  String(value || '').trim().slice(0, MAX_REVIEW_NOTE_LENGTH);
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const normalizeUsername = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]+/g, '')
    .slice(0, 24);

const getExpectedReviewToken = () =>
  String(process.env.ADMIN_REVIEW_TOKEN || process.env.CONTRA_VALIDACION || '').trim();

const hasValidReviewToken = (req) => {
  const expected = getExpectedReviewToken();
  if (!expected) return true;
  const provided = String(req.headers['x-review-token'] || '').trim();
  return Boolean(provided) && provided === expected;
};

const ensureReviewAccess = (req, res, next) => {
  const expected = getExpectedReviewToken();
  if (!expected) return next();

  if (!hasValidReviewToken(req)) {
    return res.status(401).json({ message: 'No autorizado para revisar aportes' });
  }
  return next();
};

const parseAmount = (value) => {
  if (value === '' || value === null || typeof value === 'undefined') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeDateValue = (value) => {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const plainDateMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (plainDateMatch) {
    const [, year, month, day] = plainDateMatch;
    return new Date(Number(year), Number(month) - 1, Number(day));
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const normalizePricing = (pricing = {}) => ({
  ...pricing,
  perHour: parseAmount(pricing.perHour),
  perDay: parseAmount(pricing.perDay),
  perNight: parseAmount(pricing.perNight),
  perPerson: parseAmount(pricing.perPerson),
  perHourDate: normalizeDateValue(pricing.perHourDate),
  perDayDate: normalizeDateValue(pricing.perDayDate),
  perNightDate: normalizeDateValue(pricing.perNightDate),
  perPersonDate: normalizeDateValue(pricing.perPersonDate)
});

const buildPriceRange = (pricing = {}) => {
  const config = PRICE_MODE_CONFIG[pricing.mode];
  if (!config) return null;

  const amount = parseAmount(pricing[config.amountKey]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const currency = pricing[config.currencyKey] || 'ARS';
  return {
    min: amount,
    max: amount,
    minARS: currency === 'ARS' ? amount : null,
    maxARS: currency === 'ARS' ? amount : null,
    minUSD: currency === 'USD' ? amount : null,
    maxUSD: currency === 'USD' ? amount : null,
    currency
  };
};

const hasPositiveAmount = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0;
};

const eventHasAnyPriceReference = (event) => {
  const pricing = normalizePricing(event?.pricing || {});
  if ([pricing.perHour, pricing.perDay, pricing.perNight, pricing.perPerson].some(hasPositiveAmount)) {
    return true;
  }

  const priceRange = event?.priceRange || {};
  if (
    [
      priceRange.min,
      priceRange.max,
      priceRange.minARS,
      priceRange.maxARS,
      priceRange.minUSD,
      priceRange.maxUSD
    ].some(hasPositiveAmount)
  ) {
    return true;
  }

  const planItems = Array.isArray(event?.plans?.items) ? event.plans.items : [];
  return Boolean(
    event?.plans?.hasPlans &&
      planItems.some((item) => [item?.price, item?.priceARS, item?.priceUSD].some(hasPositiveAmount))
  );
};

const calculateAwardedPoints = (aporte, event) => {
  if (!aporte || !event) return 0;

  if (aporte.field === 'media.photos') {
    return 10;
  }

  if (aporte.field === 'media.videos') {
    const currentVideos = Array.isArray(event?.media?.videos) ? event.media.videos : [];
    const hasExistingVideos = currentVideos.some((video) => String(video?.url || '').trim());
    return hasExistingVideos ? 20 : 50;
  }

  if (aporte.field === 'pricing') {
    return eventHasAnyPriceReference(event) ? 100 : 200;
  }

  if (['contactInfo.whatsapp', 'contactInfo.website', 'contactInfo.phone'].includes(aporte.field)) {
    return 10;
  }

  return 0;
};

const awardPointsToContributor = async (aporte, awardedPoints) => {
  const ownerId = aporte?.ownerId?._id || aporte?.ownerId;
  if (!ownerId || awardedPoints <= 0) return null;

  const owner =
    aporte?.ownerId?.email
      ? aporte.ownerId
      : await Owner.findById(ownerId).select('email');
  const email = normalizeEmail(owner?.email);
  if (!email) return null;

  return Contact.findOneAndUpdate(
    { email },
    {
      $inc: { points: awardedPoints },
      $set: {
        email,
        isOwner: true
      },
      $setOnInsert: {
        contactPreference: 'email',
        membership: {
          tier: 'basic',
          period: 'year'
        }
      }
    },
    {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true
    }
  );
};

const normalizeContributionPayload = ({ contributionType, field, data }) => {
  if (!ALLOWED_FIELDS.has(field)) {
    throw new Error('Campo de aporte no permitido');
  }

  if (contributionType === 'photo') {
    if (field !== 'media.photos' || !data || typeof data !== 'object' || !String(data.url || '').trim()) {
      throw new Error('Aporte de foto invalido');
    }
    return {
      field,
      contributionType,
      data: {
        url: String(data.url || '').trim(),
        description: String(data.description || '').trim()
      }
    };
  }

  if (contributionType === 'video') {
    if (field !== 'media.videos' || !data || typeof data !== 'object' || !String(data.url || '').trim()) {
      throw new Error('Aporte de video invalido');
    }
    return {
      field,
      contributionType,
      data: {
        url: String(data.url || '').trim(),
        lowResUrl: String(data.lowResUrl || '').trim(),
        thumbnail: String(data.thumbnail || '').trim()
      }
    };
  }

  if (field === 'capacity.max') {
    const amount = parseAmount(data);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error('La capacidad debe ser un numero valido');
    }
    return { field, contributionType: 'text', data: amount };
  }

  if (field === 'pricing') {
    const normalizedPricing = normalizePricing(data || {});
    return { field, contributionType: 'text', data: normalizedPricing };
  }

  return {
    field,
    contributionType: 'text',
    data: typeof data === 'string' ? String(data).trim() : data
  };
};

const buildEventPatchFromAporte = (aporte, event) => {
  const patch = {};

  if (aporte.field === 'media.photos') {
    const currentPhotos = Array.isArray(event?.media?.photos) ? event.media.photos : [];
    patch['media.photos'] = [
      ...currentPhotos,
      {
        url: aporte.data.url,
        description: aporte.data.description || '',
        order: currentPhotos.length
      }
    ];
    return patch;
  }

  if (aporte.field === 'media.videos') {
    const currentVideos = Array.isArray(event?.media?.videos) ? event.media.videos : [];
    patch['media.videos'] = [
      ...currentVideos,
      {
        url: aporte.data.url,
        lowResUrl: aporte.data.lowResUrl || '',
        thumbnail: aporte.data.thumbnail || '',
        order: currentVideos.length
      }
    ];
    return patch;
  }

  if (aporte.field === 'pricing') {
    const pricing = normalizePricing(aporte.data || {});
    patch.pricing = pricing;
    patch.priceRange = buildPriceRange(pricing);
    return patch;
  }

  patch[aporte.field] = aporte.data;
  return patch;
};

router.post('/', async (req, res) => {
  try {
    const eventId = String(req.body?.eventId || '').trim();
    const contributorName = String(req.body?.contributorName || '').trim();
    const contributionType = String(req.body?.contributionType || 'text').trim().toLowerCase();
    const field = String(req.body?.field || '').trim();
    const authHeader = String(req.headers.authorization || '').trim();
    let owner = null;

    if (authHeader.toLowerCase().startsWith('bearer ')) {
      await requireOwnerAuth(req, res, async () => {
        owner = req.owner || null;
      });
      if (res.headersSent) {
        return null;
      }
    }

    if (!mongoose.Types.ObjectId.isValid(eventId)) {
      return res.status(400).json({ message: 'Evento invalido' });
    }

    const ownerUsername = normalizeUsername(owner?.username);
    const finalContributorName = ownerUsername || contributorName;

    if (!finalContributorName) {
      return res.status(400).json({ message: 'Nombre requerido para enviar un aporte' });
    }

    const event = await Event.findById(eventId).select('_id');
    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }

    const normalizedContribution = normalizeContributionPayload({
      contributionType,
      field,
      data: req.body?.data
    });

    const aporte = await Aporte.create({
      eventId,
      contributorName: finalContributorName,
      ...(owner?._id ? { ownerId: owner._id } : {}),
      contributionType: normalizedContribution.contributionType,
      field: normalizedContribution.field,
      data: normalizedContribution.data
    });

    return res.status(201).json({
      ok: true,
      aporte: await Aporte.findById(aporte._id).populate('ownerId', 'username')
    });
  } catch (error) {
    return res.status(400).json({
      message: error?.message || 'No se pudo registrar el aporte'
    });
  }
});

router.get('/event/:eventId', async (req, res) => {
  try {
    const eventId = String(req.params?.eventId || '').trim();
    if (!mongoose.Types.ObjectId.isValid(eventId)) {
      return res.status(400).json({ message: 'Evento invalido' });
    }

    const status = normalizeStatus(req.query?.status || 'pending');
    const query = { eventId };
    if (['pending', 'approved', 'rejected'].includes(status)) {
      query.status = status;
    }

    const aportes = await Aporte.find(query)
      .populate('ownerId', 'username')
      .sort({ likes: -1, createdAt: -1 })
      .limit(20);

    return res.json({
      count: aportes.length,
      aportes
    });
  } catch (error) {
    return res.status(500).json({ message: error?.message || 'No se pudieron listar los aportes del evento' });
  }
});

router.post('/:id/like', requireOwnerAuth, async (req, res) => {
  try {
    const aporte = await Aporte.findOneAndUpdate(
      {
        _id: req.params.id,
        likedByOwners: { $ne: req.owner._id }
      },
      {
        $inc: { likes: 1 },
        $addToSet: { likedByOwners: req.owner._id }
      },
      { new: true, runValidators: true }
    );

    if (!aporte) {
      const existingAporte = await Aporte.findById(req.params.id).populate('ownerId', 'username');
      if (!existingAporte) {
        return res.status(404).json({ message: 'Aporte no encontrado' });
      }
      return res.json({
        ok: true,
        alreadyLiked: true,
        aporte: existingAporte
      });
    }

    const populatedAporte = await Aporte.findById(aporte._id).populate('ownerId', 'username');

    return res.json({
      ok: true,
      aporte: populatedAporte
    });
  } catch (error) {
    return res.status(400).json({ message: error?.message || 'No se pudo registrar el like' });
  }
});

router.get('/review', ensureReviewAccess, async (req, res) => {
  try {
    const status = normalizeStatus(req.query?.status || 'pending');
    const query = {};
    if (['pending', 'approved', 'rejected'].includes(status)) {
      query.status = status;
    }

    const aportes = await Aporte.find(query)
      .populate('eventId', 'name location type')
      .sort({ createdAt: 1 });

    return res.json({
      count: aportes.length,
      aportes
    });
  } catch (error) {
    return res.status(500).json({ message: error?.message || 'No se pudieron listar los aportes' });
  }
});

router.get('/review/:id', ensureReviewAccess, async (req, res) => {
  try {
    const aporte = await Aporte.findById(req.params.id).populate(
      'eventId',
      'name location type capacity pricing contactInfo media'
    );
    if (!aporte) {
      return res.status(404).json({ message: 'Aporte no encontrado' });
    }
    return res.json(aporte);
  } catch (error) {
    return res.status(500).json({ message: error?.message || 'No se pudo cargar el aporte' });
  }
});

router.post('/review/:id/approve', ensureReviewAccess, async (req, res) => {
  try {
    const aporte = await Aporte.findById(req.params.id).populate('ownerId', 'email username');
    if (!aporte) {
      return res.status(404).json({ message: 'Aporte no encontrado' });
    }
    if (aporte.status !== 'pending') {
      return res.status(400).json({ message: 'Solo se pueden aprobar aportes pendientes' });
    }

    const event = await Event.findById(aporte.eventId);
    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }

    const awardedPoints = calculateAwardedPoints(aporte, event);
    const patch = buildEventPatchFromAporte(aporte, event);
    Object.entries(patch).forEach(([key, value]) => {
      event.set(key, value);
    });
    await event.save();

    await awardPointsToContributor(aporte, awardedPoints);

    aporte.status = 'approved';
    aporte.awardedPoints = awardedPoints;
    aporte.pointsAwardedAt = awardedPoints > 0 ? new Date() : undefined;
    aporte.reviewerNote = normalizeReviewerNote(req.body?.note || '');
    aporte.reviewedAt = new Date();
    aporte.reviewedBy = String(req.body?.reviewedBy || 'manual-review').trim();
    await aporte.save();

    return res.json({
      ok: true,
      awardedPoints,
      aporte,
      event
    });
  } catch (error) {
    return res.status(400).json({ message: error?.message || 'No se pudo aprobar el aporte' });
  }
});

router.post('/review/:id/reject', ensureReviewAccess, async (req, res) => {
  try {
    const aporte = await Aporte.findById(req.params.id);
    if (!aporte) {
      return res.status(404).json({ message: 'Aporte no encontrado' });
    }
    if (!['pending', 'rejected'].includes(aporte.status)) {
      return res.status(400).json({ message: 'Solo se pueden rechazar aportes pendientes o rechazados' });
    }

    aporte.status = 'rejected';
    aporte.reviewerNote = normalizeReviewerNote(req.body?.note || '');
    aporte.reviewedAt = new Date();
    aporte.reviewedBy = String(req.body?.reviewedBy || 'manual-review').trim();
    await aporte.save();

    return res.json({
      ok: true,
      aporte
    });
  } catch (error) {
    return res.status(400).json({ message: error?.message || 'No se pudo rechazar el aporte' });
  }
});

module.exports = router;
