// Ceļa Zīmes — OSM zīmes (Overpass), OSM dati pa šūnām telefona kešatmiņā, laika ierobežojumi.
// B16 (audits 2): pārcelts no app-gl.js bez izmaiņām (tas pats globālais tvērums — klasisks skripts, ne modulis).
// Ielādējas PĒC app-gl.js un PIRMS app-start.js (kas izsauc init()): augšējā līmeņa kods šeit drīkst izmantot visu no
// app-gl.js; app-gl.js augšējā līmenī (ārpus funkcijām) šī faila nosaukumus izmantot nedrīkst. Pārbaude: tools/check-js.mjs.

// ---------- OpenStreetMap zīmes (Overpass) ----------
function buildQuery(s, w, n, e) {
  const bb = `${s},${w},${n},${e}`;
  return `[out:json][timeout:25];
(
  node["traffic_sign"](${bb});
  node["highway"~"^(stop|give_way|traffic_signals|crossing|speed_camera)$"](${bb});
  node["traffic_calming"](${bb});
  node["railway"="level_crossing"](${bb});
  node["hazard"](${bb});
  way["hazard"]["highway"](${bb});
  way["highway"="construction"](${bb});
  way["highway"]["maxspeed"](${bb});
  way["highway"]["maxspeed:type"](${bb});
  way["highway"]["source:maxspeed"](${bb});
  way["highway"="living_street"](${bb});
  way["highway"]["maxspeed:conditional"](${bb});
  way["highway"]["access:conditional"](${bb});
  way["highway"]["motor_vehicle:conditional"](${bb});
  way["highway"]["parking:both:restriction:conditional"](${bb});
  way["highway"]["parking:left:restriction:conditional"](${bb});
  way["highway"]["parking:right:restriction:conditional"](${bb});
  relation["type"="restriction"]["restriction:conditional"](${bb});
  relation["type"="restriction"]["hour_on"](${bb});
);
out body geom;`;
}

// A13: Overpass „ar rezervi” — vispirms veselākais serveris (nav pauzē, mazāk kļūmju, ātrāks); otru jautā tikai tad,
// ja pirmais neatbild OVERPASS_HEDGE_MS laikā vai kļūdās. Agrāk jautāja abiem reizē — divreiz lielāka slodze bezmaksas
// serveriem. Ilgāk par timeoutMs negaida. Vienādi vaicājumi, kas notiek vienlaikus, tiek sūtīti tikai vienreiz.
const OVERPASS_HEDGE_MS = 4000;
function overpassOrder(urls) {
  // czNetHealth — netguard.js funkcija (B04: window.czNet citos skriptos aizsedz netguard.js iekšējais const czNet, tāpēc tieši funkcija)
  const h = u => typeof czNetHealth === 'function' ? czNetHealth(new URL(u).hostname) : { cooling: false, fail: 0, avgMs: 0 };
  return urls.map((u, i) => ({ u, i, ...h(u) }))
    .sort((a, b) => (a.cooling - b.cooling) || (a.fail - b.fail) || ((a.avgMs || 1e9) - (b.avgMs || 1e9)) || (a.i - b.i))
    .map(x => x.u);
}
function fetchOverpass(query, timeoutMs = 35000) {
  return onceInflight('ovp|' + query, () => new Promise((resolve, reject) => {
    const urls = overpassOrder(OVERPASS_URLS), controllers = [], errors = [];
    let started = 0, done = false, hedge = null;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); clearTimeout(hedge); controllers.forEach(c => c.abort()); fn(v); };
    const timer = setTimeout(() => finish(reject, new Error('Overpass neatbildēja ' + Math.round(timeoutMs / 1000) + ' s')), timeoutMs);
    const start = () => {
      if (done || started >= urls.length) return;
      const i = started++, ctrl = new AbortController();
      controllers.push(ctrl);
      clearTimeout(hedge);
      if (started < urls.length) hedge = setTimeout(start, OVERPASS_HEDGE_MS);
      fetch(urls[i], { method: 'POST', body: 'data=' + encodeURIComponent(query), signal: ctrl.signal })
        .then(async res => { if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status }); return res.json(); })
        .then(json => finish(resolve, json))
        .catch(err => {
          if (done) return;
          errors.push(err);
          if (started < urls.length) start();                       // kļūda — uzreiz rezerves serveris
          else if (errors.length >= started) finish(reject, errors[errors.length - 1]);
        });
    };
    start();
  }));
}

