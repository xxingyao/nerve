'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSim, DAY } = require('../src/sim');

test('over a simulated week NERVE uses less energy than every business-as-usual variant', () => {
  const sim = createSim({ seed: 1 });
  sim.runTo(7 * DAY);
  const t = sim.totals;
  for (const k of ['low', 'mid', 'high']) {
    assert.ok(t.nerveKwh < t.bauKwh[k], `NERVE ${t.nerveKwh.toFixed(1)} vs ${k} ${t.bauKwh[k].toFixed(1)}`);
  }
  assert.ok(t.nerveVacantKwh < t.bauVacantKwh / 5, 'most energy in empty zones is eliminated');
});

test('comfort holds: at least 95% of occupied minutes at or below 26°C', () => {
  const sim = createSim({ seed: 1 });
  sim.runTo(7 * DAY);
  assert.ok(sim.totals.comfortMin / sim.totals.occupiedMin >= 0.95);
});

test('a heater left on over the weekend raises an alert in the right zone', () => {
  const sim = createSim({ seed: 1 });
  sim.runTo(4 * DAY + 18 * 60);
  sim.zone('B').unmanagedKw = 1.8;
  sim.runTo(5 * DAY + 2 * 60 + 13);
  assert.ok(sim.zone('B').decision.anomaly, 'zone B flagged');
  assert.equal(sim.zone('A').decision.anomaly, null, 'zone A quiet');
});
