const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildLocationQuery, buildNameQuery } = require('../utils/locationSearch');

const source = fs.readFileSync(path.join(__dirname, '../routes/events.js'), 'utf8');
const approved = source.slice(source.indexOf('const APPROVED_QUERY ='), source.indexOf('const PUBLIC_EVENT_LITE_SELECT'));
const routes = source.slice(source.indexOf("router.get('/search'"), source.indexOf("router.get('/featured'"));
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
    if (key === '$and') return condition.every((entry) => matches(document, entry));
    const value = key.split('.').reduce((object, part) => object?.[part], document);
    if (condition?.test) return condition.test(value || '');
    if (condition && typeof condition === 'object' && '$exists' in condition) return (value !== undefined) === condition.$exists;
    return value === condition;
  });
}
async function request(route, query, data = fixtures, nameQuery = buildNameQuery) {
  const handlers = {};
  let payload;
  let status = 200;
  vm.runInNewContext(approved + routes, {
    router: { get: (name, handler) => { handlers[name] = handler; } },
    buildLocationQuery, buildNameQuery: nameQuery,
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

test('city filtering ignores legacy district parameters and preserves moderation', async () => {
  const { payload } = await request('/search', { q: 'JARDIN', city: 'Mar del Plata', district: 'Los Troncos' });
  assert.equal(payload.count, 2);
  assert.ok(payload.events.every(event => event.location.city === 'Mar del Plata'));
  assert.ok(payload.events.every(event => event.moderation.status === 'approved'));
  assert.equal((await request('/search', { city: 'Mar del Plata', district: 'No existe' })).payload.count, 2);
});

test('search treats regex characters as text', async () => {
  assert.equal((await request('/search', { q: '.*' })).payload.count, 0);
});

test('search preserves moderation with text, blank text and legacy records', async () => {
  const legacy = fixture('Jardin antiguo', 'Mar del Plata', 'Centro');
  delete legacy.moderation;
  const withoutStatus = fixture('Jardin sin estado', 'Mar del Plata', 'Centro');
  withoutStatus.moderation = {};
  const data = [...fixtures, legacy, withoutStatus];
  for (const query of [{}, { q: '' }, { q: '   ' }, { q: 'jardin' }]) {
    const { status, payload } = await request('/search', query, data);
    assert.equal(status, 200);
    assert.equal(payload.count, 5);
    assert.ok(payload.events.every((event) => !['pending', 'rejected'].includes(event.moderation?.status)));
    assert.ok(payload.events.includes(legacy));
    assert.ok(payload.events.includes(withoutStatus));
  }
});

test('an OR text filter cannot overwrite the approval condition', async () => {
  const { status, payload } = await request('/search', { q: 'jardin' }, fixtures,
    () => ({ $or: [{ name: /jardin/i }, { name: /jard\u00edn/i }] }));
  assert.equal(status, 200);
  assert.equal(payload.count, 3);
  assert.ok(payload.events.every((event) => event.moderation.status === 'approved'));
});