// ---------- OSM dati pa šūnām telefona kešatmiņā ----------
// Katru ~1 km šūnu glabā 3 dienas: atkārtoti atverot to pašu vietu, zīmes parādās uzreiz bez Overpass.
const OSM_CELL_MAX_AGE = 3 * 24 * 3600 * 1000;
function osmElementBox(el) {
  let s = 90, w = 180, n = -90, e = -180, any = false;
  const add = (la, lo) => { if (la == null || lo == null) return; any = true; s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); };
  add(el.lat, el.lon);
  for (const g of el.geometry || []) add(g.lat, g.lon);
  for (const m of el.members || []) { add(m.lat, m.lon); for (const g of m.geometry || []) add(g.lat, g.lon); }
  return any ? [s, w, n, e] : null;
}
// Sadala Overpass elementus pa šūnām (elements, kas šķērso vairākas šūnas, nonāk katrā no tām).
function splitByCells(elements, cells) {
  const out = new Map(cells.map(c => [c, []]));
  for (const el of elements) {
    const b = osmElementBox(el);
    if (!b) continue;
    for (let la = Math.floor(b[0] / CELL); la <= Math.floor(b[2] / CELL); la++)
      for (let lo = Math.floor(b[1] / CELL); lo <= Math.floor(b[3] / CELL); lo++) {
        const arr = out.get(la + ':' + lo);
        if (arr) arr.push(el);
      }
  }
  return out;
}

function processOsmElements(elements) {
  let added = 0;
  for (const el of elements || []) {
    if (el.type !== 'node') readTimeRules(el);
    readOsmAlert(el);
    if (el.type === 'node') {
      if (state.seenNodes.has(el.id)) continue;
      state.seenNodes.add(el.id);
      const sign = classifyNode(el.tags);
      if (sign && addSign(el.lat, el.lon, sign)) added++;
    } else if (el.type === 'way' && el.geometry && !state.ways.has(el.id)) {
      // F7: arī ceļi bez maxspeed, bet ar Latvijas noklusējumu (maxspeed:type / source:maxspeed = LV:urban/rural)
      // vai dzīvojamā zona — tiem ātrums ir aptuvens (implicit), un zīmi kartē neliek.
      const explicit = parseMaxspeed(el.tags.maxspeed);
      const typ = String(el.tags['maxspeed:type'] || el.tags['source:maxspeed'] || '').toLowerCase();
      const zone = /urban/.test(typ) ? 'urban' : /rural/.test(typ) ? 'rural' : null;
      const limit = explicit || (el.tags.highway === 'living_street' ? 20 : parseMaxspeed(typ));
      if (!limit) continue;
      const pts = el.geometry.map(p => [p.lat, p.lon]);
      state.ways.set(el.id, { limit, pts });
      indexWay(limit, pts, speedCondition(el.tags), { implicit: !explicit, zone });
      if (explicit) added += addWaySpeedSign(pts, limit);
    }
  }
  return added;
}
function osmApplied(added) {
  attachTimesSoon();
  state.counts.osm += added;
  signs.refresh();
  showCounts();
  updateLimit();
}

async function loadOsmForView() {
  if (state.loading || map.getZoom() < MIN_SIGN_ZOOM) return;
  const [vs, vw, vn, ve] = viewBox(0.2);
  const cells = [];
  for (let la = Math.floor(vs / CELL); la <= Math.floor(vn / CELL); la++)
    for (let lo = Math.floor(vw / CELL); lo <= Math.floor(ve / CELL); lo++) cells.push(la + ':' + lo);
  let missing = cells.filter(c => !state.loadedCells.has(c));
  if (!missing.length || missing.length > MAX_CELLS) return;

  state.loading = true;
  try {
    // 1) No telefona kešatmiņas — uzreiz
    const cached = await Promise.all(missing.map(c => cacheGet('osm', c, OSM_CELL_MAX_AGE)));
    let added = 0;
    missing.forEach((c, i) => { if (cached[i]) { added += processOsmElements(cached[i]); state.loadedCells.add(c); } });
    if (added || cached.some(Boolean)) osmApplied(added);
    missing = missing.filter((c, i) => !cached[i]);
    if (!missing.length) { state.osmRetryMs = 0; setTimeout(loadOsmForView, 100); return; }

    // 2) Pārējās šūnas no Overpass
    const las = missing.map(c => +c.split(':')[0]), los = missing.map(c => +c.split(':')[1]);
    const s = Math.min(...las) * CELL, n = (Math.max(...las) + 1) * CELL;
    const w = Math.min(...los) * CELL, e = (Math.max(...los) + 1) * CELL;
    if (!state.mlyToken) setBusy('osm', 'Ielādē ceļa zīmes…');
    const data = await fetchOverpass(buildQuery(s.toFixed(4), w.toFixed(4), n.toFixed(4), e.toFixed(4)));
    osmApplied(processOsmElements(data.elements));
    const parts = splitByCells(data.elements || [], missing);
    for (const c of missing) { state.loadedCells.add(c); cachePut('osm', c, parts.get(c)); }
    state.osmRetryMs = 0;
    setTimeout(loadOsmForView, 100);
  } catch (err) {
    console.warn('OSM zīmes nav ielādētas', err);
    state.osmRetryMs = Math.min(120000, (state.osmRetryMs || 5000) * 2);
    setTimeout(loadOsmForView, state.osmRetryMs);
  } finally {
    state.loading = false;
    setBusy('osm', null);
  }
}

