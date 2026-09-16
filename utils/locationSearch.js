const normalize = (value) => String(value || '').trim().toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');

const cabaAliases = ['caba', 'capital federal', 'ciudad de buenos aires',
  'ciudad autonoma de buenos aires', 'ciudad autonoma buenos aires',
  'ciudad autonoma de bs as', 'ciudad autonoma bs as', 'capital federal buenos aires'];
const baProvinces = ['buenos aires', 'provincia de buenos aires'];

function exactNames(names, partial = false) {
  const accents = { a: '[a\u00e1]', e: '[e\u00e9]', i: '[i\u00ed]', o: '[o\u00f3]', u: '[u\u00fa\u00fc]', n: '[n\u00f1]' };
  const patterns = names.map((name) => [...normalize(name)].map((char) => {
    if (char === ' ') return '\\s+';
    return accents[char] || char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join(''));
  return new RegExp(partial ? `(?:${patterns.join('|')})` : `^\\s*(?:${patterns.join('|')})\\s*$`, 'i');
}

function buildLocationQuery({ city, province } = {}) {
  const cityName = normalize(city);
  const provinceName = normalize(province);
  const query = {};
  if (provinceName) {
    query['location.province'] = exactNames(baProvinces.includes(provinceName)
      ? baProvinces : cabaAliases.includes(provinceName) ? cabaAliases : [provinceName]);
  }
  if (cityName) {
    query['location.city'] = exactNames(cabaAliases.includes(cityName) ||
      (cityName === 'buenos aires' && cabaAliases.includes(provinceName))
      ? ['buenos aires', ...cabaAliases] : [cityName]);
  }
  return query;
}

function buildNameAndDistrictQuery({ q, district } = {}) {
  const query = {};
  if (normalize(q)) query.name = exactNames([q], true);
  if (normalize(district)) query['location.district'] = exactNames([district]);
  return query;
}

module.exports = { buildLocationQuery, buildNameAndDistrictQuery };
