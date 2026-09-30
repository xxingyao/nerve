/*
 * Simulated office for the NERVE demo.
 *
 * Runs the same people through two copies of the same office:
 *   - NERVE: controlled by the engine
 *   - Business as usual (BAU): fixed schedule, fixed thermostat, some desks
 *     left on overnight. BAU runs three times (low / mid / high assumptions)
 *     so savings are reported as a range, not one confident number.
 *
 * Everything here is SIMULATED. Replace readings() with real sensor data to
 * run the engine on a real room.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'));
  else root.NerveSim = factory(root.NerveEngine);
})(typeof self !== 'undefined' ? self : this, function (NerveEngine) {
  'use strict';

  var DAY = 1440;
  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  var ZONES = [
    { id: 'A', name: 'Workstations A', desks: 10, acKw: 3.5, essentialKw: 0.05, idlePerDeskKw: 0.035, activePerPersonKw: 0.09 },
    { id: 'B', name: 'Workstations B', desks: 8, acKw: 3.0, essentialKw: 0.05, idlePerDeskKw: 0.035, activePerPersonKw: 0.09 },
    { id: 'M', name: 'Meeting room', desks: 0, acKw: 2.5, essentialKw: 0.02, fixedManagedKw: 0.12, activePerPersonKw: 0.03 },
    { id: 'P', name: 'Pantry & comms', desks: 0, acKw: 0, hasCooling: false, essentialKw: 0.4, fixedManagedKw: 0.25, activePerPersonKw: 0.02 }
  ];

  // Weekday headcount by zone: [minuteOfDay, A, B, M, P]. Linear between points.
  var SCHEDULE = [
    [0, 0, 0, 0, 0], [480, 0, 0, 0, 0], [510, 2, 1, 0, 1], [540, 4, 2, 0, 0],
    [600, 7, 5, 0, 1], [660, 9, 6, 3, 0], [720, 9, 6, 3, 1], [750, 3, 2, 0, 4],
    [780, 2, 1, 0, 3], [810, 6, 5, 0, 1], [840, 8, 6, 4, 0], [900, 8, 6, 4, 0],
    [930, 8, 6, 0, 1], [1020, 7, 5, 0, 0], [1050, 5, 3, 0, 1], [1080, 3, 2, 0, 0],
    [1110, 0, 0, 0, 0], [DAY, 0, 0, 0, 0]
  ];

  var BAU_VARIANTS = {
    low: { label: 'Careful office', setpointC: 24, leftOnShare: 0.1 },
    mid: { label: 'Typical office', setpointC: 23, leftOnShare: 0.3 },
    high: { label: 'Careless office', setpointC: 22.5, leftOnShare: 0.5 }
  };
  var BAU_ON = 450, BAU_OFF = 1110; // 7:30 to 18:30 on weekdays
  var TARIFF = 0.30;                 // S$ per kWh, adjustable in the UI

  function rng(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var x = Math.imul(seed ^ seed >>> 15, 1 | seed);
      x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x;
      return ((x ^ x >>> 14) >>> 0) / 4294967296;
    };
  }

  function outdoorC(t) {
    var h = (t % DAY) / 60;
    return 29 + 3 * Math.sin(2 * Math.PI * (h - 8) / 24);
  }

  function scheduledHeadcount(zoneIdx, t) {
    var day = Math.floor(t / DAY) % 7;
    if (day >= 5) return 0;
    var m = t % DAY;
    for (var i = 1; i < SCHEDULE.length; i++) {
      if (m <= SCHEDULE[i][0]) {
        var a = SCHEDULE[i - 1], b = SCHEDULE[i];
        var f = (m - a[0]) / (b[0] - a[0]);
        return Math.round(a[zoneIdx + 1] + f * (b[zoneIdx + 1] - a[zoneIdx + 1]));
      }
    }
    return 0;
  }

  function isWorkHours(t) {
    var day = Math.floor(t / DAY) % 7, m = t % DAY;
    return day < 5 && m >= BAU_ON && m < BAU_OFF;
  }

  function stepTemp(T, people, coolingKw, t) {
    return T + (outdoorC(t) - T) * 0.01 + people * 0.012 - coolingKw * 0.09;
  }

  function coolingKw(zone, level) {
    return level > 0 ? 0.2 + (level / 100) * zone.acKw : 0;
  }

  function managedKw(zone, on, people, leftOnShare) {
    var share = on ? 1 : (leftOnShare || 0);
    var idle = (zone.desks * (zone.idlePerDeskKw || 0) + (zone.fixedManagedKw || 0)) * share;
    return idle + people * zone.activePerPersonKw;
  }

  function createSim(opts) {
    opts = opts || {};
    var engine = NerveEngine.createEngine(ZONES, opts.engineConfig);
    var random = rng(opts.seed || 42);
    var t = 0;
    var zones = ZONES.map(function (z) {
      return {
        def: z,
        manualPeople: null,       // demo override; null = follow schedule
        leftBehindDevices: z.id === 'A' ? 2 : 0, // a docked laptop and a desk phone stay connected overnight
        unmanagedKw: 0,           // e.g. a heater or kettle on an outlet NERVE doesn't control
        tempC: 27,
        bauTempC: { low: 27, mid: 27, high: 27 },
        people: 0, reading: null, decision: null,
        kw: 0, bauKw: { low: 0, mid: 0, high: 0 }
      };
    });

    var totals, today, history, log, lastDecision;
    function resetTotals() {
      return {
        nerveKwh: 0, bauKwh: { low: 0, mid: 0, high: 0 },
        nerveVacantKwh: 0, bauVacantKwh: 0,
        occupiedMin: 0, comfortMin: 0, bauComfortMin: 0
      };
    }
    totals = resetTotals(); today = resetTotals(); history = []; log = [];

    function peopleIn(z, idx) {
      return z.manualPeople !== null ? z.manualPeople : scheduledHeadcount(idx, t);
    }

    function tick() {
      if (t % DAY === 0) { today = resetTotals(); }
      var readings = {};
      zones.forEach(function (z, idx) {
        z.people = peopleIn(z, idx);
        var devices = Math.round(z.people * 1.8 + (z.people ? random() * 1.2 - 0.6 : 0));
        var missedMotion = z.people > 0 && z.people < 3 && random() < 0.25; // a still person can be missed
        z.reading = {
          motion: z.people > 0 && !missedMotion,
          wifiDevices: Math.max(0, devices) + z.leftBehindDevices,
          tempC: z.tempC,
          measuredKw: 0
        };
        var prev = z.decision;
        z.reading.measuredKw = z.def.essentialKw + z.unmanagedKw +
          managedKw(z.def, prev ? prev.powerOn : false, z.people, 0);
        readings[z.def.id] = z.reading;
      });

      var out = engine.step(readings, t);
      lastDecision = out;
      out.events.forEach(function (e) { log.unshift(e); });
      if (log.length > 200) log.length = 200;

      var nerveTotal = 0, bauTotal = { low: 0, mid: 0, high: 0 };
      zones.forEach(function (z) {
        var d = out.zones[z.def.id];
        z.decision = d;
        var ac = coolingKw(z.def, d.acLevel);
        z.kw = z.def.essentialKw + z.unmanagedKw + managedKw(z.def, d.powerOn, z.people, 0) + ac;
        z.tempC = stepTemp(z.tempC, z.people, ac, t);
        nerveTotal += z.kw;
        if (z.people === 0) { totals.nerveVacantKwh += (z.kw - z.def.essentialKw) / 60; today.nerveVacantKwh += (z.kw - z.def.essentialKw) / 60; }

        Object.keys(BAU_VARIANTS).forEach(function (k) {
          var v = BAU_VARIANTS[k];
          var work = isWorkHours(t);
          var level = (work && z.def.hasCooling !== false) ? Math.max(0, Math.min(100, 40 * (z.bauTempC[k] - v.setpointC) + 30)) : 0;
          var bac = coolingKw(z.def, level);
          var kw = z.def.essentialKw + z.unmanagedKw + managedKw(z.def, work, z.people, v.leftOnShare) + bac;
          z.bauTempC[k] = stepTemp(z.bauTempC[k], z.people, bac, t);
          z.bauKw[k] = kw;
          bauTotal[k] += kw;
          if (k === 'mid' && z.people === 0) { totals.bauVacantKwh += (kw - z.def.essentialKw) / 60; today.bauVacantKwh += (kw - z.def.essentialKw) / 60; }
        });

        if (z.people > 0 && z.def.hasCooling !== false) {
          [totals, today].forEach(function (acc) {
            acc.occupiedMin++;
            if (z.tempC <= 26) acc.comfortMin++;
            if (z.bauTempC.mid <= 26) acc.bauComfortMin++;
          });
        }
      });

      [totals, today].forEach(function (acc) {
        acc.nerveKwh += nerveTotal / 60;
        Object.keys(bauTotal).forEach(function (k) { acc.bauKwh[k] += bauTotal[k] / 60; });
      });

      if (t % 5 === 0) {
        history.push({ t: t, nerve: nerveTotal, bau: bauTotal.mid });
        if (history.length > 288) history.shift();
      }
      t++;
    }

    return {
      zones: zones,
      engine: engine,
      get t() { return t; },
      get totals() { return totals; },
      get today() { return today; },
      get history() { return history; },
      get log() { return log; },
      get lastDecision() { return lastDecision; },
      advance: function (minutes) { for (var i = 0; i < minutes; i++) tick(); },
      runTo: function (target) { while (t < target) tick(); },
      setPeople: function (zoneId, n) {
        var z = zones.find(function (x) { return x.def.id === zoneId; });
        z.manualPeople = n === null ? null : Math.max(0, n);
      },
      zone: function (zoneId) { return zones.find(function (x) { return x.def.id === zoneId; }); },
      boost: function (zoneId) { engine.requestBoost(zoneId, t); log.unshift({ t: t, zone: zoneId, type: 'boost', text: zoneById(zoneId).def.name + ': occupant asked for cooler air, setpoint lowered 1°C for 60 min' }); }
    };

    function zoneById(id) { return zones.find(function (x) { return x.def.id === id; }); }
  }

  function formatTime(t) {
    var day = DAYS[Math.floor(t / DAY) % 7];
    var m = t % DAY;
    var hh = String(Math.floor(m / 60)).padStart(2, '0');
    var mm = String(m % 60).padStart(2, '0');
    return day + ' ' + hh + ':' + mm;
  }

  return {
    createSim: createSim, ZONES: ZONES, BAU_VARIANTS: BAU_VARIANTS, TARIFF: TARIFF,
    DAY: DAY, formatTime: formatTime, outdoorC: outdoorC, scheduledHeadcount: scheduledHeadcount
  };
});