// Ceļiem ar ātruma ierobežojumu uzliek zīmi ceļa sākumā (ja tuvumā nav tādas pašas).
const placedSpeed = [];
function addWaySpeedSign(pts, limit) {
  if (pts.length < 2 || pathLength(pts) < 120) return 0;
  const at = pointAlong(pts, 25);
  if (placedSpeed.some(p => p.limit === limit && distM(p.lat, p.lng, at[0], at[1]) < 250)) return 0;
  placedSpeed.push({ lat: at[0], lng: at[1], limit });
  const s = addSign(at[0], at[1], { cat: 'speed', kind: 'speed', value: limit, title: `Ātruma ierobežojums ${limit} km/h` });
  if (s) s.wayStart = true;           // F7: OSM maxspeed attēlojums, nevis fiziska zīme — zīmju atmiņā neņem
  return s ? 1 : 0;
}
function pathLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += distM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  return d;
}
function pointAlong(pts, meters) {
  let left = meters;
  for (let i = 1; i < pts.length; i++) {
    const seg = distM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    if (seg >= left) {
      const t = left / seg;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
    }
    left -= seg;
  }
  return pts[pts.length - 1];
}

// Ātruma ierobežojums zem manis: ceļu posmi nelielās šūnās.
const WAY_CELL = 0.002;
const wayGrid = new Map();
function indexWay(limit, pts, cond, meta = {}) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const la0 = Math.floor(Math.min(a[0], b[0]) / WAY_CELL), la1 = Math.floor(Math.max(a[0], b[0]) / WAY_CELL);
    const lo0 = Math.floor(Math.min(a[1], b[1]) / WAY_CELL), lo1 = Math.floor(Math.max(a[1], b[1]) / WAY_CELL);
    for (let la = la0; la <= la1; la++) for (let lo = lo0; lo <= lo1; lo++) {
      const k = la + ':' + lo;
      if (!wayGrid.has(k)) wayGrid.set(k, []);
      wayGrid.get(k).push([a, b, limit, cond, meta]);
    }
  }
}
function distToSegment(p, a, b) {
  const k = 111320, c = Math.cos(p[0] * Math.PI / 180);
  const ax = (a[1] - p[1]) * k * c, ay = (a[0] - p[0]) * k;
  const bx = (b[1] - p[1]) * k * c, by = (b[0] - p[0]) * k;
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
// Ātrums no OSM ceļa. Ņem ceļu, uz kura ESMU (kartes piesaistes punkts, ceļa virziens sakrīt
// ar kursu), nevis vienkārši tuvāko — citādi pie paralēlas ielas rādītu tās ātrumu.
// F7: piesaistes punkts (vektorkartes ceļš) un Overpass ģeometrija bieži atšķiras par > 8 m, tāpēc pielaide 20 m;
// virzienu ņem no kartes ceļa (līkumos GPS kurss atpaliek), pielaide 45°.
// Atgriež { limit, implicit, zone } vai null; zoneNear — tuvākā (≤ 150 m) ceļa LV:urban / LV:rural atzīme.
const LIMIT_MATCH_M = 20, LIMIT_FREE_M = 30, LIMIT_AXIS_DEG = 45, ZONE_NEAR_M = 150;
function nearestLimit(lat, lng, heading = null, matched = null) {
  if (matched) { lat = matched.P[1]; lng = matched.P[0]; if (matched.dir != null) heading = matched.dir; }
  let best = null, bestD = matched ? LIMIT_MATCH_M : LIMIT_FREE_M, zone = null, zoneD = ZONE_NEAR_M;
  const la = Math.floor(lat / WAY_CELL), lo = Math.floor(lng / WAY_CELL);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    for (const [a, b, limit, cond, meta = {}] of wayGrid.get((la + i) + ':' + (lo + j)) || []) {
      const d = distToSegment([lat, lng], a, b);
      if (meta.zone && d < zoneD) { zoneD = d; zone = meta.zone; }
      if (heading != null) {
        const ax = angleDiff(bearingDeg(a[0], a[1], b[0], b[1]), heading);
        if (Math.min(ax, 180 - ax) > LIMIT_AXIS_DEG) continue;     // šķērsiela
      }
      // Mainīgs ātrums (piem. 30 darbdienās 7–22): tagad spēkā esošais.
      if (d < bestD) { bestD = d; best = { limit: cond && cond.test(new Date()) ? cond.limit : limit, implicit: !!meta.implicit, zone: meta.zone || null }; }
    }
  }
  if (best) best.zoneNear = zone; else if (zone) return { limit: null, zoneNear: zone };
  return best;
}

