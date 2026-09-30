/* NERVE dashboard: wires the simulator and engine to the page. */
(function () {
  'use strict';
  var S = window.NerveSim;
  var DAY = S.DAY;
  var $ = function (id) { return document.getElementById(id); };

  var sim, playing = true, speed = 15, carry = 0, period = 'today', activeScenario = null;
  var tariff = 0.30, plug = { type: 'tasmota', ip: '' };

  var SCENARIOS = [
    {
      id: 'morning', title: 'Morning arrival', hint: 'Mon 07:45, people trickle in',
      speed: 5, setup: function () { sim.runTo(7 * 60 + 45); },
      story: 'The office is empty, so cooling and desk power are off. Watch each zone switch on only when motion is detected, and cooling scale with the number of people rather than running flat out from 7:30.'
    },
    {
      id: 'lunch', title: 'Lunch dip', hint: 'Mon 12:20, most people leave',
      speed: 5, setup: function () { sim.runTo(12 * 60 + 20); },
      story: 'At 12:30 most people head to the pantry. The meeting room empties and its cooling stops after 10 minutes. The workstation zones keep a few people, so cooling drops to what they need.'
    },
    {
      id: 'evening', title: 'Everyone leaves', hint: 'Mon 18:10, the office empties',
      speed: 5, setup: function () { sim.runTo(18 * 60 + 10); },
      story: 'People leave by 18:30. Cooling stops 10 minutes after each zone empties, desk power 30 minutes after. Two devices stay connected in Workstations A overnight; NERVE ignores them because nobody has moved.'
    },
    {
      id: 'weekend', title: 'Weekend waste', hint: 'Sat 02:13, a heater was left on',
      speed: 5, period: 'week', setup: function () {
        sim.runTo(4 * DAY + 17 * 60 + 45);
        sim.zone('B').unmanagedKw = 1.8;
        sim.runTo(5 * DAY + 2 * 60 + 13);
      },
      story: 'Someone left a 1.8 kW heater plugged into a wall outlet in Workstations B on Friday. The office is empty and NERVE has learned what an empty office draws, so it flags the zone and names the likely source.'
    },
    {
      id: 'live', title: 'Live demo', hint: 'Empty room, you control people',
      speed: 1, setup: function () {
        sim.runTo(DAY + 10 * 60);
        ['A', 'B', 'M', 'P'].forEach(function (id) { sim.setPeople(id, 0); sim.zone(id).leftBehindDevices = 0; });
        $('short-timers').checked = true; applyTimers();
      },
      story: 'Schedules are off and short timers are on. Use + and − on a zone to walk people in and out: power comes on at once, and switches off 3 minutes (sim time) after the last person leaves.'
    }
  ];

  function newSim() {
    sim = S.createSim({ seed: 42 });
    applyTimers();
  }

  function applyTimers() {
    var short = $('short-timers').checked;
    var cfg = sim.engine.config;
    cfg.powerGraceMin = short ? 3 : 30;
    cfg.coolingGraceMin = short ? 2 : 10;
  }

  /* ---------- rendering ---------- */

  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function buildZones() {
    var box = $('zones');
    box.innerHTML = '';
    sim.zones.forEach(function (z) {
      var id = z.def.id;
      var card = el('article', { class: 'zone', id: 'zone-' + id, 'aria-label': z.def.name });
      card.innerHTML =
        '<div class="zone-head"><h3 title="' + z.def.name + '">' + z.def.name + '</h3><span class="pill" data-f="pill"></span>' +
          '<span class="conf" data-f="conf"><span class="bars" aria-hidden="true"><i></i><i></i><i></i></span><span data-f="conf-text"></span></span></div>' +
        '<div class="row"><span class="layer">Sense</span><div><div class="readouts" data-f="sense"></div><p class="note clamp2" data-f="note"></p></div></div>' +
        '<div class="row"><span class="layer">Think</span><div><div class="readouts" data-f="think"></div><p class="note clamp2" data-f="why"></p></div></div>' +
        '<div class="row"><span class="layer">Act</span><div data-f="act" style="display:grid;gap:6px"></div></div>' +
        '<div class="zone-controls">' +
          '<span class="people"><button type="button" data-a="minus" aria-label="One person leaves ' + z.def.name + '">−</button>' +
          '<span class="num" data-f="people"></span>' +
          '<button type="button" data-a="plus" aria-label="One person enters ' + z.def.name + '">+</button></span>' +
          '<button type="button" data-a="auto">Follow schedule</button>' +
          '<button type="button" data-a="device">Leave a phone</button>' +
          (z.def.hasCooling === false ? '' : '<button type="button" data-a="boost">Too warm</button>') +
          '<button type="button" data-a="heater" aria-pressed="false">Heater on outlet</button>' +
        '</div>';
      card.addEventListener('click', function (ev) {
        var b = ev.target.closest('button');
        if (!b) return;
        var a = b.getAttribute('data-a');
        var z = sim.zone(id); // the sim is rebuilt by scenarios, so look the zone up each time
        if (a === 'plus') sim.setPeople(id, z.people + 1);
        if (a === 'minus') sim.setPeople(id, z.people - 1);
        if (a === 'auto') sim.setPeople(id, null);
        if (a === 'device') z.leftBehindDevices = z.leftBehindDevices ? 0 : 1;
        if (a === 'boost') sim.boost(id);
        if (a === 'heater') z.unmanagedKw = z.unmanagedKw ? 0 : 1.8;
        render();
      });
      box.appendChild(card);
    });
  }

  function fmtMin(m) {
    if (m >= 120) return Math.floor(m / 60) + ' h';
    return Math.round(m) + ' min';
  }

  function renderZones() {
    sim.zones.forEach(function (z) {
      var card = $('zone-' + z.def.id);
      var f = function (n) { return card.querySelector('[data-f="' + n + '"]'); };
      var d = z.decision, r = z.reading;
      if (!d) return;
      var pill = f('pill');
      if (d.anomaly) { pill.className = 'pill crit'; pill.textContent = 'Waste detected'; }
      else if (d.occupied) { pill.className = 'pill occ'; pill.textContent = 'Occupied'; }
      else { pill.className = 'pill vac'; pill.textContent = 'Empty ' + fmtMin(d.vacantMin === Infinity ? 999 : d.vacantMin); }
      f('conf').setAttribute('data-level', d.confidence);
      f('conf-text').textContent = d.confidence.charAt(0).toUpperCase() + d.confidence.slice(1) + ' confidence ' + (d.occupied ? 'someone is here' : 'zone is empty');
      card.classList.toggle('alert', !!d.anomaly);

      f('sense').innerHTML =
        '<span><i class="dot' + (r.motion ? ' on' : '') + '"></i>Motion</span>' +
        '<span><span class="k">Wi-Fi</span> <span class="num">' + r.wifiDevices + '</span> devices</span>' +
        (z.def.hasCooling === false ? '' : '<span><span class="num">' + r.tempC.toFixed(1) + '</span>°C</span>') +
        '<span><span class="num">' + z.kw.toFixed(2) + '</span> kW</span>';
      f('note').textContent = d.note;
      f('note').title = d.note;

      var manual = z.manualPeople !== null;
      f('think').innerHTML =
        '<span>Estimated <span class="num">' + d.headcount + '</span> people</span>' +
        '<span class="k">(actually ' + z.people + (manual ? ', set by you' : '') + ')</span>';
      f('why').textContent = d.reasons.join('. ');
      f('why').title = d.reasons.join('. ');

      var power;
      if (d.powerOn && d.powerCountdownMin !== null) power = '<span class="state-wait">Off in ' + Math.ceil(d.powerCountdownMin) + ' min</span>';
      else power = d.powerOn ? '<span class="state-on">On</span>' : '<span class="state-off">Off</span>';
      var act = '<div class="act-line"><span class="k">Plug power</span>' + power +
        '<span class="k">Essential circuits</span><span class="state-on">Always on</span></div>';
      if (z.def.hasCooling !== false) {
        act += '<div class="act-line"><span class="k">Cooling</span><span class="num">' + String(d.acLevel).padStart(3, ' ') + '%</span>' +
          '<span class="meter" aria-hidden="true"><i style="width:' + d.acLevel + '%"></i></span></div>';
      }
      if (z.unmanagedKw) act += '<div class="act-line"><span class="state-wait">Unmanaged outlet drawing ' + z.unmanagedKw.toFixed(1) + ' kW</span></div>';
      f('act').innerHTML = act;
      f('people').textContent = z.people;
      card.querySelector('[data-a="heater"]').setAttribute('aria-pressed', z.unmanagedKw ? 'true' : 'false');
      card.querySelector('[data-a="device"]').textContent = z.leftBehindDevices ? 'Pick up devices' : 'Leave a phone';
    });
  }

  function renderKpis() {
    var acc = period === 'today' ? sim.today : sim.totals;
    var n = acc.nerveKwh, b = acc.bauKwh;
    var save = function (x) { return Math.max(0, x - n); };
    var pct = function (x) { return x > 0 ? Math.round(100 * save(x) / x) : 0; };
    var comfort = acc.occupiedMin ? Math.round(100 * acc.comfortMin / acc.occupiedMin) : null;
    var bauComfort = acc.occupiedMin ? Math.round(100 * acc.bauComfortMin / acc.occupiedMin) : null;
    var money = function (kwh) { return 'S$' + (kwh * tariff).toFixed(2); };
    $('kpis').innerHTML =
      tile('Energy used', n.toFixed(1) + ' kWh', 'Business as usual ' + b.low.toFixed(1) + ' to ' + b.high.toFixed(1) + ' kWh') +
      tile('Saved', save(b.mid).toFixed(1) + ' kWh', 'Range ' + save(b.low).toFixed(1) + ' to ' + save(b.high).toFixed(1) + ' kWh (' + pct(b.low) + ' to ' + pct(b.high) + '%) · ' + money(save(b.low)) + ' to ' + money(save(b.high)), true) +
      tile('Used in empty zones', acc.nerveVacantKwh.toFixed(1) + ' kWh', 'Business as usual ' + acc.bauVacantKwh.toFixed(1) + ' kWh (typical office)') +
      tile('Comfortable', comfort === null ? 'No one in yet' : comfort + '%', comfort === null ? 'Share of occupied minutes at or below 26°C' : 'of occupied minutes at or below 26°C · BAU ' + bauComfort + '%');
    function tile(label, value, sub, hero) {
      return '<div class="kpi' + (hero ? ' hero' : '') + '"><span class="label">' + label + '</span><span class="value">' + value + '</span><span class="sub">' + sub + '</span></div>';
    }
  }

  /* Power chart: total office kW, last 24 h, NERVE vs BAU. */
  var W = 560, H = 200, PAD = { l: 34, r: 8, t: 10, b: 22 };
  function renderChart() {
    var h = sim.history, svg = $('chart');
    if (h.length < 2) { svg.innerHTML = ''; return; }
    var maxY = Math.max(4, Math.ceil(Math.max.apply(null, h.map(function (p) { return Math.max(p.nerve, p.bau); })) / 2) * 2);
    var t0 = h[h.length - 1].t - 1435;
    var x = function (t) { return PAD.l + (t - t0) / 1435 * (W - PAD.l - PAD.r); };
    var y = function (v) { return H - PAD.b - v / maxY * (H - PAD.t - PAD.b); };
    var out = '';
    for (var v = 0; v <= maxY; v += maxY / 4) {
      out += '<line class="grid" x1="' + PAD.l + '" x2="' + (W - PAD.r) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>';
      out += '<text x="' + (PAD.l - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + v + '</text>';
    }
    // hour ticks every 6 h
    var first = Math.ceil(t0 / 360) * 360;
    for (var tt = first; tt <= h[h.length - 1].t; tt += 360) {
      if (tt < t0 || tt < 0) continue;
      out += '<text x="' + x(tt) + '" y="' + (H - 6) + '" text-anchor="middle">' + S.formatTime(tt) + '</text>';
    }
    var line = function (key) {
      return h.filter(function (p) { return p.t >= t0; }).map(function (p, i) { return (i ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(p[key]).toFixed(1); }).join('');
    };
    out += '<path d="' + line('bau') + '" fill="none" stroke="var(--series-bau)" stroke-width="2" stroke-linejoin="round"/>';
    out += '<path d="' + line('nerve') + '" fill="none" stroke="var(--series-nerve)" stroke-width="2" stroke-linejoin="round"/>';
    var last = h[h.length - 1];
    out += '<circle cx="' + x(last.t) + '" cy="' + y(last.nerve) + '" r="4" fill="var(--series-nerve)" stroke="var(--surface)" stroke-width="2"/>';
    out += '<line id="xhair" class="grid" y1="' + PAD.t + '" y2="' + (H - PAD.b) + '" x1="-10" x2="-10" style="stroke:var(--muted)"/>';
    out += '<rect x="' + PAD.l + '" y="0" width="' + (W - PAD.l - PAD.r) + '" height="' + H + '" fill="transparent" id="hit"/>';
    svg.innerHTML = out;
    svg._scale = { t0: t0, x: x };
  }

  function chartHover(ev) {
    var svg = $('chart'), sc = svg._scale, tip = $('tip');
    if (!sc) return;
    var rect = svg.getBoundingClientRect();
    var px = (ev.clientX - rect.left) / rect.width * W;
    var t = sc.t0 + (px - PAD.l) / (W - PAD.l - PAD.r) * 1435;
    var h = sim.history, best = null;
    h.forEach(function (p) { if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p; });
    if (!best || px < PAD.l) { tip.hidden = true; return; }
    var xh = svg.querySelector('#xhair');
    if (xh) { xh.setAttribute('x1', sc.x(best.t)); xh.setAttribute('x2', sc.x(best.t)); }
    tip.hidden = false;
    tip.innerHTML = '<b class="mono">' + S.formatTime(best.t) + '</b><br>' +
      '<i class="swatch" style="background:var(--series-nerve)"></i>NERVE <span class="num">' + best.nerve.toFixed(2) + ' kW</span><br>' +
      '<i class="swatch" style="background:var(--series-bau)"></i>Business as usual <span class="num">' + best.bau.toFixed(2) + ' kW</span>';
    var wrap = $('chart-wrap').getBoundingClientRect();
    var left = ev.clientX - wrap.left + 12;
    if (left + 200 > wrap.width) left = ev.clientX - wrap.left - 212;
    tip.style.left = Math.max(0, left) + 'px';
    tip.style.top = (ev.clientY - wrap.top - 20) + 'px';
  }

  function renderAlerts() {
    var active = sim.zones.filter(function (z) { return z.decision && z.decision.anomaly; });
    var box = $('alerts');
    if (!active.length) {
      box.innerHTML = '<p class="quiet">No waste detected. NERVE compares each empty zone with what it has learned an empty zone normally draws.</p>';
      return;
    }
    var totalPeople = sim.zones.reduce(function (s, z) { return s + z.decision.headcount; }, 0);
    var expected = sim.zones.reduce(function (s, z) { return s + (z.decision.anomaly ? z.decision.anomaly.expectedKw : z.kw); }, 0);
    var actual = sim.zones.reduce(function (s, z) { return s + z.kw; }, 0);
    box.innerHTML =
      '<div class="alert-card"><strong>Abnormal consumption · ' + S.formatTime(sim.t) + '</strong>' +
      '<div class="alert-grid">' +
        '<div><div class="k">Occupancy</div><span class="num">' + totalPeople + '</span></div>' +
        '<div><div class="k">Expected</div><span class="num">' + expected.toFixed(2) + ' kW</span></div>' +
        '<div><div class="k">Actual</div><span class="num">' + actual.toFixed(2) + ' kW</span></div>' +
      '</div>' +
      active.map(function (z) {
        var a = z.decision.anomaly;
        return '<div>Possible source: <b>' + z.def.name + '</b>, since ' + S.formatTime(a.since) +
          '. Desk circuits there are already off, so this is an outlet NERVE does not control. Office manager notified.</div>';
      }).join('') +
      '</div>';
  }

  function renderLog() {
    $('log').innerHTML = sim.log.slice(0, 40).map(function (e) {
      return '<li><span class="when mono">' + S.formatTime(e.t) + '</span><span class="' + e.type + '">' + e.text + '</span></li>';
    }).join('') || '<li><span></span><span class="quiet">Decisions appear here as NERVE makes them.</span></li>';
  }

  function render() {
    $('clock').textContent = S.formatTime(sim.t);
    $('weather').textContent = 'Outdoor ' + S.outdoorC(sim.t).toFixed(0) + '°C';
    renderZones(); renderKpis(); renderChart(); renderAlerts(); renderLog();
  }

  /* ---------- real smart plug ---------- */
  var lastPlugState = null;
  function plugUrl(on) {
    if (!plug.ip) return null;
    var base = 'http://' + plug.ip.trim();
    if (plug.type === 'tasmota') return base + '/cm?cmnd=Power%20' + (on ? 'On' : 'Off');
    if (plug.type === 'shelly1') return base + '/relay/0?turn=' + (on ? 'on' : 'off');
    return base + '/rpc/Switch.Set?id=0&on=' + (on ? 'true' : 'false');
  }
  function sendPlug(on) {
    var url = plugUrl(on);
    if (!url) return;
    fetch(url, { mode: 'no-cors' })
      .then(function () { $('plug-status').textContent = 'Sent ' + (on ? 'ON' : 'OFF') + ' to ' + plug.ip; })
      .catch(function () { $('plug-status').textContent = 'Could not reach ' + plug.ip + '. Check the IP and that this page was opened from disk.'; });
  }
  function syncPlug() {
    var d = sim.zone('A').decision;
    if (!d || !plug.ip) return;
    if (d.powerOn !== lastPlugState) { lastPlugState = d.powerOn; sendPlug(d.powerOn); }
  }

  /* ---------- loop + controls ---------- */
  function loop() {
    if (playing) {
      carry += speed / 4;
      var n = Math.floor(carry);
      carry -= n;
      if (n) { sim.advance(n); syncPlug(); render(); }
    }
  }

  function runScenario(sc) {
    newSim();
    $('short-timers').checked = false; applyTimers();
    sc.setup();
    activeScenario = sc.id;
    speed = sc.speed; $('speed').value = String(sc.speed);
    playing = true; $('play').textContent = 'Pause';
    period = sc.period || 'today'; setPeriodButtons();
    $('story').textContent = sc.story;
    document.querySelectorAll('.scenario').forEach(function (b) { b.classList.toggle('active', b.dataset.id === sc.id); });
    render();
  }

  function setPeriodButtons() {
    $('p-today').setAttribute('aria-pressed', period === 'today');
    $('p-week').setAttribute('aria-pressed', period === 'week');
  }

  function init() {
    $('scenarios').innerHTML = SCENARIOS.map(function (s) {
      return '<button type="button" class="scenario" data-id="' + s.id + '"><b>' + s.title + '</b><span>' + s.hint + '</span></button>';
    }).join('');
    $('scenarios').addEventListener('click', function (ev) {
      var b = ev.target.closest('.scenario');
      if (b) runScenario(SCENARIOS.find(function (s) { return s.id === b.dataset.id; }));
    });
    $('play').addEventListener('click', function () { playing = !playing; this.textContent = playing ? 'Pause' : 'Play'; });
    $('speed').addEventListener('change', function () { speed = Number(this.value); });
    $('reset').addEventListener('click', function () {
      newSim(); sim.runTo(7 * 60); activeScenario = null;
      document.querySelectorAll('.scenario').forEach(function (b) { b.classList.remove('active'); });
      $('story').textContent = 'Monday morning. Let the week run, or pick a scenario.';
      render();
    });
    $('p-today').addEventListener('click', function () { period = 'today'; setPeriodButtons(); renderKpis(); });
    $('p-week').addEventListener('click', function () { period = 'week'; setPeriodButtons(); renderKpis(); });
    $('short-timers').addEventListener('change', applyTimers);
    $('tariff').addEventListener('input', function () { var v = Number(this.value); if (v >= 0) { tariff = v; renderKpis(); } });
    $('plug-type').addEventListener('change', function () { plug.type = this.value; lastPlugState = null; });
    $('plug-ip').addEventListener('change', function () { plug.ip = this.value; lastPlugState = null; syncPlug(); });
    $('plug-test').addEventListener('click', function () { lastPlugState = !lastPlugState; sendPlug(lastPlugState); });
    var svg = $('chart');
    svg.addEventListener('pointermove', chartHover);
    svg.addEventListener('pointerleave', function () { $('tip').hidden = true; var xh = svg.querySelector('#xhair'); if (xh) { xh.setAttribute('x1', -10); xh.setAttribute('x2', -10); } });

    newSim();
    buildZones();
    // Open on a realistic working state: mid-morning Monday with the day's history on the chart.
    sim.runTo(10 * 60 + 30);
    render();
    setInterval(loop, 250);
  }

  init();
})();
