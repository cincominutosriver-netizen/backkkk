const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Event = require('../models/Event');
const { buildLocationQuery } = require('../utils/locationSearch');
const Contact = require('../models/Contact');
const Owner = require('../models/Owner');
const OwnerClaim = require('../models/OwnerClaim');
const EventReview = require('../models/EventReview');
const { requireOwnerAuth, requireAdminAuth } = require('./auth');
const { sendTransactionalEmail } = require('../services/transactionalEmail');
const {
  buildEventPathCandidates,
  getPublicPathFields,
  normalizePublicPath
} = require('../utils/eventPublicPath');

const DEFAULT_RELATED_LIMIT = 6;
const MAX_RELATED_LIMIT = 12;
const DEFAULT_MOMENTS_LIMIT = 18;
const MAX_MOMENTS_LIMIT = 60;
const MAX_REVIEW_COMMENT_LENGTH = 1000;
const EVENT_TYPES = new Set([
  'boda',
  'cumpleaños',
  'cumpleaños-infantil',
  'empresarial',
  'quinceaños',
  'despedida',
  'asado',
  'reunion',
  'otro'
]);
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
const getExpectedReviewToken = () =>
  String(process.env.ADMIN_REVIEW_TOKEN || process.env.CONTRA_VALIDACION || '').trim();

const parseLimit = (value) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RELATED_LIMIT;
  return Math.min(parsed, MAX_RELATED_LIMIT);
};

const parseMomentsLimit = (value) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MOMENTS_LIMIT;
  return Math.min(parsed, MAX_MOMENTS_LIMIT);
};

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const normalizePublicationName = (value) => String(value || '').trim();
const escapeRegex = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalizeUsername = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]+/g, '')
    .slice(0, 24);

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

const parseReviewRating = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
    throw new Error('Las calificaciones deben ser numeros enteros del 1 al 5');
  }
  return parsed;
};

const normalizeReviewPayload = (body = {}) => {
  const ratings = body.ratings || {};
  const normalizedRatings = {
    gastronomy: parseReviewRating(ratings.gastronomy),
    ambience: parseReviewRating(ratings.ambience),
    staff: parseReviewRating(ratings.staff)
  };
  const overallRating =
    (normalizedRatings.gastronomy + normalizedRatings.ambience + normalizedRatings.staff) / 3;

  return {
    ratings: normalizedRatings,
    overallRating: Number(overallRating.toFixed(2)),
    comment: String(body.comment || '').trim().slice(0, MAX_REVIEW_COMMENT_LENGTH)
  };
};

const buildReviewAuthorLabel = (owner = {}) => {
  const username = normalizeUsername(owner?.username);
  if (username) return username;

  const email = normalizeEmail(owner?.email);
  if (email && email.includes('@')) return email.split('@')[0].slice(0, 40);
  return 'usuario';
};

const awardReviewPointsToOwner = async (owner, awardedPoints) => {
  const email = normalizeEmail(owner?.email);
  if (!email || awardedPoints <= 0) return null;

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

const roundRating = (value) => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Number(numericValue.toFixed(1)) : 0;
};

const buildReviewStats = async (eventId) => {
  const [stats] = await EventReview.aggregate([
    { $match: { eventId: new mongoose.Types.ObjectId(eventId) } },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        gastronomy: { $avg: '$ratings.gastronomy' },
        ambience: { $avg: '$ratings.ambience' },
        staff: { $avg: '$ratings.staff' },
        overall: { $avg: '$overallRating' }
      }
    }
  ]);

  return {
    count: Number(stats?.count || 0),
    average: roundRating(stats?.overall),
    categories: {
      gastronomy: roundRating(stats?.gastronomy),
      ambience: roundRating(stats?.ambience),
      staff: roundRating(stats?.staff)
    }
  };
};

const serializeReview = (review = {}) => {
  const ownerUsername = review?.ownerId && typeof review.ownerId === 'object'
    ? normalizeUsername(review.ownerId.username)
    : '';

  return {
    _id: review._id,
    eventId: review.eventId,
    contributorName: ownerUsername || review.contributorName || 'usuario',
    ratings: review.ratings || {},
    overallRating: review.overallRating,
    comment: review.comment || '',
    awardedPoints: review.awardedPoints || 0,
    createdAt: review.createdAt
  };
};

const buildContactUpsertPayload = (eventDoc, email) => {
  const ownerEmail = normalizeEmail(email || eventDoc?.ownerEmail || eventDoc?.contactInfo?.email);
  if (!ownerEmail) return null;

  const membershipTier = eventDoc?.membership?.tier || eventDoc?.ownerTier || 'basic';
  const membershipPeriod = eventDoc?.membership?.period || 'year';

  return {
    name: eventDoc?.name || '',
    email: ownerEmail,
    phone: eventDoc?.contactInfo?.phone || '',
    whatsapp: eventDoc?.contactInfo?.whatsapp || '',
    website: eventDoc?.contactInfo?.website || '',
    contactPreference: eventDoc?.preferredContactMethod || 'email',
    membership: {
      tier: membershipTier,
      period: membershipPeriod
    }
  };
};