// F7: apdzīvota vieta pēc kartes (vektorkartes "place" punkti jau ielādētajās flīzēs — bez jauniem pieprasījumiem).
// true — tuvumā pilsēta / ciems / pilsētas daļa; false — vietu dati ir, bet tuvumā nav; null — nav zināms.
// Rādiusi pēc Latvijas apdzīvoto vietu lieluma (ciemi mazi — 1 km no centra parasti jau ir ārpus ciema)
const PLACE_RADIUS_M = { city: 8000, town: 2000, village: 600, suburb: 1500, quarter: 1000, neighbourhood: 800 };
let placeCache = null;
function placeUrban(lat, lng) {
  const now = Date.now();
  if (!placeCache || now - placeCache.at > 30000 || distM(placeCache.lat, placeCache.lng, lat, lng) > 500) {
    let feats = [];
    try { if (map.getSource('openmaptiles')) feats = map.querySourceFeatures('openmaptiles', { sourceLayer: 'place' }); } catch { feats = []; }
    placeCache = { at: now, lat, lng, pts: feats.filter(f => PLACE_RADIUS_M[f.properties.class] && f.geometry && f.geometry.type === 'Point')
      .map(f => ({ cls: f.properties.class, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] })) };
  }
  if (!placeCache.pts.length) return null;
  return placeCache.pts.some(p => distM(p.lat, p.lng, lat, lng) <= PLACE_RADIUS_M[p.cls]);
}

// F7: spēkā esošais ierobežojums ar navigāciju vai bez tās → { limit, source: 'sign'|'osm'|'default', approx } vai null.
//   a) garām pabraukta ātruma zīme uz mana ceļa manā virzienā (bez maršruta — SignStore atmiņa);
//   b) OSM maxspeed ceļam, uz kura esmu;
//   c) Latvijas noklusējums (aptuveni): apdzīvotā vietā 50, ārpus 90, dzīvojamā zonā 20.
// Navigācijā kā līdz šim: vispirms OSM, tad pēdējā maršruta zīme (lastRouteSignBefore), tad noklusējums.
const speedMemoOsm = { s: null, limit: null };   // v128: OSM limit at the moment the remembered sign was passed
function resolveSpeedLimit() {
  if (!state.me) return null;
  const pos = signs.pos && !signs.pos.uncertain ? signs.pos : null;
  const osm = nearestLimit(state.me.lat, state.me.lng, state.heading, pos);
  const explicitOsm = osm && osm.limit && !osm.implicit ? osm : null;
  let sign = null;
  if (state.nav.active) {
    if (!explicitOsm && state.nav.along != null) {
      const last = signs.lastRouteSignBefore(state.nav.along + 10, 2000, x => x.cat === 'speed' && x.limit);
      if (last) sign = last.s.limit;
    }
  } else {
    const mem = signs.speedMemory && signs.speedMemory();
    if (mem) {
      // v128: remember what OSM said where the sign was passed. If OSM later shows a DIFFERENT explicit limit
      // on my road (e.g. 50 → 70 where the 70 sign is missing from the sign data), the zone has changed — OSM wins.
      if (speedMemoOsm.s !== mem.s) { speedMemoOsm.s = mem.s; speedMemoOsm.limit = explicitOsm ? explicitOsm.limit : null; }
      if (!(explicitOsm && explicitOsm.limit !== speedMemoOsm.limit)) sign = mem.limit;
    }
  }
  if (state.nav.active && explicitOsm) return { limit: explicitOsm.limit, source: 'osm', approx: false };
  let urban = null;
  const set = signs.settlement;
  if (set && set.s && distM(set.s.lat, set.s.lng, state.me.lat, state.me.lng) < 20000) urban = set.urban;
  else if (osm && (osm.zone || osm.zoneNear)) urban = (osm.zone || osm.zoneNear) === 'urban';
  else urban = placeUrban(state.me.lat, state.me.lng);
  return decideSpeedLimit({ sign, osm: osm && osm.limit ? osm : null, urban, cls: pos ? pos.cls : null });
}
const speedHold = new SpeedLimitHold();
let limitKey = '', overNow = false;
function updateLimit() {
  // v122: apaļais rādītājs rāda MANU ātrumu; atļauto izmanto tikai brīdinājumam (sarkans + pulsē)
  const badge = $('limitBadge');
  if (!state.me) { badge.hidden = true; document.documentElement.classList.remove('has-limit'); return; }
  const res = speedHold.update(resolveSpeedLimit(), Date.now(), state.me.lat, state.me.lng);
  badge.hidden = false;
  document.documentElement.classList.toggle('has-limit', true);   // F7: „nākamā zīme” blakus aplim, ne virsū
  const sp = state.me.speedKmh == null ? null : Math.round(state.me.speedKmh);
  const over = isOverspeed(state.me.speedKmh, res, state.warn);
  const label = (sp == null ? 'Ātrums nav zināms' : `Tavs ātrums ${sp} km/h`) +
    (res ? ` · atļauts ${res.approx ? 'aptuveni ' : ''}${res.limit} km/h` : '') + (over ? ' — pārsniegts!' : '');
  badge.title = label;
  badge.setAttribute('aria-label', label);
  badge.classList.toggle('over', over);
  renderSpeedo(state.me.speedKmh, res, over);
  // F8 sagatavošanai: notikumi tikai pie maiņas (balss vēl nav)
  const key = speedLimitKey(res);
  if (key !== limitKey) {
    limitKey = key;
    document.dispatchEvent(new CustomEvent('speedlimitchange', { detail: res ? { limit: res.limit, source: res.source, approx: res.approx } : null }));
  }
  if (over !== overNow) {
    overNow = over;
    document.dispatchEvent(new CustomEvent('overspeed', { detail: { active: over, speed: state.me.speedKmh, limit: res ? res.limit : null } }));
  }
}

