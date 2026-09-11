const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildLocationQuery } = require('./locationSearch');
const source = fs.readFileSync(path.join(__dirname, '../../client/lib/locationAliases.js'), 'utf8');
const clientModule = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const matches = (query, location) => Object.entries(query).every(([key, regex]) => regex.test(location[key.split('.')[1]]));

test('Buenos Aires province preserves the selected city and both province spellings', async () => {
  const { normalizeCabaSearchFilters } = await clientModule;
  for (const city of ['Tandil', 'La Plata', 'Mar del Plata']) {
    for (const province of ['Buenos Aires', 'Provincia de Buenos Aires']) {
      const input = { city, province, minCapacity: '50', q: 'quinta' };
      const filters = normalizeCabaSearchFilters(input);
      assert.deepEqual(filters, input);
      const query = buildLocationQuery(filters);
      for (const storedProvince of ['Buenos Aires', 'Provincia de Buenos Aires']) {
        assert.ok(matches(query, { city, province: storedProvince }));
      }
      assert.ok(!matches(query, { city: 'Buenos Aires', province: 'Ciudad Autonoma de Buenos Aires' }));
      assert.ok(!matches(query, { city: 'Gran Buenos Aires', province }));
    }
  }
});

test('CABA aliases keep the jurisdiction and exclude GBA', async () => {
  const { normalizeCabaSearchFilters } = await clientModule;
  for (const input of [{ city: 'CABA', province: 'Buenos Aires' },
    { city: 'Capital Federal' }, { city: 'Buenos Aires' },
    { city: 'Buenos Aires', province: 'Ciudad Autonoma de Buenos Aires' }]) {
    const query = buildLocationQuery(normalizeCabaSearchFilters(input));
    assert.ok(matches(query, { city: 'Buenos Aires', province: 'Ciudad Aut\u00f3noma de Buenos Aires' }));
    assert.ok(matches(query, { city: 'CABA', province: 'Capital Federal' }));
    assert.ok(!matches(query, { city: 'Buenos Aires', province: 'Provincia de Buenos Aires' }));
    assert.ok(!matches(query, { city: 'Gran Buenos Aires', province: 'Provincia de Buenos Aires' }));
  }
});

test('explicit Buenos Aires province is not changed to CABA', async () => {
  const { normalizeCabaSearchFilters } = await clientModule;
  const filters = { city: 'Buenos Aires', province: 'Provincia de Buenos Aires' };
  assert.deepEqual(normalizeCabaSearchFilters(filters), filters);
  assert.deepEqual(normalizeCabaSearchFilters({ province: 'Buenos Aires' }), { province: 'Buenos Aires' });
});

test('exact matching handles accents, whitespace and literal regex symbols', () => {
  assert.ok(matches(buildLocationQuery({ city: 'cordoba' }), { city: ' C\u00f3rdoba ' }));
  assert.ok(matches(buildLocationQuery({ city: 'San Martin' }), { city: 'San Mart\u00edn' }));
  assert.ok(!matches(buildLocationQuery({ city: 'San Martin' }), { city: 'San Martin de los Andes' }));
  assert.ok(!matches(buildLocationQuery({ city: 'Buenos Aires' }), { city: 'Gran Buenos Aires' }));
  assert.ok(!matches(buildLocationQuery({ city: '.*' }), { city: 'Tandil' }));
  assert.ok(matches(buildLocationQuery({ city: '.*' }), { city: '.*' }));
  assert.deepEqual(buildLocationQuery({ city: ' ', province: '' }), {});
});