const hasValidReviewToken = (req) => {
  const expected = getExpectedReviewToken();
  if (!expected) return true;
  const provided = String(req.headers['x-review-token'] || '').trim();
  return Boolean(provided) && provided === expected;
};

const requireReviewAccess = (req, res, next) => {
  const expected = getExpectedReviewToken();
  if (!expected) return next();
  if (!hasValidReviewToken(req)) {
    return res.status(401).json({ message: 'No autorizado para editar desde maestro' });
  }
  return next();
};

const findDuplicateEventByOwner = async ({ ownerEmail, name, excludeEventId = null }) => {
  const normalizedOwnerEmail = normalizeEmail(ownerEmail);
  const normalizedName = normalizePublicationName(name);
  if (!normalizedOwnerEmail || !normalizedName) return null;

  const query = {
    ...buildOwnerEmailQuery(normalizedOwnerEmail),
    name: { $regex: `^${escapeRegex(normalizedName)}$`, $options: 'i' }
  };
  if (excludeEventId) {
    query._id = { $ne: excludeEventId };
  }
  return Event.findOne(query).select('_id name');
};

const isOwnerBlocked = async (ownerEmail) => {
  const normalizedOwnerEmail = normalizeEmail(ownerEmail);
  if (!normalizedOwnerEmail) return false;
  const owner = await Owner.findOne({ email: normalizedOwnerEmail }).select('moderation');
  return Boolean(owner?.moderation?.isBlocked);
};

