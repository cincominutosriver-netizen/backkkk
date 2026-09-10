const normalizeSegment = (value = '') =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['"`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

const normalizeText = (value = '') =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const CABA_CITY_VALUES = new Set([
  'caba',
  'capital federal',
  'buenos aires',
  'ciudad autonoma de buenos aires',
  'ciudad autonoma buenos aires'
]);

const CABA_PROVINCE_VALUES = new Set([
  'caba',
  'capital federal',
  'ciudad autonoma de buenos aires',
  'ciudad autonoma buenos aires'
]);

const PROVINCE_SEGMENTS = {
  'buenos aires': 'buenos-aires',
  'provincia de buenos aires': 'buenos-aires',
  catamarca: 'catamarca',
  chaco: 'chaco',
  chubut: 'chubut',
  cordoba: 'cordoba',
  corrientes: 'corrientes',
  'entre rios': 'entre-rios',
  formosa: 'formosa',
  jujuy: 'jujuy',
  'la pampa': 'la-pampa',
  'la rioja': 'la-rioja',
  mendoza: 'mendoza',
  misiones: 'misiones',
  neuquen: 'neuquen',
  'rio negro': 'rio-negro',
  salta: 'salta',
  'san juan': 'san-juan',
  'san luis': 'san-luis',
  'santa cruz': 'santa-cruz',
  'santa fe': 'santa-fe',
  'santiago del estero': 'santiago-del-estero',
  'tierra del fuego': 'tierra-del-fuego',
  tucuman: 'tucuman'
};

const getEventId = (event) => String(event?._id || event?.id || '').trim();

const isCabaEvent = (event) => {
  const city = normalizeText(event?.location?.city);
  const province = normalizeText(event?.location?.province);
  return CABA_CITY_VALUES.has(city) || CABA_PROVINCE_VALUES.has(province);
};

const getEventRegionSegments = (event) => {
  const province = normalizeText(event?.location?.province);
  const district = normalizeText(event?.location?.district);

  if (isCabaEvent(event)) {
    return ['caba', normalizeSegment(district)].filter(Boolean);
  }

  const provinceSegment = PROVINCE_SEGMENTS[province] || normalizeSegment(event?.location?.province);
  const citySegment = normalizeSegment(event?.location?.city);
  return [provinceSegment, citySegment].filter(Boolean);
};

const buildEventSlug = (event) => {
  const name = normalizeSegment(event?.name);
  const city = normalizeSegment(event?.location?.city);
  const district = normalizeSegment(event?.location?.district);
  return [name, district || city].filter(Boolean).join('-') || 'espacio';
};

const buildEventPath = (event) => {
  const eventId = getEventId(event);
  if (!eventId) return '/espacios';
  const regionSegments = getEventRegionSegments(event);
  const nameSegment = normalizeSegment(event?.name) || buildEventSlug(event);
  return `/salones-eventos/${[...regionSegments, nameSegment].filter(Boolean).join('/')}`;
};

const buildEventPathCandidates = (event) => {
  const canonicalPath = buildEventPath(event);
  const eventId = getEventId(event);
  if (!eventId) return [canonicalPath];

  const nameSegment = normalizeSegment(event?.name) || buildEventSlug(event);
  const regionSegments = getEventRegionSegments(event);
  const legacyPaths = [];

  if (isCabaEvent(event)) {
    const districtSegment = regionSegments[1];
    if (nameSegment) {
      legacyPaths.push(`/salones-eventos/caba/${nameSegment}`);
    }
    if (districtSegment && nameSegment) {
      legacyPaths.push(`/salones-eventos/${districtSegment}/${nameSegment}`);
    }
  } else {
    const citySegment = regionSegments[1] || normalizeSegment(event?.location?.city);
    if (citySegment && nameSegment) {
      legacyPaths.push(`/salones-eventos/${citySegment}/${nameSegment}`);
    }
  }

  return [canonicalPath, ...legacyPaths].filter((path, index, paths) => path && paths.indexOf(path) === index);
};

const normalizePublicPath = (value = '') => {
  const path = `/${String(value || '').replace(/^\/+|\/+$/g, '')}`;
  return path === '/' ? '' : path;
};

const getPublicPathFields = (event = {}) => {
  const publicPath = buildEventPath(event);
  return {
    slug: buildEventSlug(event),
    publicPath,
    publicPathCandidates: buildEventPathCandidates(event)
  };
};

module.exports = {
  buildEventPath,
  buildEventPathCandidates,
  buildEventSlug,
  getPublicPathFields,
  normalizePublicPath
};