// v129: spidometra zīmējums — skaitlis, aplis un atļautā ātruma zīme.
//   aplis: cik tuvu atļautajam (bez zināma ierobežojuma — skala līdz 130); sarkanā svītra: cik pārsniegts (pilna pie +30)
//   zīme: rāda, ja ierobežojums zināms; minēts (aptuvens) — pelēka svītrota mala; stāvot (< 3 km/h) — „0”, aplis tukšs
const SPEEDO_PARK_MS = 3000;
function renderSpeedo(kmh, res, over) {
  const badge = $('limitBadge'), known = kmh != null && !isNaN(kmh), stopped = known && kmh < 3;
  $('speedValue').textContent = !known ? '–' : stopped ? '0' : String(Math.round(kmh));
  badge.classList.toggle('stopped', !known || stopped);
  // v130: stāvot ~3 s — zīme un iedaļas maigi pazūd (tīrs aplis ar 0); sākot braukt — parādās atpakaļ
  if (stopped) {
    if (!renderSpeedo.parkT && !badge.classList.contains('parked')) {
      renderSpeedo.parkT = setTimeout(() => { renderSpeedo.parkT = 0; badge.classList.add('parked'); }, SPEEDO_PARK_MS);
    }
  } else {
    clearTimeout(renderSpeedo.parkT); renderSpeedo.parkT = 0;
    badge.classList.remove('parked');
  }
  const lim = res && res.limit ? res.limit : null;
  const pct = !known ? 0 : Math.max(0, Math.min(100, kmh / (lim || 130) * 100));
  const ex = over && lim ? Math.max(4, Math.min(100, (kmh - lim) / 30 * 100)) : 0;
  $('speedoArc').setAttribute('stroke-dasharray', `${pct.toFixed(1)} 100`);
  $('speedoOver').setAttribute('stroke-dasharray', `${ex.toFixed(1)} 100`);
  const sign = $('limitSign');
  sign.hidden = !lim;
  if (lim) {
    $('limitSignValue').textContent = String(lim);
    sign.classList.toggle('approx', !!res.approx);
    sign.title = res.approx ? `Aptuveni ${lim} km/h (zīme nav zināma)` : `Atļauts ${lim} km/h`;
  }
}

