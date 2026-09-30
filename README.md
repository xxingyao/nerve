# NERVE

**Networked Energy & Room Vitality Engine.** It senses occupancy, temperature and power in an office, learns what normal looks like, and switches off the waste on its own.

> Instead of asking people to remember to save electricity, NERVE makes energy saving the office's default behaviour.

This repo is a low-fi, testable MVP for the hackathon. It has three parts:

| Part | What it is | Run it |
|---|---|---|
| **Console** (`index.html`) | Simulated 4-zone office with NERVE running side by side with a business-as-usual office. Five scripted demo scenarios, live controls, savings range, waste alerts, and a decision log that gives a reason for every action. | Double-click `index.html`. No install, no server. |
| **Engine** (`src/engine.js`) | The SENSE → THINK → ACT decision logic. Pure JavaScript, no dependencies, the same code in the browser and in Node. | `npm test` |
| **Baseline tool** (`tools/baseline.js`) | Finds the headline number in real meter data, e.g. "load never drops below X kW at night; after-hours use costs S$Y a year". | `node tools/baseline.js your-meter.csv` |

Needs Node 18+ only for the tests and the baseline tool. The console runs in any browser.

## How NERVE decides

| Layer | Rule in this MVP |
|---|---|
| **Sense** | Occupancy = motion sensor (PIR/mmWave) + Wi-Fi device count. No cameras. Wi-Fi alone counts as presence only for 10 min after the last motion, so a docked laptop or a forgotten phone does not keep a zone "occupied". Headcount ≈ devices ÷ 1.8. |
| **Think** | Cooling = the minimum needed to hold 24.5°C for the people present. Each zone learns what it normally draws when empty, and flags load that is 1.5× that and at least 0.3 kW higher for 15+ minutes. |
| **Act** | Non-essential plug power goes on as soon as someone is detected, and off 30 min after the zone empties. Cooling goes off 10 min after it empties. Essential circuits (fridge, network, servers) are never touched. |
| **Comfort** | Comfort guard: full cooling above 26°C whatever the headcount. Any occupant can press "Too warm" for 1°C cooler for an hour. The console reports the share of occupied minutes at or below 26°C next to the savings. |

All thresholds are in `DEFAULTS` at the top of `src/engine.js`.

## Demo script (about 3 minutes)

1. **Morning arrival.** The office is empty at 07:45, so everything is off. People arrive, zones power up one by one, and cooling scales with headcount. *"Why cool a full office for five people?"*
2. **Lunch dip.** The meeting room empties and its cooling stops. The workstation zones keep a few people and cool less.
3. **Everyone leaves.** Cooling stops 10 min after each zone empties and desk power 30 min after. Point at Workstations A: two devices are still on Wi-Fi, and NERVE correctly ignores them.
4. **Weekend waste.** Sat 02:13, occupancy 0, expected ~0.5 kW, actual ~2.3 kW. NERVE names Workstations B as the likely source. This is the headline moment.
5. **Live demo** (optional, with props). Schedules off, short timers on. Press + and − on a zone to walk people in and out.

Then switch the impact panel to **Week so far** and quote the savings **as a range** (careful to careless office), next to the comfort figure.

## Using real hardware

Under *Demo settings and real hardware* you can enter the IP of a Tasmota or Shelly smart plug. NERVE then switches it whenever it switches Workstations A, so a real lamp or fan turns off on stage. This only works when `index.html` is opened from disk on the same Wi-Fi as the plug. The hosted link can't do it, because browsers block HTTP calls from HTTPS pages.

To drive the engine from real sensors, call `engine.step(readings, minute)` once a minute with `{ motion, wifiDevices, tempC, measuredKw }` per zone and act on the returned `powerOn` / `acLevel`. See `test/engine.test.js` for examples.

## Getting the headline number from real data

```
node tools/baseline.js data/sample-meter.csv
node tools/baseline.js your.csv --tariff 0.29 --open 08:00 --close 18:30
node tools/baseline.js your.csv --energy     # values are kWh per interval, not kW
node tools/baseline.js your.csv --json       # machine-readable
```

It reports total and after-hours energy, the midnight-6am floor, the worst after-hours slots, and splits after-hours cost into the always-on floor and the load above it. The saving is given as a range: the low end removes only the above-floor load, and the high end also removes 30% of the floor. `data/sample-meter.csv` is **made up** (from `tools/make-sample-data.js`) so the tool can be tried before real data arrives. Replace it with the hackathon dataset.

## What is simulated

Everything in the console is simulated: headcount follows a typical weekday, and room temperature uses a simple heat-balance model. Business as usual runs three times with different assumptions (24°C / 23°C / 22.5°C setpoint, 10% / 30% / 50% of desks left on overnight), which is where the savings range comes from. Real savings need a pilot, for example one SUSS floor measured for two weeks without NERVE and then two weeks with it.

## Layout

```
index.html               console (open directly in a browser)
src/engine.js            decision engine (browser + Node)
src/sim.js               simulated office + business-as-usual comparison
src/app.js               console UI
tools/baseline.js        meter-data analysis CLI
tools/make-sample-data.js
data/sample-meter.csv    synthetic example data
test/                    node:test suites (npm test)
```