const maybeSendPublicationLimitAlert = async (ownerEmail) => {
  const normalizedOwnerEmail = normalizeEmail(ownerEmail);
  if (!normalizedOwnerEmail || !SPAM_ALERT_EMAIL) return;

  const total = await Event.countDocuments(buildOwnerEmailQuery(normalizedOwnerEmail));
  if (total <= PUBLICATION_LIMIT) return;

  const owner = await Owner.findOne({ email: normalizedOwnerEmail }).select(
    'email moderation.spamAlertLastTotal moderation.spamAlertLastSentAt'
  );
  const alreadyAlertedForTotal = Number(owner?.moderation?.spamAlertLastTotal || 0);
  if (alreadyAlertedForTotal >= total) return;

  const subject = `Alerta de spam: ${normalizedOwnerEmail} supero ${PUBLICATION_LIMIT} publicaciones`;
  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;line-height:1.45;color:#222;">',
    '<h2 style="margin:0 0 12px;">Alerta preventiva de publicaciones</h2>',
    `<p style="margin:0 0 8px;"><strong>Email:</strong> ${escapeHtml(normalizedOwnerEmail)}</p>`,
    `<p style="margin:0 0 8px;"><strong>Total detectado:</strong> ${total}</p>`,
    `<p style="margin:0 0 8px;"><strong>Limite configurado:</strong> ${PUBLICATION_LIMIT}</p>`,
    '<p style="margin:12px 0 0;">Revisa /revision para bloquear al usuario si corresponde.</p>',
    '</div>'
  ].join('');

  let mailResult = { sent: false };
  try {
    mailResult = await sendTransactionalEmail({
      to: SPAM_ALERT_EMAIL,
      subject,
      html,
      text: `Alerta de spam. Email: ${normalizedOwnerEmail}. Total: ${total}. Limite: ${PUBLICATION_LIMIT}.`
    });
  } catch {
    mailResult = { sent: false };
  }

  if (!mailResult.sent) return;

  await Owner.findOneAndUpdate(
    { email: normalizedOwnerEmail },
    {
      $set: {
        'moderation.spamAlertLastSentAt': new Date(),
        'moderation.spamAlertLastTotal': total
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

const APPROVED_QUERY = {
  $or: [
    { 'moderation.status': 'approved' },
    { moderation: { $exists: false } },
    { 'moderation.status': { $exists: false } }
  ]
};
const PUBLIC_EVENT_LITE_SELECT = [
  '_id',
  'name',
  'slug',
  'publicPath',
  'type',
  'eventType',
  'partyTypes',
  'ownerTier',
  'featured',
  'updatedAt',
  'capacity.max',
  'location.province',
  'location.city',
  'location.district',
  'location.coordinates'
].join(' ');
const PUBLIC_EVENT_PAGE_SELECT = [
  '_id',
  'name',
  'slug',
  'publicPath',
  'publicPathCandidates',
  'type',
  'eventType',
  'partyTypes',
  'ownerTier',
  'featured',
  'createdAt',
  'updatedAt',
  'capacity',
  'priceRange',
  'pricing',
  'plans',
  'location',
  'geoClassification',
  'media',
  'description',
  'contactInfo',
  'preferredContactMethod'
].join(' ');
const PUBLIC_EVENT_PATH_LOOKUP_SELECT = [
  '_id',
  'name',
  'slug',
  'publicPath',
  'publicPathCandidates',
  'location.province',
  'location.city',
  'location.district'
].join(' ');
const PUBLIC_EVENT_SITEMAP_SELECT = [
  '_id',
  'name',
  'slug',
  'publicPath',
  'type',
  'eventType',
  'partyTypes',
  'ownerTier',
  'featured',
  'updatedAt',
  'capacity.max',
  'location.province',
  'location.city',
  'location.district',
  'location.coordinates',
  'geoClassification',
  'media.photos'
].join(' ');
const SEO_AREA_SELECT = [
  'type',
  'eventType',
  'partyTypes',
  'geoClassification',
  'updatedAt'
].join(' ');

const normalizePublicEventLite = (event = {}) => ({
  ...event,
  media: {
    ...(event.media || {}),
    photos: Array.isArray(event?.media?.photos) ? event.media.photos.slice(0, 1) : []
  }
});

const normalizePublicEventSitemap = (event = {}) => ({
  ...event,
  media: {
    ...(event.media || {}),
    photos: Array.isArray(event?.media?.photos) ? event.media.photos.slice(0, 1) : []
  }
});

const normalizeSeoAreaDocument = (value = {}) => {
  const area = value?.seoArea || value?.area || value;
  const key = String(area?.key || area?.seoAreaKey || value?.key || value?.seoAreaKey || '').trim();
  if (!key) return null;

  return {
    ...area,
    key,
    indexable: area?.indexable !== false,
    eventCount: Number(area?.eventCount || value?.eventCount || 0),
    categoryCounts: area?.categoryCounts || value?.categoryCounts || {},
    updatedAt: area?.updatedAt || value?.updatedAt
  };
};

const getSeoAreaCategoryKeysForEvent = (event = {}) => {
  const parts = [
    event.type,
    event.eventType,
    ...(Array.isArray(event.partyTypes) ? event.partyTypes : [])
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const keys = new Set(['salonesDeFiestas']);
  if (parts.includes('quinta')) keys.add('quintasParaEventos');
  if (parts.includes('infantil') || parts.includes('nino') || parts.includes('chico')) {
    keys.add('salonesInfantiles');
  }
  if (parts.includes('cumple')) keys.add('lugaresParaCumpleanos');
  if (parts.includes('boda') || parts.includes('casamiento')) keys.add('lugaresParaCasamientos');
  return keys;
};

const buildSeoAreasFromEvents = (events = []) => {
  const areasByKey = new Map();

  events.forEach((event) => {
    const area = normalizeSeoAreaDocument(event.geoClassification || {});
    if (!area) return;

    const current = areasByKey.get(area.key) || {
      ...area,
      eventCount: 0,
      categoryCounts: {},
      updatedAt: area.updatedAt || event.updatedAt
    };

    current.eventCount += 1;
    getSeoAreaCategoryKeysForEvent(event).forEach((categoryKey) => {
      current.categoryCounts[categoryKey] = Number(current.categoryCounts[categoryKey] || 0) + 1;
    });

    const currentUpdatedAt = current.updatedAt ? new Date(current.updatedAt).getTime() : 0;
    const eventUpdatedAt = event.updatedAt ? new Date(event.updatedAt).getTime() : 0;
    if (eventUpdatedAt > currentUpdatedAt) {
      current.updatedAt = event.updatedAt;
    }

    areasByKey.set(area.key, current);
  });

  return Array.from(areasByKey.values());
};

const setCacheHeaders = (res, maxAge = 86400) => {
  res.set('Cache-Control', `public, s-maxage=${maxAge}, stale-while-revalidate=${maxAge}`);
};

const setNoStoreHeaders = (res) => {
  res.set('Cache-Control', 'no-store');
};

// GET - Búsqueda y filtros (DEBE IR PRIMERO)
router.get('/search', async (req, res) => {
  try {
    const { 
      type, 
      q,
      province, 
      city, 
      minCapacity, 
      maxCapacity,
      minPrice, 
      maxPrice,
      featured 
    } = req.query;
    
    let query = { ...APPROVED_QUERY };
    
    if (type) {
      const types = String(type)
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);

      if (types.length === 1) {
        query.type = types[0];
      } else if (types.length > 1) {
        query.type = { $in: types };
      }
    }
    Object.assign(query, buildLocationQuery({ city, province }));
    if (q) {
      const keyword = String(q).trim();
      if (keyword) {
        const safeKeyword = escapeRegex(keyword);
        query.$or = [
          { name: new RegExp(safeKeyword, 'i') },
          { 'location.address': new RegExp(safeKeyword, 'i') },
          { 'location.city': new RegExp(safeKeyword, 'i') },
          { 'location.province': new RegExp(safeKeyword, 'i') },
          { type: new RegExp(safeKeyword, 'i') }
        ];
      }
    }
    
    if (minCapacity || maxCapacity) {
      query['capacity.max'] = {};
      if (minCapacity) query['capacity.max'].$gte = parseInt(minCapacity);
      if (maxCapacity) query['capacity.max'].$lte = parseInt(maxCapacity);
    }
    
    if (minPrice || maxPrice) {
      query['priceRange.min'] = {};
      if (minPrice) query['priceRange.min'].$gte = parseInt(minPrice);
      if (maxPrice) query['priceRange.min'].$lte = parseInt(maxPrice);
    }
    
    if (featured === 'true') query.featured = true;
    
    const events = await Event.find(query).sort({ featured: -1, createdAt: -1 });
    res.json({
      count: events.length,
      events
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET - Obtener eventos destacados
router.get('/featured', async (req, res) => {
  try {
    const events = await Event.find({ featured: true, ...APPROVED_QUERY }).limit(6);
    res.json(events);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET - Obtener eventos destacados cercanos
router.get('/featured-near', async (req, res) => {
  try {
    const { lat, lng, radius = 20000, limit = 6 } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ message: 'lat y lng son requeridos' });
    }

    const events = await Event.find({
      featured: true,
      isActive: true,
      ...APPROVED_QUERY,
      'location.coordinates': {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [Number(lng), Number(lat)]
          },
          $maxDistance: Number(radius)
        }
      }
    }).limit(Number(limit));

    res.json(events);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET - Obtener eventos del dueÃ±o logueado
// GET - Obtener videos para la seccion Momentos (payload reducido)
router.get('/moments', async (req, res) => {
  try {
    const limit = parseMomentsLimit(req.query.limit);
    const events = await Event.find({
      ...APPROVED_QUERY,
      'media.videos.0': { $exists: true }
    })
      .select('_id name type eventType placeType category location.city location.province media.videos featured createdAt')
      .sort({ featured: -1, createdAt: -1 })
      .lean();

    const moments = [];
    for (const event of events) {
      if (moments.length >= limit) break;
      const eventVideos = Array.isArray(event?.media?.videos)
        ? [...event.media.videos].sort((a, b) => (a?.order ?? 0) - (b?.order ?? 0))
        : [];

      for (const video of eventVideos) {
        if (moments.length >= limit) break;
        const url = String(video?.url || '').trim();
        if (!url) continue;

        moments.push({
          eventId: event?._id,
          eventName: event?.name || 'Espacio',
          eventCity: event?.location?.city || event?.location?.province || '',
          eventPlaceType:
            event?.type ||
            event?.eventType ||
            event?.placeType ||
            event?.category ||
            '',
          thumbnail: String(video?.thumbnail || '').trim(),
          lowResUrl: String(video?.lowResUrl || '').trim(),
          url
        });
      }
    }

    return res.json({
      count: moments.length,
      moments
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/public-path', async (req, res) => {
  try {
    const normalizedPath = normalizePublicPath(req.query.path);
    if (!normalizedPath || !normalizedPath.startsWith('/salones-eventos/')) {
      return res.status(400).json({ message: 'Path publico invalido' });
    }

    const indexedEvent = await Event.findOne({
      publicPathCandidates: normalizedPath,
      ...APPROVED_QUERY
    })
      .select(PUBLIC_EVENT_PAGE_SELECT)
      .lean();

    if (indexedEvent) {
      setCacheHeaders(res);
      return res.json(indexedEvent);
    }

    const pathCandidates = await Event.find({ ...APPROVED_QUERY })
      .select(PUBLIC_EVENT_PATH_LOOKUP_SELECT)
      .lean();
    const match = pathCandidates.find((event) =>
      buildEventPathCandidates(event).includes(normalizedPath)
    );

    if (!match) {
      setNoStoreHeaders(res);
      return res.status(404).json({ message: 'Evento no encontrado' });
    }

    const publicPathFields = getPublicPathFields(match);
    Event.updateOne({ _id: match._id }, { $set: publicPathFields }).catch(() => {});

    const event = await Event.findOne({ _id: match._id, ...APPROVED_QUERY })
      .select(PUBLIC_EVENT_PAGE_SELECT)
      .lean();

    if (!event) {
      setNoStoreHeaders(res);
      return res.status(404).json({ message: 'Evento no encontrado' });
    }

    setCacheHeaders(res);
    return res.json({
      ...event,
      ...publicPathFields
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/sitemap-data', async (req, res) => {
  try {
    setCacheHeaders(res);

    const events = await Event.aggregate([
      { $match: { ...APPROVED_QUERY } },
      { $sort: { updatedAt: -1 } },
      {
        $project: {
          _id: 1,
          name: 1,
          slug: 1,
          publicPath: 1,
          type: 1,
          eventType: 1,
          partyTypes: 1,
          ownerTier: 1,
          featured: 1,
          updatedAt: 1,
          'capacity.max': 1,
          'location.province': 1,
          'location.city': 1,
          'location.district': 1,
          'location.coordinates': 1,
          geoClassification: {
            seoAreaKey: '$geoClassification.seoAreaKey'
          },
          media: {
            photos: {
              $cond: [
                { $gt: [{ $size: { $ifNull: ['$media.photos', []] } }, 0] },
                [
                  {
                    url: { $arrayElemAt: ['$media.photos.url', 0] }
                  }
                ],
                []
              ]
            }
          }
        }
      }
    ]);

    return res.json(events.map(normalizePublicEventSitemap));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/seo-areas', async (req, res) => {
  try {
    setCacheHeaders(res);

    const requestedKey = String(req.query.key || '').trim();
    const onlyIndexable = String(req.query.indexable || '').trim().toLowerCase() === 'true';
    let areas = [];

    try {
      const collection = mongoose.connection.collection('seoareas');
      const query = {
        ...(requestedKey ? { key: requestedKey } : {}),
        ...(onlyIndexable ? { indexable: { $ne: false } } : {})
      };
      const docs = await collection.find(query).toArray();
      areas = docs.map(normalizeSeoAreaDocument).filter(Boolean);
    } catch {
      areas = [];
    }

    if (!areas.length) {
      const events = await Event.find({
        ...APPROVED_QUERY,
        'geoClassification.seoAreaKey': { $exists: true, $ne: '' }
      })
        .select(SEO_AREA_SELECT)
        .lean();

      areas = buildSeoAreasFromEvents(events);
    }

    if (requestedKey) {
      const area = areas.find((item) => item.key === requestedKey) || null;
      if (!area || (onlyIndexable && area.indexable === false)) {
        return res.status(404).json({ message: 'Area SEO no encontrada' });
      }
      return res.json(area);
    }

    const filteredAreas = onlyIndexable
      ? areas.filter((area) => area.indexable !== false && Number(area.eventCount || 0) > 0)
      : areas;

    return res.json(filteredAreas);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/:id/related', async (req, res) => {
  try {
    const { id } = req.params;
    const limit = parseLimit(req.query.limit);

    const event = await Event.findOne({ _id: id, ...APPROVED_QUERY });
    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }

    const partyTypes = Array.isArray(event.partyTypes)
      ? event.partyTypes.filter(Boolean)
      : [];

    const baseMatch = {
      _id: { $ne: event._id },
      isActive: true,
      type: event.type,
      ...APPROVED_QUERY
    };

    if (partyTypes.length > 0) {
      baseMatch.partyTypes = { $in: partyTypes };
    }

    const picked = [];
    const pickedIds = new Set();

    const pushUnique = (items = []) => {
      items.forEach((item) => {
        if (picked.length >= limit) return;
        const idValue = String(item?._id || '');
        if (!idValue || pickedIds.has(idValue)) return;
        pickedIds.add(idValue);
        picked.push(item);
      });
    };

    const coords = event?.location?.coordinates?.coordinates || [];
    const hasCoords = Number.isFinite(coords[0]) && Number.isFinite(coords[1]);

    if (hasCoords) {
      const nearRelated = await Event.aggregate([
        {
          $geoNear: {
            near: { type: 'Point', coordinates: coords },
            distanceField: 'distanceMeters',
            spherical: true,
            maxDistance: 10000,
            query: baseMatch
          }
        },
        { $limit: limit }
      ]);
      pushUnique(nearRelated);
    }

    if (picked.length < limit) {
      const excludedIds = [event._id, ...picked.map((item) => item._id)];
      const sameCityRelated = await Event.find({
        ...baseMatch,
        'location.city': event?.location?.city,
        'location.province': event?.location?.province,
        _id: { $nin: excludedIds }
      })
        .sort({ featured: -1, createdAt: -1 })
        .limit(limit - picked.length);
      pushUnique(sameCityRelated);
    }

    if (picked.length < limit) {
      const excludedIds = [event._id, ...picked.map((item) => item._id)];
      const fallbackRelated = await Event.find({
        ...baseMatch,
        _id: { $nin: excludedIds }
      })
        .sort({ featured: -1, createdAt: -1 })
        .limit(limit - picked.length);
      pushUnique(fallbackRelated);
    }

    return res.json(picked);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/mine', requireOwnerAuth, async (req, res) => {
  try {
    const email = req.owner?.email;
    const events = await Event.find({
      $or: [
        { ownerEmail: email },
        { 'contactInfo.email': email }
      ]
    }).sort({ createdAt: -1 });
    res.json(events);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/owner/:id', requireOwnerAuth, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);

    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }

    const ownerEmail = req.owner?.email;
    const matchesOwnerEmail = event.ownerEmail === ownerEmail;
    const matchesContactEmail =
      event.contactInfo?.email &&
      event.contactInfo.email.toLowerCase() === ownerEmail;

    if (!matchesOwnerEmail && !matchesContactEmail) {
      return res.status(403).json({ message: 'No autorizado' });
    }

    return res.json(event);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/admin/moderation', requireAdminAuth, async (req, res) => {
  try {
    const status = String(req.query.status || 'pending').trim().toLowerCase();
    const query = {};
    if (['pending', 'approved', 'rejected'].includes(status)) {
      query['moderation.status'] = status;
    }

    const events = await Event.find(query).sort({ createdAt: 1 });
    res.json({
      count: events.length,
      events
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/admin/:id/moderation', requireAdminAuth, async (req, res) => {
  try {
    const action = String(req.body?.action || '').trim().toLowerCase();
    const reason = String(req.body?.reason || '').trim();

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ message: 'Accion invalida. Usa approve o reject' });
    }

    const moderation = {
      status: action === 'approve' ? 'approved' : 'rejected',
      reviewedBy: req.owner?.email,
      reviewedAt: new Date(),
      reason: reason || undefined
    };

    const event = await Event.findByIdAndUpdate(
      req.params.id,
      { $set: { moderation } },
      { new: true, runValidators: true }
    );

    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }

    return res.json(event);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.put('/admin/master/:id', requireReviewAccess, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }

    const body = req.body || {};
    const update = {};

    if (Object.prototype.hasOwnProperty.call(body, 'pricing')) {
      update.pricing = body.pricing || { mode: 'none' };
    }
    if (Object.prototype.hasOwnProperty.call(body, 'priceRange')) {
      update.priceRange = body.priceRange || null;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'plans')) {
      update.plans = body.plans || { hasPlans: false, items: [] };
    }
    if (Object.prototype.hasOwnProperty.call(body, 'featured')) {
      update.featured = Boolean(body.featured);
    }

    const incomingVideos = body?.media?.videos;
    if (Array.isArray(incomingVideos)) {
      update.media = {
        photos: Array.isArray(event.media?.photos) ? event.media.photos : [],
        videos: incomingVideos
          .filter((item) => String(item?.url || '').trim())
          .map((item, index) => ({
            url: String(item.url || '').trim(),
            lowResUrl: String(item.lowResUrl || '').trim(),
            thumbnail: String(item.thumbnail || '').trim(),
            order: Number.isFinite(Number(item.order)) ? Number(item.order) : index
          }))
      };
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: 'No hay cambios para guardar' });
    }

    const updated = await Event.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true, runValidators: true }
    );

    return res.json(updated);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

router.get('/admin/owner-claims', requireReviewAccess, async (req, res) => {
  try {
    const status = String(req.query?.status || 'pending').trim().toLowerCase();
    const query = {};
    if (['pending', 'approved', 'rejected'].includes(status)) {
      query.status = status;
    }

    const claims = await OwnerClaim.find(query)
      .populate('eventId', 'name location contactInfo ownerEmail preferredContactMethod')
      .sort({ createdAt: -1 });

    return res.json({ claims });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.get('/admin/owner-claims/:id', requireReviewAccess, async (req, res) => {
  try {
    const claim = await OwnerClaim.findById(req.params.id)
      .populate('eventId', 'name location contactInfo ownerEmail preferredContactMethod');

    if (!claim) {
      return res.status(404).json({ message: 'Solicitud de reclamo no encontrada' });
    }

    return res.json({ claim });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post('/admin/owner-claims/:id/approve', requireReviewAccess, async (req, res) => {
  try {
    const claim = await OwnerClaim.findById(req.params.id).populate('eventId');
    if (!claim) {
      return res.status(404).json({ message: 'Solicitud de reclamo no encontrada' });
    }

    const event = claim.eventId || (await Event.findById(claim.eventId));
    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado para este reclamo' });
    }

    const reviewerNote = String(req.body?.note || '').trim();
    const claimEmail = normalizeEmail(claim.claimEmail);
    const reviewedAt = new Date();
    const reviewedBy = String(req.body?.reviewedBy || 'revision').trim().toLowerCase();

    event.ownerEmail = claimEmail;
    await event.save();

    const contactDoc = buildContactUpsertPayload(event, claimEmail);
    if (contactDoc) {
      await Contact.findOneAndUpdate(
        { email: claimEmail },
        {
          $set: {
            ...contactDoc,
            isOwner: true
          },
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

    claim.status = 'approved';
    claim.reviewerNote = reviewerNote;
    claim.reviewedAt = reviewedAt;
    claim.reviewedBy = reviewedBy;
    claim.eventSnapshot = {
      name: event?.name || claim.eventSnapshot?.name || '',
      city: event?.location?.city || claim.eventSnapshot?.city || '',
      province: event?.location?.province || claim.eventSnapshot?.province || ''
    };
    claim.contactSnapshot = {
      phone: event?.contactInfo?.phone || '',
      email: event?.contactInfo?.email || '',
      whatsapp: event?.contactInfo?.whatsapp || '',
      website: event?.contactInfo?.website || ''
    };
    await claim.save();

    return res.json({
      message: 'Reclamo aprobado correctamente',
      claim
    });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

router.post('/admin/owner-claims/:id/reject', requireReviewAccess, async (req, res) => {
  try {
    const note = String(req.body?.note || '').trim();
    if (!note) {
      return res.status(400).json({ message: 'Debes indicar un motivo para rechazar el reclamo' });
    }

    const claim = await OwnerClaim.findById(req.params.id);
    if (!claim) {
      return res.status(404).json({ message: 'Solicitud de reclamo no encontrada' });
    }

    claim.status = 'rejected';
    claim.reviewerNote = note;
    claim.reviewedAt = new Date();
    claim.reviewedBy = String(req.body?.reviewedBy || 'revision').trim().toLowerCase();
    await claim.save();

    return res.json({
      message: 'Reclamo rechazado correctamente',
      claim
    });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

// GET - Obtener todos los eventos
router.get('/', async (req, res) => {
  try {
    const view = String(req.query.view || '').trim().toLowerCase();
    let query = Event.find({ ...APPROVED_QUERY }).sort({ createdAt: -1 });

    if (view === 'lite') {
      setCacheHeaders(res);
      query = query.select(PUBLIC_EVENT_LITE_SELECT).lean();
    }

    const events = await query;
    res.json(view === 'lite' ? events.map(normalizePublicEventLite) : events);
  } catch (error) {
    console.error('Error en GET /api/events:', error);
    res.status(500).json({ message: error.message });
  }
});

router.get('/:id/reviews', async (req, res) => {
  try {
    const eventId = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(eventId)) {
      return res.status(400).json({ message: 'Evento invalido' });
    }

    const event = await Event.findOne({ _id: eventId, ...APPROVED_QUERY }).select('_id');
    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }

    const reviews = await EventReview.find({ eventId })
      .populate('ownerId', 'username')
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();
    const stats = await buildReviewStats(eventId);

    return res.json({
      count: reviews.length,
      stats,
      nextReviewPoints: stats.count > 0 ? 50 : 100,
      reviews: reviews.map(serializeReview)
    });
  } catch (error) {
    return res.status(500).json({ message: error?.message || 'No se pudieron cargar las resenas' });
  }
});

router.post('/:id/reviews', requireOwnerAuth, async (req, res) => {
  try {
    const eventId = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(eventId)) {
      return res.status(400).json({ message: 'Evento invalido' });
    }

    const event = await Event.findOne({ _id: eventId, ...APPROVED_QUERY }).select('_id');
    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }

    const existingReview = await EventReview.findOne({
      eventId,
      ownerId: req.owner._id
    }).select('_id');
    if (existingReview) {
      return res.status(409).json({ message: 'Ya dejaste una resena para este espacio' });
    }

    const payload = normalizeReviewPayload(req.body || {});
    const previousReviewCount = await EventReview.countDocuments({ eventId });
    const awardedPoints = previousReviewCount > 0 ? 50 : 100;

    const review = await EventReview.create({
      eventId,
      ownerId: req.owner._id,
      contributorName: buildReviewAuthorLabel(req.owner),
      ratings: payload.ratings,
      overallRating: payload.overallRating,
      comment: payload.comment,
      awardedPoints,
      pointsAwardedAt: new Date()
    });

    await awardReviewPointsToOwner(req.owner, awardedPoints);

    const populatedReview = await EventReview.findById(review._id)
      .populate('ownerId', 'username')
      .lean();
    const stats = await buildReviewStats(eventId);

    return res.status(201).json({
      ok: true,
      awardedPoints,
      stats,
      review: serializeReview(populatedReview)
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: 'Ya dejaste una resena para este espacio' });
    }
    return res.status(400).json({ message: error?.message || 'No se pudo guardar la resena' });
  }
});

// GET - Obtener un evento por ID
router.get('/:id', async (req, res) => {
  try {
    const event = await Event.findOne({ _id: req.params.id, ...APPROVED_QUERY });
    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }
    res.json(event);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/:id/claim-owner', async (req, res) => {
  try {
    const event = await Event.findOne({ _id: req.params.id, ...APPROVED_QUERY });
    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }

    const claimEmail = normalizeEmail(req.body?.email);
    if (!claimEmail) {
      return res.status(400).json({ message: 'Email requerido' });
    }

    const currentOwnerEmail = normalizeEmail(event.ownerEmail || '');
    if (currentOwnerEmail && currentOwnerEmail === claimEmail) {
      return res.status(200).json({
        message: 'Este email ya esta asociado al perfil del lugar.'
      });
    }

    const existingPendingClaim = await OwnerClaim.findOne({
      eventId: event._id,
      claimEmail,
      status: 'pending'
    });

    if (existingPendingClaim) {
      return res.status(200).json({
        message:
          'Ya recibimos tu solicitud. En menos de 24 hs nos vamos a comunicar a traves de las redes del lugar para verificarla.'
      });
    }

    const claim = await OwnerClaim.create({
      eventId: event._id,
      claimEmail,
      eventSnapshot: {
        name: event.name || '',
        city: event.location?.city || '',
        province: event.location?.province || ''
      },
      contactSnapshot: {
        phone: event.contactInfo?.phone || '',
        email: event.contactInfo?.email || '',
        whatsapp: event.contactInfo?.whatsapp || '',
        website: event.contactInfo?.website || ''
      }
    });

    return res.status(201).json({
      message:
        'Solicitud enviada. En menos de 24 hs nos vamos a comunicar a traves de las redes del lugar para verificar que el reclamo sea valido.',
      claim
    });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

// POST - Crear un nuevo evento
router.post('/', async (req, res) => {
  const payload = { ...req.body };
  const rawOwnerEmail = payload.ownerEmail || payload.contactInfo?.email || '';
  const normalizedOwnerEmail = normalizeEmail(rawOwnerEmail);
  if (!normalizedOwnerEmail) {
    return res.status(400).json({ message: 'Email de contacto requerido para crear el evento' });
  }
  if (await isOwnerBlocked(normalizedOwnerEmail)) {
    return res.status(403).json({ message: BLOCKED_OWNER_MESSAGE });
  }
  const duplicate = await findDuplicateEventByOwner({
    ownerEmail: normalizedOwnerEmail,
    name: payload?.name
  });
  if (duplicate) {
    return res.status(409).json({
      message: 'Ya tienes una publicacion con ese nombre'
    });
  }
  payload.ownerEmail = normalizedOwnerEmail;

  if (payload.contactInfo) {
    payload.contactInfo = {
      ...payload.contactInfo,
      email: normalizedOwnerEmail
    };
  }
  if (!payload.eventType) {
    const firstPartyType = Array.isArray(payload.partyTypes)
      ? payload.partyTypes.find((item) => typeof item === 'string' && item.trim())
      : null;
    payload.eventType = firstPartyType || 'otro';
  }
  if (!EVENT_TYPES.has(payload.eventType)) {
    payload.eventType = 'otro';
  }
  payload.moderation = {
    status: 'pending'
  };

  const event = new Event(payload);
  
  try {
    const newEvent = await event.save();
    const ownerEmail = (newEvent.ownerEmail || newEvent.contactInfo?.email || '')
      .trim()
      .toLowerCase();

    if (ownerEmail) {
      const contactDoc = buildContactUpsertPayload(newEvent, ownerEmail);

      await Contact.findOneAndUpdate(
        { email: ownerEmail },
        {
          $set: contactDoc,
          $addToSet: { events: newEvent._id }
        },
        {
          upsert: true,
          new: true,
          runValidators: true,
          setDefaultsOnInsert: true
        }
      );
      await maybeSendPublicationLimitAlert(ownerEmail);
    }

    res.status(201).json(newEvent);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// PUT - Actualizar un evento
router.put('/:id', requireOwnerAuth, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);

    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }

    const ownerEmail = req.owner?.email;
    const bodyOwnerEmail = req.body?.contactInfo?.email;
    if (await isOwnerBlocked(ownerEmail)) {
      return res.status(403).json({ message: BLOCKED_OWNER_MESSAGE });
    }

    if (event.ownerEmail) {
      if (event.ownerEmail !== ownerEmail) {
        return res.status(403).json({ message: 'No autorizado' });
      }
    } else {
      if (!bodyOwnerEmail || bodyOwnerEmail.toLowerCase() !== ownerEmail) {
        return res.status(403).json({ message: 'No autorizado' });
      }
    }

    const payload = { ...req.body };
    delete payload.ownerEmail;
    if (!payload.eventType) {
      const firstPartyType = Array.isArray(payload.partyTypes)
        ? payload.partyTypes.find((item) => typeof item === 'string' && item.trim())
        : null;
      payload.eventType = firstPartyType || event.eventType || 'otro';
    }
    if (!EVENT_TYPES.has(payload.eventType)) {
      payload.eventType = 'otro';
    }
    const finalName = normalizePublicationName(payload?.name || event?.name);
    if (!finalName) {
      return res.status(400).json({ message: 'Nombre de publicacion requerido' });
    }
    const duplicate = await findDuplicateEventByOwner({
      ownerEmail,
      name: finalName,
      excludeEventId: event._id
    });
    if (duplicate) {
      return res.status(409).json({
        message: 'Ya tienes una publicacion con ese nombre'
      });
    }
    payload.moderation = {
      status: 'pending'
    };

    if (!event.ownerEmail) {
      payload.ownerEmail = ownerEmail;
    }

    const nextPayload = {
      ...payload,
      ...getPublicPathFields({ ...event.toObject(), ...payload })
    };

    const updated = await Event.findByIdAndUpdate(
      req.params.id,
      nextPayload,
      { new: true, runValidators: true }
    );

    const contactEmail = (updated.ownerEmail || updated.contactInfo?.email || '')
      .trim()
      .toLowerCase();
    if (contactEmail) {
      const contactDoc = buildContactUpsertPayload(updated, contactEmail);

      await Contact.findOneAndUpdate(
        { email: contactEmail },
        {
          $set: contactDoc,
          $addToSet: { events: updated._id }
        },
        {
          upsert: true,
          new: true,
          runValidators: true,
          setDefaultsOnInsert: true
        }
      );
    }

    res.json(updated);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// DELETE - Eliminar un evento
router.delete('/:id', requireOwnerAuth, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);

    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }

    const ownerEmail = req.owner?.email;
    const matchesOwnerEmail = event.ownerEmail === ownerEmail;
    const matchesContactEmail =
      event.contactInfo?.email &&
      event.contactInfo.email.toLowerCase() === ownerEmail;

    if (!matchesOwnerEmail && !matchesContactEmail) {
      return res.status(403).json({ message: 'No autorizado' });
    }

    await Event.findByIdAndDelete(req.params.id);

    res.json({ message: 'Evento eliminado correctamente' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// PUT - Incrementar contador de vistas
router.put('/:id/view', async (req, res) => {
  try {
    const event = await Event.findByIdAndUpdate(
      req.params.id,
      { $inc: { viewCount: 1 } },
      { new: true }
    );
    
    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }
    
    res.json({ viewCount: event.viewCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET - Obtener media según tier del dueño
// POST - Incrementar contador de clicks de contacto
router.post('/:id/contact-click', async (req, res) => {
  try {
    const event = await Event.findByIdAndUpdate(
      req.params.id,
      { $inc: { contactRequestCount: 1 } },
      { new: true }
    );

    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }

    res.json({ contactRequestCount: event.contactRequestCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/:id/media', async (req, res) => {
  try {
    const event = await Event.findOne({ _id: req.params.id, ...APPROVED_QUERY });
    
    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }
    
    const media = event.getMediaForDisplay();
    res.json(media);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;

