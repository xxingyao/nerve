'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../src/engine');

const ZONES = [{ id: 'A', name: 'Zone A', essentialKw: 0.1 }];
const reading = (o) => ({ motion: false, wifiDevices: 0, tempC: 25, measuredKw: 0.1, ...o });

// Runs one zone through a list of [minutes, reading] segments and returns every output.
function run(engine, segments, t = 0) {
  const out = [];
  for (const [minutes, r] of segments) {
    for (let i = 0; i < minutes; i++, t++) out.push(engine.step({ A: reading(r) }, t));
  }
  return out;
}

test('motion plus Wi-Fi means occupied with high confidence and powers the zone', () => {
  const e = createEngine(ZONES);
  const [o] = run(e, [[1, { motion: true, wifiDevices: 9 }]]);
  assert.equal(o.zones.A.occupied, true);
  assert.equal(o.zones.A.confidence, 'high');
  assert.equal(o.zones.A.headcount, 5); // 9 devices / 1.8 per person
  assert.equal(o.zones.A.powerOn, true);
  assert.equal(o.events[0].type, 'power_on');
});

test('devices left behind do not keep a zone occupied', () => {
  const e = createEngine(ZONES);
  const out = run(e, [[1, { motion: true, wifiDevices: 2 }], [20, { wifiDevices: 2 }]]);
  assert.equal(out[5].zones.A.occupied, true, 'sitting still: trusted for a while');
  assert.equal(out[20].zones.A.occupied, false, 'no motion for 20 min: devices are left behind');
  assert.match(out[20].zones.A.note, /left behind/);
});

test('plug power switches off only after the grace period', () => {
  const e = createEngine(ZONES, { powerGraceMin: 30 });
  const out = run(e, [[5, { motion: true, wifiDevices: 2 }], [40, {}]]);
  const lastSeen = 4; // minute of the last motion
  assert.equal(out[lastSeen + 29].zones.A.powerOn, true);
  assert.equal(out[lastSeen + 29].zones.A.powerCountdownMin, 1);
  assert.equal(out[lastSeen + 30].zones.A.powerOn, false);
  assert.ok(out[lastSeen + 30].events.some((ev) => ev.type === 'power_off'));
});

test('cooling scales with headcount and stops after the cooling grace period', () => {
  const few = createEngine(ZONES);
  const many = createEngine(ZONES);
  const a = run(few, [[1, { motion: true, wifiDevices: 2, tempC: 25 }]])[0].zones.A.acLevel;
  const b = run(many, [[1, { motion: true, wifiDevices: 36, tempC: 25 }]])[0].zones.A.acLevel;
  assert.ok(b > a, `20 people (${b}%) should get more cooling than 1 (${a}%)`);

  const e = createEngine(ZONES, { coolingGraceMin: 10 });
  const out = run(e, [[1, { motion: true, wifiDevices: 4, tempC: 25 }], [12, { tempC: 25 }]]);
  assert.ok(out[5].zones.A.acLevel > 0);
  assert.equal(out[11].zones.A.acLevel, 0);
});

test('comfort guard: full cooling above 26°C regardless of headcount', () => {
  const e = createEngine(ZONES);
  const [o] = run(e, [[1, { motion: true, wifiDevices: 1, tempC: 26.5 }]]);
  assert.equal(o.zones.A.acLevel, 100);
});

test('a "too warm" request lowers the setpoint for an hour', () => {
  const e = createEngine(ZONES);
  e.requestBoost('A', 0);
  const out = run(e, [[70, { motion: true, wifiDevices: 4, tempC: 24.5 }]]);
  assert.equal(out[10].zones.A.setpointC, 23.5);
  assert.equal(out[65].zones.A.setpointC, 24.5);
});

test('flags sustained load in an empty zone, and not before the grace period', () => {
  const e = createEngine(ZONES);
  const out = run(e, [[1, { motion: true, wifiDevices: 2 }], [120, { measuredKw: 1.9 }]]);
  assert.equal(out.slice(0, 45).some((o) => o.zones.A.anomaly), false, 'no alert within 30 min grace + 15 min sustain');
  const firstAlert = out.findIndex((o) => o.events.some((ev) => ev.type === 'anomaly'));
  assert.equal(firstAlert, 0 + 30 + 15); // last seen at minute 0
  assert.equal(out[100].zones.A.anomaly.actualKw, 1.9);
});

test('learns what an empty zone normally draws, then catches a new load on top', () => {
  const e = createEngine(ZONES); // configured essential load 0.1 kW, but a fridge really draws 0.3
  const learned = run(e, [[3000, { measuredKw: 0.3 }]]);
  assert.equal(learned.some((o) => o.zones.A.anomaly), false, 'small steady load is learned, not flagged');
  assert.ok(Math.abs(e.zoneState('A').expectedEmptyKw - 0.3) < 0.01, 'baseline converged on 0.3 kW');
  const later = run(e, [[30, { measuredKw: 2.1 }]], 3000);
  assert.ok(later[20].zones.A.anomaly, 'a heater on top of the learned load is flagged');
  assert.ok(Math.abs(later[20].zones.A.anomaly.expectedKw - 0.3) < 0.01);
});