// ---------- Laika ierobežojumi ----------
// No OSM: aizliegtie pagriezieni noteiktos laikos, apstāties/stāvēt aizliegts
// noteiktos laikos, mainīgs ātrums, slēgtas ielas naktī. Tos piesien atbilstošajām
// zīmēm kartē; ja pagrieziena zīmes Mapillary nav, to uzliek pati lietotne.
const timeRules = [];
const timePlates = [];          // Mapillary atrastās laika plāksnītes zem zīmēm
const seenTimeEls = new Set();
const TURN_SIGN = {
  no_left_turn: [/no-left-turn/, 'regulatory--no-left-turn--g1'],
  no_right_turn: [/no-right-turn/, 'regulatory--no-right-turn--g1'],
  no_u_turn: [/no-u-turn/, 'regulatory--no-u-turn--g1'],
  no_straight_on: [/no-straight-through/, 'regulatory--no-straight-through--g1'],
  only_straight_on: [/go-straight--/, 'regulatory--go-straight--g1'],
  only_right_turn: [/turn-right(-ahead)?--/, 'regulatory--turn-right-ahead--g1'],
  only_left_turn: [/turn-left(-ahead)?--/, 'regulatory--turn-left-ahead--g1'],
};

function speedCondition(tags) {
  const p = tags && tags['maxspeed:conditional'] && splitConditional(tags['maxspeed:conditional'])[0];
  const limit = p && parseMaxspeed(p.value);
  if (!limit) return null;
  const c = parseCondition(p.cond);
  return c.short ? { limit, test: d => c.test(d) === true } : null;
}

function distToPolyline(p, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, distToSegment(p, pts[i - 1], pts[i]));
  return best;
}
function bboxOf(pts, pad = 0.0004) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const [la, lo] of pts) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
  return [s - pad, w - pad / 0.55, n + pad, e + pad / 0.55];
}

function readTimeRules(el) {
  const key = el.type + el.id;
  if (seenTimeEls.has(key)) return;
  seenTimeEls.add(key);
  const t = el.tags || {};
  if (el.type === 'relation' && t.type === 'restriction') {
    let type = t.restriction, cond = null;
    const p = t['restriction:conditional'] && splitConditional(t['restriction:conditional'])[0];
    if (p) {
      const c = parseCondition(p.cond);
      if (p.value === 'none' && type) cond = invertCondition(c);   // aizliegts, izņemot laiku
      else if (TURN_SIGN[p.value]) { type = p.value; cond = c; }   // aizliegts tikai šajā laikā
    } else if (t.hour_on || t.day_on) cond = parseCondition(legacyCondition(t));
    if (!cond || !cond.short || !TURN_SIGN[type]) return;
    const from = (el.members || []).find(m => m.role === 'from' && m.type === 'way' && m.geometry);
    const via = (el.members || []).find(m => m.role === 'via');
    if (!from || !via) return;
    const fpts = from.geometry.map(g => [g.lat, g.lon]);
    let vp = via.type === 'node' && via.lat != null ? [via.lat, via.lon] : null;
    if (!vp && via.geometry) {
      const vg = via.geometry.map(g => [g.lat, g.lon]);
      const near = q => Math.min(distM(q[0], q[1], fpts[0][0], fpts[0][1]), distM(q[0], q[1], fpts.at(-1)[0], fpts.at(-1)[1]));
      vp = near(vg[0]) < near(vg.at(-1)) ? vg[0] : vg.at(-1);
    }
    if (!vp) return;
    // Pieeja krustojumam: no-ceļa punkti virzienā uz krustojumu.
    const toVia = distM(fpts[0][0], fpts[0][1], vp[0], vp[1]) < distM(fpts.at(-1)[0], fpts.at(-1)[1], vp[0], vp[1]) ? fpts.slice().reverse() : fpts;
    const back = pointAlong(toVia.slice().reverse(), 18);
    const heading = bearingDeg(back[0], back[1], vp[0], vp[1]);
    timeRules.push({ kind: 'turn', match: TURN_SIGN[type][0], value: TURN_SIGN[type][1], cond, approach: toVia, via: vp, heading, back, done: false });
  } else if (el.type === 'way' && el.geometry) {
    const pts = el.geometry.map(g => [g.lat, g.lon]);
    const add = (kind, match, cond) => cond.short && timeRules.push({ kind, match, cond, pts, bbox: bboxOf(pts), done: false });
    for (const [k, v] of Object.entries(t)) {
      if (!k.endsWith(':conditional')) continue;
      const p = splitConditional(v)[0];
      if (!p) continue;
      const c = parseCondition(p.cond);
      if (k === 'maxspeed:conditional') {
        const lim = parseMaxspeed(p.value);
        if (lim) add('speed', new RegExp(`maximum-speed-limit-${lim}--`), c);
      } else if (/^(access|motor_vehicle|vehicle):conditional$/.test(k)) {
        const ACCESS = /no-entry|road-closed|no-motor-vehicles/;
        if (p.value === 'no') add('access', ACCESS, c);
        else if (p.value === 'yes' && /^(no|private)$/.test(t[k.replace(':conditional', '')] || '')) add('access', ACCESS, invertCondition(c));
      } else if (/^parking:(both|left|right):restriction:conditional$/.test(k)) {
        if (p.value === 'no_stopping') add('parking', /no-stopping/, c);
        else if (p.value === 'no_parking') add('parking', /no-parking|no-stopping/, c);
      }
    }
  }
}

