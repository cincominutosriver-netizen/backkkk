const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildLocationQuery, buildNameAndDistrictQuery } = require('../utils/locationSearch');

const source = fs.readFileSync(path.join(__dirname, '../routes/events.js'), 'utf8');
const approved = source.slice(source.indexOf('const APPROVED_QUERY ='), source.indexOf('const PUBLIC_EVENT_LITE_SELECT'));
const routes = source.slice(source.indexOf("router.get('/districts'"), source.indexOf("router.get('/featured'"));
const fixture = (name, city, district, status = 'approved') => ({ name, location: { city, district, province: 'Buenos Aires', address: 'Calle Palermo' }, type: 'salon', moderation: { status } });
const fixtures = [
  fixture('Salón Jardín', 'Mar del Plata', 'Los Troncos'),
  fixture('Jardin Norte', 'Mar del Plata', 'Centro'),
  fixture('Jardin Sur', 'La Plata', 'Los Troncos'),
  fixture('Jardin privado', 'Mar del Plata', 'Oculto', 'pending'),
  fixture('Jardin rechazado', 'Mar del Plata', 'Otro', 'rejected')
];
function matches(document, query) {
  return Object.entries(query).every(([key, condition]) => {
    if (key === '$or') return condition.some((entry) => matches(document, entry));
    const value = key.split('.').reduce((object, part) => object?.[part], document);
    if (condition?.test) return condition.test(value || '');
    if (condition && typeof condition === 'object' && '$exists' in condition) return (value !== undefined) === condition.$exists;
    return value === condition;
  });
}
async function request(route, query, data = fixtures) {
  const handlers = {};
  let payload;
  let status = 200;
  vm.runInNewContext(approved + routes, {
    router: { get: (name, handler) => { handlers[name] = handler; } },
    buildLocationQuery, buildNameAndDistrictQuery,
    Event: {
      find: (filter) => ({ sort: async () => data.filter((doc) => matches(doc, filter)) }),
      distinct: async (field, filter) => data.filter((doc) => matches(doc, filter)).map((doc) => doc.location.district)
    }
  });
  const res = { status(code) { status = code; return res; }, json(value) { payload = value; return res; } };
  await handlers[route]({ query }, res);
  return { status, payload };
}

test('name search excludes matches only in address, province, city or type', async () => {
  for (const q of ['Palermo', 'Buenos Aires', 'Mar del Plata', 'salon inexistente']) {
    const { payload } = await request('/search', { q });
    assert.equal(payload.count, 0, q);
  }
  const { payload } = await request('/search', { q: 'jardin' });
  assert.equal(payload.count, 3);
  assert.ok(payload.events.every((event) => event.moderation.status === 'approved'));
});

test('name, exact city and exact district combine without relaxing moderation', async () => {
  const { payload } = await request('/search', { q: 'JARDIN', city: 'Mar del Plata', district: 'los troncos' });
  assert.equal(payload.count, 1);
  assert.equal(payload.events[0].name, 'Salón Jardín');
  assert.equal((await request('/search', { city: 'Mar del Plata', district: 'Troncos' })).payload.count, 0);
  assert.equal((await request('/search', { district: 'Los Troncos' })).status, 400);
});

test('search treats regex characters as text', async () => {
  assert.equal((await request('/search', { q: '.*' })).payload.count, 0);
});

test('district options include only approved spaces in the requested city', async () => {
  const { payload } = await request('/districts', { city: 'Mar del Plata', province: 'Buenos Aires' });
  assert.equal(JSON.stringify(payload.districts), JSON.stringify(['Centro', 'Los Troncos']));
  assert.equal((await request('/districts', {})).payload.districts.length, 0);
  assert.equal((await request('/districts', { city: 'No existe' })).payload.districts.length, 0);
});

test('district options trim blanks and deduplicate accents and casing', async () => {
  const data = ['', null, ' Centro ', 'centro', 'Constitución', 'constitucion'].map((district) => fixture('Espacio', 'Mar del Plata', district));
  const { payload } = await request('/districts', { city: 'Mar del Plata' }, data);
  assert.equal(JSON.stringify(payload.districts), JSON.stringify(['Centro', 'Constitución']));
});
