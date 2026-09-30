#!/usr/bin/env node
/*
 * Find the headline number in real meter data.
 *
 *   node tools/baseline.js data/sample-meter.csv
 *   node tools/baseline.js your.csv --tariff 0.29 --open 08:00 --close 18:30 --energy
 *
 * Input: a CSV with a timestamp column and a power column (kW). Pass --energy
 * if the values are kWh per interval instead of kW. Column names are guessed;
 * override with --time <col> --value <col>.
 */
'use strict';
const fs = require('fs');

function parseArgs(argv) {
  const args = { tariff: 0.30, open: '08:00', close: '18:30', energy: false, time: null, value: null, file: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--energy') args.energy = true;
    else if (a === '--json') args.json = true;
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
    else args.file = a;
  }
  args.tariff = Number(args.tariff);
  return args;
}

function toMin(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + (m || 0); }

function parseCsv(text, timeCol, valueCol) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
  const lower = header.map(h => h.toLowerCase());
  const ti = timeCol ? header.indexOf(timeCol) : lower.findIndex(h => /time|date|timestamp/.test(h));
  const vi = valueCol ? header.indexOf(valueCol) : lower.findIndex(h => /kw|power|energy|load|value/.test(h));
  if (ti < 0 || vi < 0) throw new Error('Could not find time/value columns in: ' + header.join(', ') + '. Use --time and --value.');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
    const d = new Date(cells[ti].replace(' ', 'T'));
    const v = Number(cells[vi]);
    if (!isNaN(d) && isFinite(v)) rows.push({ d, v });
  }
  rows.sort((a, b) => a.d - b.d);
  return rows;
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function analyse(rows, opts) {
  if (rows.length < 2) throw new Error('Need at least two readings');
  const gaps = [];
  for (let i = 1; i < rows.length; i++) gaps.push((rows[i].d - rows[i - 1].d) / 60000);
  gaps.sort((a, b) => a - b);
  const intervalMin = quantile(gaps, 0.5);
  const hours = intervalMin / 60;
  const open = toMin(opts.open), close = toMin(opts.close);

  const pts = rows.map(r => {
    const kw = opts.energy ? r.v / hours : r.v;
    const m = r.d.getHours() * 60 + r.d.getMinutes();
    const dow = r.d.getDay(); // 0 Sun
    const weekend = dow === 0 || dow === 6;
    return { d: r.d, kw, kwh: kw * hours, m, weekend, afterHours: weekend || m < open || m >= close, night: m < 360 };
  });

  const sum = arr => arr.reduce((s, p) => s + p.kwh, 0);
  const totalKwh = sum(pts);
  const after = pts.filter(p => p.afterHours);
  const afterKwh = sum(after);
  const nightKw = pts.filter(p => p.night).map(p => p.kw).sort((a, b) => a - b);
  const officeKw = pts.filter(p => !p.afterHours).map(p => p.kw).sort((a, b) => a - b);
  const weekendKw = pts.filter(p => p.weekend).map(p => p.kw).sort((a, b) => a - b);
  const days = (pts[pts.length - 1].d - pts[0].d) / 86400000 + intervalMin / 1440;

  // "Floor": the load the building never drops below at night (5th percentile, robust to glitches).
  const floorKw = quantile(nightKw, 0.05);
  const nightMedian = quantile(nightKw, 0.5);
  const annual = x => x * 365 / days;
  const afterKwhYear = annual(afterKwh);

  // Biggest after-hours hours, averaged by weekday/hour slot.
  const slots = {};
  after.forEach(p => {
    const key = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][p.d.getDay()] + ' ' + String(p.d.getHours()).padStart(2, '0') + ':00';
    (slots[key] = slots[key] || []).push(p.kw);
  });
  const topSlots = Object.entries(slots)
    .map(([k, v]) => ({ slot: k, avgKw: v.reduce((a, b) => a + b, 0) / v.length }))
    .sort((a, b) => b.avgKw - a.avgKw).slice(0, 5);

  const r = {
    readings: pts.length, intervalMin, days,
    totalKwh, afterKwh, afterShare: afterKwh / totalKwh,
    floorKw, nightMedianKw: nightMedian,
    nightP10Kw: quantile(nightKw, 0.1), nightP90Kw: quantile(nightKw, 0.9),
    officeMedianKw: quantile(officeKw, 0.5), weekendMedianKw: quantile(weekendKw, 0.5),
    afterKwhYear, afterCostYear: afterKwhYear * opts.tariff,
    // Split after-hours use into the always-on floor and everything above it.
    afterFloorKwhYear: annual(after.length * floorKw * hours),
    afterAboveFloorKwhYear: annual(after.reduce((a, p) => a + Math.max(0, p.kw - floorKw) * hours, 0)),
    topSlots
  };
  // Savings range. Low: only the load above the floor goes (people's forgotten devices, AC left on).
  // High: that, plus 30% of the floor (standby kit that could be switched off but isn't essential).
  r.savingKwhYear = [r.afterAboveFloorKwhYear, r.afterAboveFloorKwhYear + 0.3 * r.afterFloorKwhYear];
  r.savingCostYear = r.savingKwhYear.map(x => x * opts.tariff);
  return r;
}

function report(r, opts) {
  const f1 = x => x.toFixed(1), f2 = x => x.toFixed(2);
  const money = x => 'S$' + Math.round(x).toLocaleString('en-SG');
  return [
    'NERVE baseline analysis',
    '-----------------------',
    `${r.readings} readings, every ${Math.round(r.intervalMin)} min, ${f1(r.days)} days`,
    `Office hours ${opts.open}-${opts.close} weekdays, tariff S$${opts.tariff}/kWh`,
    '',
    `Total energy            ${f1(r.totalKwh)} kWh`,
    `After hours + weekends  ${f1(r.afterKwh)} kWh (${Math.round(r.afterShare * 100)}% of total)`,
    `Office-hours median     ${f2(r.officeMedianKw)} kW`,
    `Weekend median          ${f2(r.weekendMedianKw)} kW`,
    `Midnight-6am load       median ${f2(r.nightMedianKw)} kW (p10 ${f2(r.nightP10Kw)} - p90 ${f2(r.nightP90Kw)})`,
    '',
    'Highest after-hours slots (average kW):',
    ...r.topSlots.map(s => `  ${s.slot.padEnd(10)} ${f2(s.avgKw)} kW`),
    '',
    'HEADLINE',
    `  Load never drops below ${f2(r.floorKw)} kW between midnight and 6am.`,
    `  After-hours use costs ${money(r.afterCostYear)} a year:`,
    `    ${money(r.afterFloorKwhYear * opts.tariff)} is the always-on floor (check what is truly essential)`,
    `    ${money(r.afterAboveFloorKwhYear * opts.tariff)} is load above the floor (forgotten devices, AC left running)`,
    `  Estimated saving with NERVE: ${money(r.savingCostYear[0])} - ${money(r.savingCostYear[1])} a year`,
    `  (${Math.round(r.savingKwhYear[0])} - ${Math.round(r.savingKwhYear[1])} kWh). Low end: above-floor load only. High end: plus 30% of the floor.`,
  ].join('\n');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.file) { console.error('Usage: node tools/baseline.js <meter.csv> [--tariff 0.30] [--open 08:00] [--close 18:30] [--energy] [--json]'); process.exit(1); }
  const r = analyse(parseCsv(fs.readFileSync(opts.file, 'utf8'), opts.time, opts.value), opts);
  console.log(opts.json ? JSON.stringify(r, null, 2) : report(r, opts));
}

module.exports = { parseCsv, analyse, report, quantile };