// Vai Mapillary zīmes šai vietai jau ir ielādētas (lai neliktu dubultu zīmi)?
function mlyReadyAt(lat, lng) {
  return !state.mlyToken || state.mlyTiles.has(lngToTileX(lng, MLY_ZOOM) + ':' + latToTileY(lat, MLY_ZOOM));
}

function attachTimes() {
  let changed = attachPlateTimes() > 0;
  for (const p of timePlates) {
    if (p.done) continue;
    const s = signs.findNear(p.lat, p.lng, 4, x => x.value && /^(regulatory|warning)--/.test(x.value));
    if (s) {
      s.timePlate = true; p.done = true; changed = true;
      if (!s.restriction) s.restriction = makeRestriction(null, 'mapillary-plate', 'low');  // laiks nav zināms
    }
  }
  for (const r of timeRules) {
    if (r.done) continue;
    let found = 0;
    if (r.kind === 'turn') {
      const [la, lo] = r.via, pad = 0.0005, cand = [];
      signs.eachInBox(la - pad, lo - pad / 0.55, la + pad, lo + pad / 0.55, s => {
        if (!s.value || s.timeRule || !r.match.test(s.value)) return;
        const d = distM(s.lat, s.lng, la, lo);
        if (d > 45 || distToPolyline([s.lat, s.lng], r.approach) > 25) return;
        if (s.face != null && angleDiff((s.face + 180) % 360, r.heading) > 60) return;
        cand.push([d, s]);
      });
      // Tikai 2 tuvākās krustojumam (citas parasti ir citām joslām / dublikāti).
      cand.sort((a, b) => a[0] - b[0]).slice(0, 2).forEach(([, s]) => {
        s.timeRule = r; s.restriction = s.restriction || makeRestriction(r.cond, 'osm', 'medium'); found++;
      });
      if (!found && mlyReadyAt(la, lo)) {
        // Mapillary šo zīmi nav atradis — uzliek to ceļa labajā pusē pirms krustojuma.
        const b = (r.heading + 90) * Math.PI / 180, off = 5;
        const lat = r.back[0] + Math.cos(b) * off / 111320;
        const lng = r.back[1] + Math.sin(b) * off / (111320 * Math.cos(r.back[0] * Math.PI / 180));
        const s = addSign(lat, lng, classifyMapillary(r.value), r.value);
        if (s) {
          s.face = (r.heading + 180) % 360; signs.faceChanged(s);
          s.timeRule = r; s.restriction = makeRestriction(r.cond, 'osm', 'medium'); s.source = 'osm-turn'; found++;
        }
        r.done = true;
      }
    } else {
      const [S, W, N, E] = r.bbox;
      signs.eachInBox(S, W, N, E, s => {
        if (!s.value || s.timeRule || !r.match.test(s.value)) return;
        if (distToPolyline([s.lat, s.lng], r.pts) > 20) return;
        if (r.kind === 'access') {
          const a = r.pts[0], z = r.pts.at(-1);
          if (Math.min(distM(s.lat, s.lng, a[0], a[1]), distM(s.lat, s.lng, z[0], z[1])) > 40) return;
        }
        s.timeRule = r; s.restriction = s.restriction || makeRestriction(r.cond, 'osm', 'medium'); found++;
      });
      const c = r.pts[Math.floor(r.pts.length / 2)];
      if (mlyReadyAt(c[0], c[1])) r.done = true;
    }
    if (found) { r.done = true; changed = true; }
  }
  if (changed) signs.refresh();
}
let attachTimer = null;
function attachTimesSoon() { clearTimeout(attachTimer); attachTimer = setTimeout(attachTimes, 300); }

