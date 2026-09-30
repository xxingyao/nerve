#!/usr/bin/env node
/*
 * Writes data/sample-meter.csv: two weeks of made-up 15-minute office meter
 * readings (kW), with an always-on floor and a few forgotten weekend loads.
 * It exists so the baseline tool can be tried before real data arrives.
 * It is NOT a measurement of any real office.
 */
'use strict';
const fs = require('fs');
const path = require('path');

let seed = 7;
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

const rows = ['timestamp,kw'];
const start = new Date('2026-09-07T00:00:00'); // a Monday
for (let i = 0; i < 14 * 96; i++) {
  const d = new Date(start.getTime() + i * 15 * 60000);
  const h = d.getHours() + d.getMinutes() / 60;
  const weekend = d.getDay() === 0 || d.getDay() === 6;
  let kw = 1.6 + rand() * 0.3;                       // servers, fridge, network, standby
  if (!weekend && h >= 8 && h < 18.5) kw += 5 + 3 * Math.sin(Math.PI * (h - 8) / 10.5) + rand();
  if (!weekend && h >= 18.5 && h < 21) kw += 1.2 * (21 - h) / 2.5; // stragglers, AC left running
  if (weekend && d.getDay() === 6 && h < 20) kw += 0.9;              // something left on over Saturday
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  rows.push(stamp + ',' + kw.toFixed(3));
}
const out = path.join(__dirname, '..', 'data', 'sample-meter.csv');
fs.writeFileSync(out, rows.join('\n') + '\n');
console.log('Wrote ' + out);
