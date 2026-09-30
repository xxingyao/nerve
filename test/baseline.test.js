'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, analyse } = require('../tools/baseline');

function csv(days, fn) {
  const rows = ['timestamp,kW'];
  const pad = (n) => String(n).padStart(2, '0');
  for (let i = 0; i < days * 24; i++) {
    const d = new Date(2026, 8, 7, 0, 0); // Monday 7 Sep 2026, local time
    d.setHours(d.getHours() + i);
    rows.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00,${fn(d)}`);
  }
  return rows.join('\n');
}

const opts = { tariff: 0.3, open: '08:00', close: '18:00', energy: false };

test('finds the night floor and splits after-hours energy', () => {
  // 2 kW always, plus 8 kW during weekday office hours.
  const text = csv(7, (d) => {
    const office = d.getDay() > 0 && d.getDay() < 6 && d.getHours() >= 8 && d.getHours() < 18;
    return 2 + (office ? 8 : 0);
  });
  const r = analyse(parseCsv(text), opts);
  assert.equal(r.intervalMin, 60);
  assert.equal(r.floorKw, 2);
  assert.equal(r.afterAboveFloorKwhYear, 0, 'nothing above the floor after hours');
  assert.equal(Math.round(r.afterKwh), 2 * (168 - 50));
});

test('reads kWh-per-interval data with --energy', () => {
  const text = csv(2, () => 0.5);
  const r = analyse(parseCsv(text), { ...opts, energy: true });
  assert.equal(r.floorKw, 0.5); // hourly kWh equals kW
});