// Ko rādīt pie zīmes: laiks zem tās (īsi), pilns apraksts uznirstošajā logā,
// blāva, ja aizliegums šobrīd nav spēkā. Nezināmu laiku NEIZDOMĀ.
function signTimeInfo(s) {
  const r = s.restriction;
  const notes = [];
  if (s._m && s._m.quality === 'uncertain') notes.push('Piesaiste ceļam nav droša (' + (s._m.reason || 'neskaidrs') + ').');
  if (s.conflict) notes.push('Pretrunīgi dati: tuvumā ir cits ātruma ierobežojums.');
  if (s.verifiedAt) notes.push('Pārbaudīta zīme (' + String(s.verifiedAt).slice(0, 10) + ').');
  const app = s._app;
  if (app) {
    const why = {
      'lane-unknown': 'Obligātā virziena zīme — var attiekties tikai uz noteiktu joslu (joslu dati nav pieejami), tāpēc nav parādīta kā saistoša.',
      'contradicts-route': 'Neatbilst maršruta manevram — visticamāk attiecas uz citu joslu vai atzaru.',
      'dir-unknown': 'Zīmes virziens nav zināms — nav apstiprināts, ka tā attiecas uz tavu braukšanas virzienu.',
      'no-junction': 'Pagrieziena zīme nav pie krustojuma uz tava ceļa — attiecināmība nav apstiprināta.',
      'dir-side': 'Virziens noteikts tikai pēc ceļa puses (nav apstiprināts).',
      'gps-uncertain': 'GPS nevar droši atšķirt tuvos ceļus.',
      'lane-maybe': 'Var attiekties tikai uz noteiktu joslu.',
      'roads-not-loaded': 'Ceļa dati šai vietai vēl nav ielādēti.',
      'after-junction': 'Aiz krustojuma — attiecas, ja brauksi taisni.',
    }[app.reason];
    if (why) notes.push(why);
    if (app.mapRule) notes.push('Kartes (OSM) pagrieziena ierobežojums — fiziska zīme nav pārbaudīta.');
  } else if (s.source === 'osm-turn') notes.push('Kartes (OSM) pagrieziena ierobežojums — fiziska zīme nav pārbaudīta.');
  if (s.plateRead && s.plateRead.plateText) notes.push(`Plāksnīte: „${s.plateRead.plateText}” (nolasīts no foto${s.plateRead.readAt ? ' ' + s.plateRead.readAt : ''}; ⚒ — darba dienas).`);
  const note = notes.length ? ' ' + notes.join(' ') : '';
  if (r && r.known) {
    const cond = s.timeRule ? s.timeRule.cond : (s.timeCond || null);
    const on = cond ? cond.test(new Date()) : null;
    return {
      time: cond ? cond.short : r.text, off: on === false,
      info: describeRestriction(s.title, r) + (on === true ? ' — tagad ir spēkā' : on === false ? ' — tagad NAV spēkā' : '') +
        (r.extra ? ` (nosacījums: ${r.extra})` : '') + ` · avots: ${r.source}` + note,
    };
  }
  if (r) return { time: 'laiks?', unk: true, info: describeRestriction(s.title, r) + '. Zem zīmes ir plāksnīte — paskaties foto.' + note };
  return note ? { info: note.trim() } : null;
}

// Zīmes foto no Mapillary: izgriež zīmi ar plāksnītēm zem tās.
async function showSignPhoto(el, mid, popup) {
  const box = document.createElement('div');
  box.className = 'sign-photo loading';
  box.textContent = 'Ielādē zīmes foto…';
  el.appendChild(box);
  const ph = await fetchSignPhoto(mid, state.mlyToken);
  if (!ph) { box.textContent = 'Foto nav pieejams.'; box.classList.remove('loading'); return; }
  const img = new Image();
  img.onload = () => {
    const W = img.naturalWidth, H = img.naturalHeight;
    const [x0, y0, x1, y1] = ph.bb, w = x1 - x0, h = y1 - y0;
    // Zīme + vieta zem tās plāksnītēm (laiks, bultas), nedaudz arī sānos.
    const cx0 = Math.max(0, x0 - 0.7 * w), cx1 = Math.min(1, x1 + 0.7 * w);
    const cy0 = Math.max(0, y0 - 0.35 * h), cy1 = Math.min(1, y1 + 2.6 * h);
    const rw = (cx1 - cx0) * W, rh = (cy1 - cy0) * H;
    const scale = Math.min(240 / rw, 280 / rh);
    box.textContent = '';
    box.classList.remove('loading');
    box.style.width = Math.round(rw * scale) + 'px';
    box.style.height = Math.round(rh * scale) + 'px';
    img.style.width = Math.round(W * scale) + 'px';
    img.style.left = Math.round(-cx0 * W * scale) + 'px';
    img.style.top = Math.round(-cy0 * H * scale) + 'px';
    box.appendChild(img);
    const cap = document.createElement('div');
    cap.className = 'sign-photo-cap';
    cap.textContent = 'Foto: Mapillary — plāksnītes zem zīmes rāda laiku un zonu';
    el.appendChild(cap);
    popup && popup._update && popup._update();
  };
  img.onerror = () => { box.textContent = 'Foto neizdevās ielādēt.'; box.classList.remove('loading'); };
  img.alt = 'Zīmes foto';
  img.src = ph.url;
}
