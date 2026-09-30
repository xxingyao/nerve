/*
 * NERVE decision engine: SENSE -> THINK -> ACT.
 *
 * Pure logic, no DOM. Feed it one reading per zone per minute and it returns
 * what each zone should do (desk power, cooling level) plus a plain-English
 * reason for every decision. Works in the browser (window.NerveEngine) and in
 * Node (require('./engine')).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NerveEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    devicesPerPerson: 1.8,   // Wi-Fi devices per person, used only to estimate headcount
    wifiTrustMin: 10,        // Wi-Fi alone counts as presence for this long after the last motion
    powerGraceMin: 30,       // vacancy before non-essential desk power switches off
    coolingGraceMin: 10,     // vacancy before cooling switches off
    comfortSetpointC: 24.5,  // minimum cooling needed to hold this temperature
    comfortMaxC: 26,         // comfort guard: above this, cool at full power whatever the headcount
    boostMin: 60,            // "too warm" request lasts this long
    boostDeltaC: 1.0,        // and lowers the setpoint by this much
    anomalyRatio: 1.5,       // actual load must exceed learned empty load by this factor...
    anomalyMinExcessKw: 0.3, // ...and by at least this many kW...
    anomalySustainMin: 15,   // ...for this long before an alert is raised
    learnAfterVacantMin: 60, // only learn "normal empty load" once a zone has been empty this long
    learnAlpha: 0.02         // learning rate for the empty-load baseline
  };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function round1(v) { return Math.round(v * 10) / 10; }

  function createEngine(zones, config) {
    var cfg = Object.assign({}, DEFAULTS, config || {});
    var state = {};
    zones.forEach(function (z) {
      state[z.id] = {
        id: z.id,
        name: z.name,
        hasCooling: z.hasCooling !== false,
        lastMotionAt: -Infinity,
        lastOccupiedAt: -Infinity,
        powerOn: false,
        acLevel: 0,
        boostUntil: -Infinity,
        expectedEmptyKw: z.essentialKw || 0,
        excessSince: null,
        anomaly: null,
        last: null
      };
    });

    /* SENSE: fuse motion + Wi-Fi into an occupancy estimate. */
    function senseOccupancy(s, r, t) {
      if (r.motion) s.lastMotionAt = t;
      var sinceMotion = t - s.lastMotionAt;
      var wifi = r.wifiDevices || 0;
      var occupied, confidence, note;

      if (r.motion && wifi > 0) {
        occupied = true; confidence = 'high'; note = 'Motion and Wi-Fi agree';
      } else if (r.motion) {
        occupied = true; confidence = 'medium'; note = 'Motion, no devices (visitor?)';
      } else if (wifi > 0 && sinceMotion <= cfg.wifiTrustMin) {
        occupied = true; confidence = 'medium';
        note = 'No motion for ' + Math.round(sinceMotion) + ' min, devices still here (sitting still?)';
      } else if (wifi > 0) {
        occupied = false; confidence = 'high';
        note = wifi + ' device' + (wifi > 1 ? 's' : '') + ' connected but no motion for ' +
          (isFinite(sinceMotion) ? Math.round(sinceMotion) + ' min' : 'a long time') +
          ', treated as left behind';
      } else {
        occupied = false; confidence = 'high'; note = 'No motion, no devices';
      }

      var headcount = occupied ? Math.max(1, Math.round(wifi / cfg.devicesPerPerson)) : 0;
      return { occupied: occupied, confidence: confidence, note: note, headcount: headcount };
    }

    /* THINK + ACT for one zone. */
    function decideZone(s, r, t, events) {
      var occ = senseOccupancy(s, r, t);
      if (occ.occupied) s.lastOccupiedAt = t;
      var vacantMin = t - s.lastOccupiedAt;
      var reasons = [];

      // Desk / plug power: on when occupied, off after a grace period.
      var wasOn = s.powerOn;
      if (occ.occupied) {
        s.powerOn = true;
      } else if (vacantMin >= cfg.powerGraceMin) {
        s.powerOn = false;
      }
      var powerCountdownMin = (!occ.occupied && s.powerOn) ? Math.max(0, cfg.powerGraceMin - vacantMin) : null;
      if (s.powerOn !== wasOn) {
        events.push({
          t: t, zone: s.id, type: s.powerOn ? 'power_on' : 'power_off',
          text: s.powerOn
            ? s.name + ': plug power on (occupancy detected)'
            : s.name + ': non-essential plug power off after ' + cfg.powerGraceMin + ' min empty (essential circuits untouched)'
        });
      }

      // Cooling: the minimum needed to keep occupied space comfortable.
      var prevAc = s.acLevel;
      var setpoint = cfg.comfortSetpointC - (t < s.boostUntil ? cfg.boostDeltaC : 0);
      var level = 0;
      if (!s.hasCooling) {
        level = 0;
      } else if (occ.occupied || vacantMin < cfg.coolingGraceMin) {
        if (r.tempC >= cfg.comfortMaxC) {
          level = 100;
          reasons.push('Comfort guard: ' + round1(r.tempC) + '°C is above ' + cfg.comfortMaxC + '°C, full cooling');
        } else if (r.tempC < setpoint - 1) {
          level = 0;
          reasons.push('Already cool enough (' + round1(r.tempC) + '°C)');
        } else {
          level = clamp(35 * (r.tempC - setpoint) + 3 * occ.headcount, 0, 100);
          reasons.push('Holding ' + setpoint + '°C for ~' + occ.headcount + ' people');
        }
        if (t < s.boostUntil) reasons.push('Occupant asked for cooler air (' + Math.ceil(s.boostUntil - t) + ' min left)');
      } else {
        reasons.push('Empty for ' + Math.round(vacantMin) + ' min, cooling off');
      }
      s.acLevel = Math.round(level);
      if (s.hasCooling && (prevAc === 0) !== (s.acLevel === 0)) {
        events.push({
          t: t, zone: s.id, type: s.acLevel ? 'ac_on' : 'ac_off',
          text: s.name + ': cooling ' + (s.acLevel ? 'on at ' + s.acLevel + '%' : 'off') + ' (' + reasons[0] + ')'
        });
      }

      // Waste detection: compare the measured load of an empty zone with what it has learned is normal.
      var measuredKw = r.measuredKw || 0;
      var expected = s.expectedEmptyKw;
      var excess = measuredKw - expected;
      var suspicious = !occ.occupied && vacantMin >= cfg.powerGraceMin &&
        measuredKw > expected * cfg.anomalyRatio && excess > cfg.anomalyMinExcessKw;
      if (suspicious) {
        if (s.excessSince === null) s.excessSince = t;
        if (!s.anomaly && t - s.excessSince >= cfg.anomalySustainMin) {
          s.anomaly = { since: s.excessSince, expectedKw: expected, actualKw: measuredKw };
          events.push({
            t: t, zone: s.id, type: 'anomaly',
            text: s.name + ': ' + measuredKw.toFixed(2) + ' kW drawn while empty, expected ' +
              expected.toFixed(2) + ' kW. Desk circuits are already off, so this is an unmanaged outlet. Manager notified.'
          });
        }
        if (s.anomaly) s.anomaly.actualKw = measuredKw;
      } else {
        if (s.anomaly) {
          events.push({ t: t, zone: s.id, type: 'anomaly_cleared', text: s.name + ': load back to normal' });
        }
        s.excessSince = null;
        s.anomaly = null;
        // Learn normal empty load only from long, clean vacancies.
        if (!occ.occupied && vacantMin >= cfg.learnAfterVacantMin) {
          s.expectedEmptyKw += cfg.learnAlpha * (measuredKw - s.expectedEmptyKw);
        }
      }

      s.last = {
        occupied: occ.occupied,
        confidence: occ.confidence,
        note: occ.note,
        headcount: occ.headcount,
        vacantMin: occ.occupied ? 0 : vacantMin,
        powerOn: s.powerOn,
        powerCountdownMin: powerCountdownMin,
        acLevel: s.acLevel,
        setpointC: setpoint,
        reasons: reasons,
        expectedEmptyKw: s.expectedEmptyKw,
        anomaly: s.anomaly
      };
      return s.last;
    }

    return {
      config: cfg,
      /**
       * readings: { [zoneId]: { motion, wifiDevices, tempC, measuredKw } }
       * t: minutes since start of the week
       */
      step: function (readings, t) {
        var events = [];
        var zonesOut = {};
        Object.keys(state).forEach(function (id) {
          zonesOut[id] = decideZone(state[id], readings[id] || {}, t, events);
        });
        return { zones: zonesOut, events: events };
      },
      requestBoost: function (zoneId, t) {
        var s = state[zoneId];
        if (s) s.boostUntil = t + cfg.boostMin;
      },
      zoneState: function (zoneId) { return state[zoneId]; }
    };
  }

  return { createEngine: createEngine, DEFAULTS: DEFAULTS };
});
