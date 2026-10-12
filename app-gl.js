// Ceļa Zīmes — galvenā lietotnes loģika (MapLibre GL).
// Karte: OpenFreeMap. Zīmes: Mapillary + OpenStreetMap (Overpass).
// Meklēšana: Photon / Nominatim. Maršruts: OSRM.

// Vairāki bezmaksas serveri: jautājam visiem reizē un ņemam ātrāko atbildi.
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const MIN_SIGN_ZOOM = 14;         // zīmes ielādē tikai pietuvinot (ielu līmenis)
const CELL = 0.01;                // OSM ielādes režģa šūna grādos (~1 km)
const MAX_CELLS = 24;
const VIEW_LIMIT = 0.014;         // sasvērtā skatā ielādē ne tālāk par ~1,5 km no centra
const START = [56.9496, 24.1052]; // Rīgas centrs

// ---------- Saglabātie iestatījumi ----------
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('cz.' + key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('cz.' + key, JSON.stringify(value)); } catch { /* nav krātuves */ }
  },
};

const state = {
  signsOn: store.get('signsOn', true),
  cats: Object.assign(
    Object.fromEntries(Object.keys(SIGN_CATEGORIES).map(k => [k, true])),
    store.get('cats', {})
  ),
  warn: store.get('warn', true),
  profile: store.get('profile', 'car'),   // car | truck | tram | bike
  basemap: store.get('basemap', 'auto'),
  mlyToken: store.get('mlyToken', ''),
  testMode: false,
  follow: true,
  me: null,            // { lat, lng, speedKmh }
  heading: null,
  vector: true,
  ways: new Map(),
  seenNodes: new Set(),
  loadedCells: new Set(),
  loading: false,
  osmRetryMs: 0,
  mlyTiles: new Set(),
  counts: { osm: 0, mly: 0 },
  nav: { dest: null, route: null, active: false, offCount: 0, lastReroute: 0, along: null },
};

let map, signs;
const $ = id => document.getElementById(id);

// ---------- Palīgfunkcijas ----------
function distM(lat1, lng1, lat2, lng2) {
  const k = 111320, x = (lng2 - lng1) * k * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180), y = (lat2 - lat1) * k;
  return Math.hypot(x, y);
}
function bearingDeg(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180, y = Math.sin((lng2 - lng1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lng2 - lng1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
function setStatus(text) { $('statusText').textContent = text; }
function clockIn(sec) {
  return new Date(Date.now() + sec * 1000).toLocaleTimeString('lv-LV', { hour: '2-digit', minute: '2-digit' });
}
// Redzamais apgabals, bet sasvērtā skatā ne tālāk par VIEW_LIMIT no centra.
function viewBox(pad = 0) {
  const b = map.getBounds(), c = map.getCenter();
  let s = b.getSouth(), w = b.getWest(), n = b.getNorth(), e = b.getEast();
  const dl = (n - s) * pad, dg = (e - w) * pad;
  s -= dl; n += dl; w -= dg; e += dg;
  return [Math.max(s, c.lat - VIEW_LIMIT), Math.max(w, c.lng - VIEW_LIMIT * 1.8),
          Math.min(n, c.lat + VIEW_LIMIT), Math.min(e, c.lng + VIEW_LIMIT * 1.8)];
}

// ---------- Ielādes indikators ----------
// Rāda tikai, ja darbs ilgst ilgāk par ~0,35 s (ātra ielāde nemirgo).
const busy = new Map();
let busyTimer = null;
function setBusy(key, text) {
  if (text) busy.set(key, text); else busy.delete(key);
  clearTimeout(busyTimer);
  if (!busy.size) { $('loader').classList.remove('show'); return; }
  $('loaderText').textContent = [...busy.values()].pop();
  if (!$('loader').classList.contains('show')) busyTimer = setTimeout(() => $('loader').classList.toggle('show', busy.size > 0), 350);
}

// ---------- Zīmju virzienu kešatmiņa ----------
// Zīmju virzienus ielādēt ir lēni, tāpēc tos atceras šajā ierīcē.
const faceCache = new Map(Object.entries(store.get('faces', {})));
let faceSaveTimer = null;
function faceKey(value, lat, lng) { return value + '@' + lat.toFixed(5) + ',' + lng.toFixed(5); }
function rememberFace(s) {
  faceCache.set(faceKey(s.value, s.lat, s.lng), Math.round(s.face));
  clearTimeout(faceSaveTimer);
  faceSaveTimer = setTimeout(() => {
    let entries = [...faceCache];
    if (entries.length > 30000) entries = entries.slice(-30000);
    store.set('faces', Object.fromEntries(entries));
  }, 2000);
}

// ---------- Zīmes ----------
// Dublikāti un pretrunas (model.js → SignDeduper):
//   • tāda pati Mapillary zīme ≤ 5 m — dublikāts (Mapillary to bieži saglabā vairākkārt);
//   • OSM zīme, ja tuvumā jau ir tāda paša veida zīme — dublikāts;
//   • pārbaudīta zīme vienmēr ir noteicošā;
//   • dažādi ātruma ierobežojumi ≤ 8 m — abas zīmes atzīmē kā PRETRUNĪGAS (neizdomā, kura pareiza).
const dedupe = new SignDeduper();
let signSeq = 0;

// sign: { cat, kind?, value?, title }; mlyValue: zīmes kods; mlyId: Mapillary objekta ID
// opts: { source, uid, verifiedDir, verifiedAt, restriction }
function addSign(lat, lng, sign, mlyValue, mlyId, opts = {}) {
  const limit = sign.cat === 'speed' ? (Number(sign.value || (String(mlyValue).match(/limit-(\d+)/) || [])[1]) || null) : null;
  const chk = dedupe.check(lat, lng, sign.cat, mlyValue, limit);
  if (chk.status !== 'ok' && chk.status !== 'conflict') return null;
  const own = sign.kind ? sign : { kind: 'other' };
  const s = mlyValue
    ? { icon: 'mly:' + mlyValue, src: MLY_ICON_URL + encodeURIComponent(mlyValue) + '.svg', value: mlyValue }
    : { icon: 'own:' + own.kind + ':' + (own.value || ''), src: svgDataUrl(own) };
  Object.assign(s, { lat, lng, cat: sign.cat, title: sign.title, face: null, limit });
  s.source = opts.source || (mlyValue ? 'mapillary' : 'osm');
  s.uid = opts.uid || (mlyId ? 'mly:' + mlyId : 'gen:' + (++signSeq));
  if (opts.verifiedDir != null) { s.verifiedDir = opts.verifiedDir; s.face = (opts.verifiedDir + 180) % 360; }
  if (opts.verifiedAt) s.verifiedAt = opts.verifiedAt;
  if (opts.restriction) s.restriction = opts.restriction;
  if (mlyValue && s.face == null) { const f = faceCache.get(faceKey(mlyValue, lat, lng)); if (f != null) s.face = f; }
  if (mlyValue && /time-restrictions/.test(mlyValue)) timePlates.push({ lat, lng, done: false });
  if (mlyId) s.mid = mlyId;
  if (chk.status === 'conflict') {
    s.conflict = true;
    if (chk.other.ref) chk.other.ref.conflict = true;
  }
  dedupe.add(lat, lng, sign.cat, mlyValue, limit, s, s.source === 'verified');
  signs.add(s);
  return s;
}

// ---------- Pārbaudītās zīmes (data/verified-signs.geojson) ----------
// Formāts: GeoJSON punkti ar properties { id, type, direction, opening_hours, plate_text, verified_at }.
async function loadVerifiedSigns() {
  let json;
  try {
    const r = await fetch('data/verified-signs.geojson', { cache: 'no-cache' });
    if (!r.ok) return;
    json = await r.json();
  } catch { return; }
  const { records, errors } = parseVerifiedGeoJSON(json, parseCondition);
  if (errors.length) console.warn('Pārbaudītās zīmes: nederīgi ieraksti', errors);
  for (const rec of records) {
    const sign = Object.assign(classifyMapillary(rec.type), rec.title ? { title: rec.title } : {});
    addSign(rec.lat, rec.lng, sign, rec.type, null,
      { source: 'verified', uid: rec.id, verifiedDir: rec.direction, verifiedAt: rec.verifiedAt, restriction: rec.restriction });
  }
  if (records.length) signs.refresh();
}

// ---------- No foto nolasītie plāksnīšu laiki (data/plate-times.json) ----------
// Mapillary atrod zīmi, bet plāksnītes tekstu (laiku) nenolasa. Šie laiki ir nolasīti
// no Mapillary foto un piesaistīti tāda paša veida zīmēm 8 m rādiusā.
let plateTimes = [];
async function loadPlateTimes() {
  let json;
  try {
    const r = await fetch('data/plate-times.json', { cache: 'no-cache' });
    if (!r.ok) return;
    json = await r.json();
  } catch { return; }
  const { records, errors } = parsePlateTimes(json, parseCondition);
  if (errors.length) console.warn('Plāksnīšu laiki: nederīgi ieraksti', errors);
  plateTimes = records;
  attachTimesSoon();
}
function attachPlateTimes() {
  let n = 0;
  const dLat = PLATE_MATCH_M / 111320;
  for (const p of plateTimes) {
    const dLng = dLat / Math.cos(p.lat * Math.PI / 180);
    signs.eachInBox(p.lat - dLat, p.lng - dLng, p.lat + dLat, p.lng + dLng, s => {
      if (s.plateRead || s.value !== p.type || distM(s.lat, s.lng, p.lat, p.lng) > PLATE_MATCH_M) return;
      s.plateRead = p; s.timeCond = p.cond; s.restriction = p.restriction; n++;
    });
  }
  return n;
}

function showCounts() {
  if (state.nav.active) return;
  const parts = [];
  if (state.counts.mly) parts.push(`${state.counts.mly} no Mapillary`);
  if (state.counts.osm) parts.push(`${state.counts.osm} no OpenStreetMap`);
  if (parts.length) setStatus('Zīmes: ' + parts.join(', ') + '.');
}

// ---------- OpenStreetMap zīmes (Overpass) ----------
function buildQuery(s, w, n, e) {
  const bb = `${s},${w},${n},${e}`;
  return `[out:json][timeout:25];
(
  node["traffic_sign"](${bb});
  node["highway"~"^(stop|give_way|traffic_signals|crossing|speed_camera)$"](${bb});
  node["traffic_calming"](${bb});
  node["railway"="level_crossing"](${bb});
  way["highway"]["maxspeed"](${bb});
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

async function fetchOverpass(query) {
  const controllers = OVERPASS_URLS.map(() => new AbortController());
  const attempts = OVERPASS_URLS.map(async (url, i) => {
    const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), signal: controllers[i].signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    controllers.forEach((c, j) => { if (j !== i) c.abort(); });
    return json;
  });
  return Promise.any(attempts);
}

async function loadOsmForView() {
  if (state.loading || map.getZoom() < MIN_SIGN_ZOOM) return;
  const [vs, vw, vn, ve] = viewBox(0.2);
  const cells = [];
  for (let la = Math.floor(vs / CELL); la <= Math.floor(vn / CELL); la++)
    for (let lo = Math.floor(vw / CELL); lo <= Math.floor(ve / CELL); lo++) cells.push(la + ':' + lo);
  const missing = cells.filter(c => !state.loadedCells.has(c));
  if (!missing.length || missing.length > MAX_CELLS) return;

  const las = missing.map(c => +c.split(':')[0]), los = missing.map(c => +c.split(':')[1]);
  const s = Math.min(...las) * CELL, n = (Math.max(...las) + 1) * CELL;
  const w = Math.min(...los) * CELL, e = (Math.max(...los) + 1) * CELL;

  state.loading = true;
  if (!state.mlyToken) setBusy('osm', 'Ielādē ceļa zīmes…');
  try {
    const data = await fetchOverpass(buildQuery(s.toFixed(4), w.toFixed(4), n.toFixed(4), e.toFixed(4)));
    let added = 0;
    for (const el of data.elements || []) {
      if (el.type !== 'node') readTimeRules(el);
      if (el.type === 'node') {
        if (state.seenNodes.has(el.id)) continue;
        state.seenNodes.add(el.id);
        const sign = classifyNode(el.tags);
        if (sign && addSign(el.lat, el.lon, sign)) added++;
      } else if (el.type === 'way' && el.geometry && !state.ways.has(el.id)) {
        const limit = parseMaxspeed(el.tags.maxspeed);
        if (!limit) continue;
        const pts = el.geometry.map(p => [p.lat, p.lon]);
        state.ways.set(el.id, { limit, pts });
        indexWay(limit, pts, speedCondition(el.tags));
        added += addWaySpeedSign(pts, limit);
      }
    }
    missing.forEach(c => state.loadedCells.add(c));
    attachTimesSoon();
    state.osmRetryMs = 0;
    state.counts.osm += added;
    signs.refresh();
    showCounts();
    updateLimit();
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
  return addSign(at[0], at[1], { cat: 'speed', kind: 'speed', value: limit, title: `Ātruma ierobežojums ${limit} km/h` }) ? 1 : 0;
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
function indexWay(limit, pts, cond) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const la0 = Math.floor(Math.min(a[0], b[0]) / WAY_CELL), la1 = Math.floor(Math.max(a[0], b[0]) / WAY_CELL);
    const lo0 = Math.floor(Math.min(a[1], b[1]) / WAY_CELL), lo1 = Math.floor(Math.max(a[1], b[1]) / WAY_CELL);
    for (let la = la0; la <= la1; la++) for (let lo = lo0; lo <= lo1; lo++) {
      const k = la + ':' + lo;
      if (!wayGrid.has(k)) wayGrid.set(k, []);
      wayGrid.get(k).push([a, b, limit, cond]);
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
function nearestLimit(lat, lng, heading = null, matched = null) {
  if (matched) { lat = matched.P[1]; lng = matched.P[0]; }
  let best = null, bestD = matched ? 8 : 30;
  const la = Math.floor(lat / WAY_CELL), lo = Math.floor(lng / WAY_CELL);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    for (const [a, b, limit, cond] of wayGrid.get((la + i) + ':' + (lo + j)) || []) {
      if (heading != null) {
        const ax = angleDiff(bearingDeg(a[0], a[1], b[0], b[1]), heading);
        if (Math.min(ax, 180 - ax) > 35) continue;                 // šķērsiela
      }
      const d = distToSegment([lat, lng], a, b);
      // Mainīgs ātrums (piem. 30 darbdienās 7–22): tagad spēkā esošais.
      if (d < bestD) { bestD = d; best = cond && cond.test(new Date()) ? cond.limit : limit; }
    }
  }
  return best;
}
function updateLimit() {
  const badge = $('limitBadge');
  if (!state.me) { badge.hidden = true; return; }
  const pos = signs.pos && !signs.pos.uncertain ? signs.pos : null;
  let limit = nearestLimit(state.me.lat, state.me.lng, state.heading, pos);
  // Ja OSM ceļam ātrums nav norādīts: pēdējā garām pabrauktā ātruma zīme maršrutā.
  if (limit == null && state.nav.active && state.nav.along != null) {
    const last = signs.lastRouteSignBefore(state.nav.along + 10, 2000, x => x.cat === 'speed' && x.limit);
    if (last) limit = last.s.limit;
  }
  badge.hidden = limit == null;
  if (limit != null) $('limitValue').textContent = limit;
  const over = state.warn && limit != null && state.me.speedKmh != null && state.me.speedKmh > limit + 3;
  $('speedBox').classList.toggle('over', over);
  badge.classList.toggle('pulse', over);
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

// ---------- Mapillary zīmes ----------
const mlyIds = new Set();       // katru Mapillary zīmi pievieno tikai vienreiz
const mlyTilesLoading = new Set();

// Ielādē norādītās flīzes (paralēli) un pievieno zīmes. Atgriež pievienoto skaitu.
async function loadMlyTiles(tiles) {
  tiles = tiles.filter(([x, y]) => !state.mlyTiles.has(x + ':' + y) && !mlyTilesLoading.has(x + ':' + y));
  if (!tiles.length || !state.mlyToken) return 0;
  tiles.forEach(([x, y]) => mlyTilesLoading.add(x + ':' + y));
  let added = 0;
  const results = await Promise.allSettled(tiles.map(([x, y]) => fetchMapillaryTile(x, y, state.mlyToken)));
  results.forEach((r, i) => {
    const key = tiles[i][0] + ':' + tiles[i][1];
    mlyTilesLoading.delete(key);
    if (r.status === 'rejected') {
      if (r.reason && r.reason.badToken) { setStatus('Mapillary atslēga nav derīga. Pārbaudi to iestatījumos.'); state.mlyToken = ''; }
      return;
    }
    state.mlyTiles.add(key);
    for (const z of r.value) {
      if (mlyIds.has(z.id)) continue;
      mlyIds.add(z.id);
      if (!isPlausibleSign(z.value, z.lat, z.lng)) continue; // acīmredzamas atpazīšanas kļūdas
      if (addSign(z.lat, z.lng, classifyMapillary(z.value), z.value, z.id)) added++;
    }
  });
  if (added) {
    state.counts.mly += added;
    signs.refresh();
    showCounts();
    attachTimesSoon();
  }
  return added;
}

let mlyLoading = false;
async function loadMapillaryForView() {
  if (!state.mlyToken || mlyLoading || map.getZoom() < MIN_SIGN_ZOOM) return;
  const [s, w, n, e] = viewBox(0.2);
  const tiles = tilesForBounds(s, w, n, e).filter(([x, y]) => !state.mlyTiles.has(x + ':' + y));
  if (!tiles.length || tiles.length > 16) return;
  mlyLoading = true;
  setBusy('mly', 'Ielādē zīmes…');
  let added = 0;
  try { added = await loadMlyTiles(tiles); }
  finally {
    mlyLoading = false;
    setBusy('mly', null);
  }
  if (added) { dirCenter = null; loadDirectionsNearMe(); }
  setTimeout(loadMapillaryForView, 100);
}

// Ielādē virzienus zīmēm apgabalā (tikai tām, kuru virziens vēl nav zināms).
async function loadDirectionsBox(s, w, n, e) {
  const counts = new Map();
  signs.eachInBox(s, w, n, e, x => {
    if (x.value && x.face == null) counts.set(x.value, (counts.get(x.value) || 0) + 1);
  });
  if (!counts.size) return 0;
  const found = await fetchMapillaryDirectionsArea(w, s, e, n, state.mlyToken, counts);
  let matched = 0;
  for (const f of found) {
    const x = signs.findNear(f.lat, f.lng, 5, z => z.value === f.value && z.face == null);
    if (x) { x.face = MLY_DIR_IS_FACE ? f.dir : (f.dir + 180) % 360; signs.faceChanged(x); rememberFace(x); matched++; }
  }
  if (matched) signs.facesChanged();
  return matched;
}

// Zīmju virzieni ~300 m ap braucēju (API ir lēns, tāpēc ne visai kartei).
let dirCenter = null, dirLoading = false;
async function loadDirectionsNearMe() {
  if (!state.mlyToken || !state.me || dirLoading || state.nav.route) return; // maršrutam ir sava ielāde
  const { lat, lng } = state.me;
  if (dirCenter && distM(dirCenter[0], dirCenter[1], lat, lng) < 150) return;
  dirLoading = true;
  dirCenter = [lat, lng];
  try {
    const dLat = 0.003, dLng = 0.003 / Math.cos(lat * Math.PI / 180);
    setBusy('dir', 'Nosaka zīmju virzienus…');
    await loadDirectionsBox(lat - dLat, lng - dLng, lat + dLat, lng + dLng);
  } catch (err) {
    console.warn('Virzieni nav ielādēti', err);
    dirCenter = null;
  } finally {
    dirLoading = false;
    setBusy('dir', null);
  }
}

// Sagatavo zīmes visam maršrutam: vispirms visas zīmes gar maršrutu, tad to
// virzienus — pa ~600 m gabaliem no sākuma, lai tuvākās ir gatavas pirmās.
let routePrepId = 0;
function routeChunks(route, step = 600) {
  const chunks = [];
  let cur = null;
  for (let i = 0; i < route.coords.length; i++) {
    const [lng, lat] = route.coords[i];
    if (!cur || route.cum[i] - cur.start > step) {
      if (cur) chunks.push(cur);
      cur = { start: route.cum[i], s: lat, w: lng, n: lat, e: lng };
      if (i > 0) { const [pl, pa] = route.coords[i - 1]; cur.s = Math.min(lat, pa); cur.n = Math.max(lat, pa); cur.w = Math.min(lng, pl); cur.e = Math.max(lng, pl); }
    }
    cur.s = Math.min(cur.s, lat); cur.n = Math.max(cur.n, lat); cur.w = Math.min(cur.w, lng); cur.e = Math.max(cur.e, lng);
  }
  if (cur) chunks.push(cur);
  const pad = 0.0004;
  return chunks.map(c => ({ start: c.start, s: c.s - pad, w: c.w - pad / 0.55, n: c.n + pad, e: c.e + pad / 0.55 }));
}
async function prepareRoute(route) {
  if (!state.mlyToken) return;
  const id = ++routePrepId;
  const chunks = routeChunks(route);
  const tiles = new Map();
  for (const c of chunks) if (c.start < 15000) for (const t of tilesForBounds(c.s, c.w, c.n, c.e)) tiles.set(t.join(':'), t);
  setBusy('prep', 'Sagatavo maršruta zīmes…');
  try { await loadMlyTiles([...tiles.values()]); }
  finally { setBusy('prep', null); }
  updateRouteSummary();
  for (let i = 0; i < chunks.length; i++) {
    if (id !== routePrepId) return; // maršruts mainījies
    const c = chunks[i];
    // Tālākos gabalus gatavo tikai braucot, kad līdz tiem palikuši ~2,5 km.
    const far = () => state.nav.active ? (state.nav.along != null && c.start - state.nav.along > 2500) : c.start > 5000;
    if (far()) setBusy('prep', null);
    while (id === routePrepId && far()) await new Promise(r => setTimeout(r, 3000));
    if (id !== routePrepId) return;
    await loadMlyTiles(tilesForBounds(c.s, c.w, c.n, c.e));
    if (!state.nav.active) setBusy('prep', `Nosaka zīmju virzienus maršrutā… ${Math.round(100 * i / chunks.length)}%`);
    try { await loadDirectionsBox(c.s, c.w, c.n, c.e); }
    catch (err) { console.warn('Virzieni maršrutam nav ielādēti', err); }
    updateRouteSummary();
  }
  if (id === routePrepId) setBusy('prep', null);
}

function loadAllForView() {
  loadOsmForView();
  loadMapillaryForView();
}

// ---------- Mana atrašanās vieta ----------
let meMarker = null, meTween = null;
function createMeMarker(lng, lat) {
  const el = document.createElement('div');
  el.className = 'me-icon';
  el.innerHTML = `<div class="me-halo"></div>
    <svg class="me-puck" viewBox="0 0 48 48" aria-hidden="true">
      <defs><linearGradient id="meGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#5aa0ff"/><stop offset="1" stop-color="#1a5ad8"/>
      </linearGradient></defs>
      <circle cx="24" cy="24" r="20" fill="#fff"/>
      <circle cx="24" cy="24" r="16.5" fill="url(#meGrad)"/>
      <path class="me-chevron" d="M24 11.5 33 33 24 28.2 15 33Z" fill="#fff" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>
      <circle class="me-center" cx="24" cy="24" r="5.5" fill="#fff"/>
    </svg>`;
  meMarker = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' })
    .setLngLat([lng, lat]).addTo(map);
}
// Bulta slīd uz jauno vietu vienmērīgi (tikpat ilgi kā kamera).
function moveMeMarker(lng, lat, dur) {
  if (!meMarker) return createMeMarker(lng, lat);
  const from = meMarker.getLngLat();
  cancelAnimationFrame(meTween);
  if (distM(from.lat, from.lng, lat, lng) > 400 || !dur) { meMarker.setLngLat([lng, lat]); return; }
  const t0 = performance.now();
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / dur);
    meMarker.setLngLat([from.lng + (lng - from.lng) * k, from.lat + (lat - from.lat) * k]);
    if (k < 1) meTween = requestAnimationFrame(step);
  };
  step();
}

let lastFix = null;
function updateHeading(lat, lng, gpsHeading, speedKmh) {
  if (gpsHeading != null && !isNaN(gpsHeading) && (speedKmh == null || speedKmh > 4)) {
    state.heading = gpsHeading;
  } else if (lastFix && distM(lastFix[0], lastFix[1], lat, lng) > 8) {
    state.heading = bearingDeg(lastFix[0], lastFix[1], lat, lng);
  } else if (lastFix) {
    return;
  }
  lastFix = [lat, lng];
  signs.setHeading(state.heading);
  if (meMarker && state.heading != null) meMarker.setRotation(state.heading);
  document.documentElement.classList.toggle('has-heading', state.heading != null);
}

// Kamera seko braucējam: braucot karte griežas braukšanas virzienā un sasveras,
// bulta ir ekrāna lejasdaļā, lai priekšā redzams ceļš (kā Waze).
function followCamera(dur = 900) {
  if (!state.follow || !state.me) return;
  const driving = state.nav.active || (state.heading != null && (state.me.speedKmh ?? 0) > 5);
  const h = map.getContainer().clientHeight;
  const v = state.me.speedKmh ?? 0;
  map.easeTo({
    center: [state.me.lng, state.me.lat],
    bearing: driving && state.heading != null ? state.heading : map.getBearing(),
    pitch: driving ? 55 : 0,
    zoom: driving ? (v > 80 ? 15.8 : v > 50 ? 16.4 : 17) : Math.max(map.getZoom(), 15),
    padding: driving ? { top: h * 0.42, bottom: 0, left: 0, right: 0 } : { top: 0, bottom: 0, left: 0, right: 0 },
    duration: dur, easing: t => t, essential: true,
  });
}

// Viens jauns atrašanās vietas mērījums (no GPS, testa klikšķa vai simulācijas).
function onFix(lat, lng, speedKmh, gpsHeading, dur = 900, accuracy = null) {
  state.me = { lat, lng, speedKmh, accuracy };
  state.gpsQuality = gpsFixQuality(accuracy);
  moveMeMarker(lng, lat, state.follow ? dur : 300);
  $('speedValue').textContent = speedKmh == null ? '–' : Math.round(speedKmh);
  // Vājš signāls: neatjauno braukšanas virzienu (tas lēkātu) un brīdina.
  setBusy('gps', state.gpsQuality === 'poor' ? `Vājš GPS signāls (±${Math.round(accuracy)} m) — zīmes var būt neprecīzas` : null);
  if (state.gpsQuality !== 'poor') updateHeading(lat, lng, gpsHeading, speedKmh);
  // Kartes piesaiste ar vēsturi: uz kura ceļa posma esmu (zīmju atlasei un ātrumam).
  signs.setPosition(lat, lng, state.heading, accuracy == null ? 10 : accuracy);
  updateLimit();
  loadDirectionsNearMe();
  if (state.nav.active) updateNav();
  else updateNextSign();
  followCamera(dur);
}

// ---------- GPS ----------
let gpsProblem = 'Meklē GPS signālu… Ārā tas notiek ātrāk nekā telpās.';
let watchId = null;
function gpsErrorText(err) {
  if (err.code === 1) return 'Atrašanās vieta ir bloķēta. Telefona iestatījumos atļauj atrašanās vietu pārlūkam un šai lapai, tad pārlādē lapu.';
  if (err.code === 3) return 'GPS vēl meklē signālu. Pagaidi brīdi vai izej ārā.';
  return 'GPS nav pieejams. Pārbaudi, vai telefonā ir ieslēgta atrašanās vieta.';
}
function onPosition(pos) {
  if (state.testMode) return;
  const sp = pos.coords.speed;
  const first = !state.me;
  onFix(pos.coords.latitude, pos.coords.longitude, sp == null || sp < 0 ? null : sp * 3.6, pos.coords.heading, first ? 0 : 900, pos.coords.accuracy);
  if (first && state.nav.dest && !state.nav.active) previewRoute(); // maršruts no manas īstās vietas
  else if (first) { map.jumpTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: Math.max(map.getZoom(), 15.5) }); loadAllForView(); }
  gpsProblem = null;
  if (!state.nav.active && !state.counts.mly && !state.counts.osm) setStatus('GPS darbojas.');
}
function onGpsError(err) {
  gpsProblem = gpsErrorText(err);
  if (!state.me) setStatus(gpsProblem);
}
function startGps() {
  if (!('geolocation' in navigator) || !window.isSecureContext) {
    gpsProblem = 'Šis pārlūks nedod atrašanās vietu. Atver lapu Chrome vai Safari (nevis Messenger, Telegram u.c. iebūvētajā pārlūkā).';
    setStatus(gpsProblem);
    return;
  }
  navigator.geolocation.getCurrentPosition(onPosition, () => {}, { enableHighAccuracy: false, maximumAge: 60000, timeout: 10000 });
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(onPosition, onGpsError, { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
}

// ---------- Galamērķa meklēšana ----------
let searchTimer = null, searchSeq = 0, lastResults = [];
const PIN_ICON = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 2.5c-3.9 0-7 3-7 6.8C5 14.5 12 21.5 12 21.5s7-7 7-12.2c0-3.8-3.1-6.8-7-6.8Z" fill="currentColor"/><circle cx="12" cy="9.4" r="2.4" fill="#fff"/></svg>';

async function searchPhoton(q) {
  const c = state.me || { lat: map.getCenter().lat, lng: map.getCenter().lng };
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=7&lat=${c.lat.toFixed(4)}&lon=${c.lng.toFixed(4)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  return (json.features || []).map(f => {
    const p = f.properties || {};
    const street = [p.street, p.housenumber].filter(Boolean).join(' ');
    const name = p.name || street || p.city || 'Vieta';
    const sub = [p.name && street ? street : '', p.city || p.town || p.village || p.district, p.country].filter(Boolean).join(', ');
    return { name, sub, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
  });
}
async function searchNominatim(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=lv&q=' + encodeURIComponent(q);
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return (await res.json()).map(it => {
    const [name, ...rest] = it.display_name.split(', ');
    return { name, sub: rest.slice(0, 3).join(', '), lat: +it.lat, lng: +it.lon };
  });
}
async function runSearch(q, enter) {
  const seq = ++searchSeq;
  let items = [];
  try { items = await searchPhoton(q); }
  catch { try { items = await searchNominatim(q); } catch { items = []; } }
  if (seq !== searchSeq) return; // jau ir jaunāks meklējums
  lastResults = items;
  if (enter && items.length) return selectDestination(items[0]);
  showResults(items);
}
function showResults(items) {
  const ul = $('results');
  ul.innerHTML = '';
  if (!items.length) ul.innerHTML = '<li class="empty">Nekas netika atrasts. Pamēģini citu adresi.</li>';
  for (const it of items) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.innerHTML = `<span class="r-ico">${PIN_ICON}</span><strong></strong><span class="r-sub"></span>`;
    btn.querySelector('strong').textContent = it.name;
    btn.querySelector('.r-sub').textContent = it.sub;
    btn.addEventListener('click', () => selectDestination(it));
    li.appendChild(btn);
    ul.appendChild(li);
  }
  ul.hidden = false;
}

// ---------- Maršruts un navigācija ----------
let destMarker = null;
const EMPTY_FC = { type: 'FeatureCollection', features: [] };

function installRouteLayers() {
  if (map.getSource('route')) return;
  map.addSource('route', { type: 'geojson', data: EMPTY_FC });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#0b4fb8', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, 5, 15, 11, 18, 26] } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#3d93ff', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, 3, 15, 7, 18, 18] } });
}
function drawRoute(route) {
  const src = map.getSource('route');
  if (src) src.setData(route ? { type: 'Feature', geometry: { type: 'LineString', coordinates: route.coords }, properties: {} } : EMPTY_FC);
}

async function selectDestination(place) {
  $('results').hidden = true;
  $('searchInput').value = place.name;
  $('searchInput').blur();
  $('clearSearch').hidden = false;
  state.nav.dest = place;
  if (destMarker) destMarker.remove();
  const el = document.createElement('div');
  el.innerHTML = '<svg class="dest-pin" viewBox="0 0 36 46"><path d="M18 1C8.6 1 1 8.4 1 17.6 1 30.2 18 45 18 45s17-14.8 17-27.4C35 8.4 27.4 1 18 1Z" fill="#e5383b" stroke="#fff" stroke-width="2"/><circle cx="18" cy="17" r="6.5" fill="#fff"/></svg>';
  destMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([place.lng, place.lat]).addTo(map);
  await previewRoute();
}

// Parāda visu maršrutu un manu bultu tā, lai tos neaizsedz augšējā josla un maršruta kartīte.
function fitRoute() {
  const route = state.nav.route;
  if (!route || state.nav.active) return;
  const pts = route.coords.slice();
  if (state.me) pts.push([state.me.lng, state.me.lat]);
  const lngs = pts.map(c => c[0]), lats = pts.map(c => c[1]);
  const card = $('routeCard').hidden ? 0 : $('routeCard').offsetHeight;
  const h = map.getContainer().clientHeight;
  const top = 150, bottom = Math.min(card + 50, h - top - 100); // augšā vieta meklēšanai un galamērķa adatai
  document.documentElement.style.setProperty('--card-h', card + 'px');
  map.easeTo({ padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 0 });
  map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
    { padding: { top, bottom, left: 50, right: 90 }, pitch: 0, bearing: 0, duration: 800, maxZoom: 17 });
}

async function previewRoute() {
  const dest = state.nav.dest;
  if (!dest) return;
  const from = state.me || { lat: map.getCenter().lat, lng: map.getCenter().lng };
  setBusy('route', 'Meklē maršrutu…');
  try {
    const route = await requestRoute(from, dest);
    state.nav.route = route;
    drawRoute(route);
    signs.setRoute(route);     // rāda tikai maršruta zīmes manā virzienā
    prepareRoute(route);
    state.follow = false;
    $('routeDest').textContent = dest.name;
    $('routeSub').textContent = state.me ? (dest.sub || '')
      : 'Tava atrašanās vieta vēl nav zināma — maršruts no kartes centra. Atļauj atrašanās vietu.';
    $('routeTime').textContent = navTime(route.duration);
    $('routeMeta').textContent = `${navDist(route.distance)} · ieradīsies ${clockIn(route.duration)}`;
    $('routeCard').hidden = false;
    $('bottombar').hidden = true;
    document.documentElement.classList.add('previewing');
    updateRouteSummary();
    // Telefonā tastatūra vēl aizveras — karti pielāgo, kad ekrāns ir pilnā izmērā.
    setTimeout(fitRoute, 350);
  } catch (err) {
    console.error(err);
    setStatus('Maršrutu neizdevās atrast. Pamēģini vēlreiz.');
  } finally {
    setBusy('route', null);
  }
}

function startNav() {
  if (!state.nav.route) return;
  state.nav.active = true;
  state.nav.offCount = 0;
  document.documentElement.classList.add('navigating');
  document.documentElement.classList.remove('previewing');
  $('routeCard').hidden = true;
  $('bottombar').hidden = false;
  $('navBanner').hidden = false;
  $('statusBox').hidden = true;
  $('etaBox').hidden = false;
  $('endNav').hidden = false;
  state.follow = true;
  setBusy('prep', null);
  if (state.testMode) startSimulation();
  else if (state.me) { updateNav(); followCamera(1200); }
}

function endNav() {
  stopSimulation();
  routePrepId++;
  setBusy('prep', null);
  signs.setRoute(null);
  $('nextSign').hidden = true;
  state.nav = { dest: null, route: null, active: false, offCount: 0, lastReroute: 0, along: null };
  drawRoute(null);
  if (destMarker) { destMarker.remove(); destMarker = null; }
  document.documentElement.classList.remove('navigating');
  $('navBanner').hidden = true;
  $('routeCard').hidden = true;
  $('bottombar').hidden = false;
  $('statusBox').hidden = false;
  $('etaBox').hidden = true;
  $('endNav').hidden = true;
  $('searchInput').value = '';
  $('clearSearch').hidden = true;
  showCounts();
  map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 800 });
}

function updateNav() {
  const route = state.nav.route;
  if (!route || !state.me) return;
  const p = routeProgress(route, state.me.lat, state.me.lng);
  if (p.arrived) {
    $('navIcon').innerHTML = maneuverIcon({ maneuver: { type: 'arrive' } });
    $('navDist').textContent = 'Esi klāt!';
    $('navInstr').textContent = state.nav.dest ? state.nav.dest.name : 'Galamērķis sasniegts';
    stopSimulation();
    clearTimeout(updateNav._end);
    updateNav._end = setTimeout(endNav, 6000);
    return;
  }
  $('navIcon').innerHTML = maneuverIcon(p.next);
  $('navDist').textContent = navDist(p.toNext);
  $('navInstr').textContent = maneuverText(p.next);
  $('etaTime').textContent = clockIn(p.timeLeft);
  $('etaMeta').textContent = `${navTime(p.timeLeft)} · ${navDist(p.remaining)}`;
  const goodFix = state.gpsQuality !== 'poor';    // vājš GPS — progresu un nobraukšanu nevērtē
  if (goodFix && p.loc.off < 50) {
    state.nav.along = p.loc.along;
    signs.setRouteProgress(p.loc.along);
  }
  updateNextSign();
  // Nobrauci no maršruta: pēc diviem mērījumiem pārrēķina (ne biežāk kā reizi 15 s).
  if (goodFix) { if (p.loc.off > 50) state.nav.offCount++; else state.nav.offCount = 0; }
  if (state.nav.offCount >= 2 && Date.now() - state.nav.lastReroute > 15000) reroute();
}

// Zīmes, par kurām brīdina "nākamā zīme" kartītē: ātrums, prioritāte, aizliegumi,
// brīdinājumi (bez informatīvajām un papildzīmēm).
function isNoticeSign(x) {
  if (x.cat !== 'other') return true;
  if (!x.value) return false;
  return /no-entry|no-(left|right|u)-turn|no-overtaking|road-closed|no-motor|no-heavy|maximum-(weight|height|width)|one-way|roundabout|children|school|roadworks|road-works|dangerous|curve|narrow/.test(x.value);
}
// Nākamā zīme priekšā: ar maršrutu — pa maršrutu; bez maršruta — pa ceļu, pa kuru
// braucu (līdz krustojumam), nevis vienkārši tuvākā zīme apkārt.
function updateNextSign() {
  const card = $('nextSign');
  let next = null, d = 0;
  if (state.signsOn && state.nav.active && state.nav.along != null) {
    next = signs.routeSignsAhead(state.nav.along + 3, 700, isNoticeSign)[0];
    if (next) d = next.along - state.nav.along;
  } else if (state.signsOn && !state.nav.route && state.me && state.heading != null &&
             (state.me.speedKmh ?? 0) > 8 && state.gpsQuality !== 'poor') {
    next = signs.signsAheadOnRoad(state.me.lat, state.me.lng, state.heading, state.me.accuracy || 10, 400, isNoticeSign)[0];
    if (next) d = next.along;
  }
  if (!next) { card.hidden = true; return; }
  if ($('nextSignImg').dataset.src !== next.s.src) { $('nextSignImg').src = next.s.src; $('nextSignImg').dataset.src = next.s.src; }
  $('nextSignDist').textContent = d < 30 ? 'Tagad' : 'Pēc ' + navDist(d);
  const ti = signTimeInfo(next.s);
  const r = next.s.restriction;
  $('nextSignTitle').textContent = describeRestriction(next.s.title, r) +
    (ti && ti.off ? ' (tagad nav spēkā)' : '') + (next.s.conflict ? ' (pretrunīgi dati)' : '') +
    (next.status === 'probable' ? (next.reason === 'after-junction' ? ' (ja brauksi taisni)' : ' (virziens nav apstiprināts)') : '') +
    (next.reason === 'lane-maybe' ? ' (var attiekties uz joslu)' : '');
  card.hidden = false;
}
// Maršruta kartītē: cik un kādas zīmes būs pa ceļam.
function updateRouteSummary() {
  if (!state.nav.route || state.nav.active) return;
  const list = signs.routeSignsAhead(-1, Infinity, isNoticeSign).map(it => it.s);
  if (!list.length) { $('routeSigns').textContent = state.mlyToken ? 'Meklē zīmes pa ceļam…' : ''; return; }
  const n = c => list.filter(x => x.cat === c).length;
  const limits = [...new Set(list.filter(x => x.cat === 'speed' && x.limit >= 20).map(x => x.limit))].sort((a, b) => a - b);
  const parts = [];
  if (limits.length) parts.push('Ātrums ' + (limits.length > 1 ? `${limits[0]}–${limits[limits.length - 1]}` : limits[0]) + ' km/h');
  if (n('camera')) parts.push(`${n('camera')} ātruma kam.`);
  if (n('rail')) parts.push(`${n('rail')} dzelzceļa pārbr.`);
  if (n('calming')) parts.push(`${n('calming')} ātrumvaļņi`);
  if (n('signals')) parts.push(`${n('signals')} luksofori`);
  $('routeSigns').textContent = parts.length ? 'Pa ceļam: ' + parts.join(' · ') : '';
}

async function reroute() {
  state.nav.lastReroute = Date.now();
  state.nav.offCount = 0;
  setBusy('route', 'Pārrēķina maršrutu…');
  try {
    const route = await requestRoute(state.me, state.nav.dest);
    state.nav.route = route;
    state.nav.along = null;
    drawRoute(route);
    signs.setRoute(route);
    prepareRoute(route);
  } catch (err) { console.warn('Pārrēķins neizdevās', err); }
  finally { setBusy('route', null); }
}

// Testa režīmā: simulēts brauciens pa maršrutu (50 km/h), lai var izmēģināt mājās.
let simTimer = null;
function startSimulation() {
  stopSimulation();
  const route = state.nav.route;
  if (!route) return;
  let along = 0;
  const total = route.cum[route.cum.length - 1];
  const tick = () => {
    if (!state.nav.active || state.nav.route !== route) return stopSimulation();
    along = Math.min(total, along + 50 / 3.6);
    let i = 1;
    while (i < route.cum.length - 1 && route.cum[i] < along) i++;
    const a = route.coords[i - 1], b = route.coords[i];
    const seg = route.cum[i] - route.cum[i - 1] || 1;
    const t = Math.max(0, Math.min(1, (along - route.cum[i - 1]) / seg));
    const lng = a[0] + (b[0] - a[0]) * t, lat = a[1] + (b[1] - a[1]) * t;
    onFix(lat, lng, 50, bearingDeg(a[1], a[0], b[1], b[0]), 1000);
    if (along >= total) stopSimulation();
  };
  tick();
  simTimer = setInterval(tick, 1000);
}
function stopSimulation() { clearInterval(simTimer); simTimer = null; }

// ---------- Saskarne ----------
function applySignVisibility() {
  signs.setEnabled(state.signsOn);
  signs.setFilter(s => state.cats[s.cat] && signFitsProfile(s, state.profile));
  const btn = $('toggleSigns');
  btn.setAttribute('aria-pressed', String(state.signsOn));
  btn.classList.toggle('off', !state.signsOn);
  $('toggleSignsLabel').textContent = state.signsOn ? 'Zīmes' : 'Izslēgtas';
  $('masterSwitch').checked = state.signsOn;
  $('catList').classList.toggle('disabled', !state.signsOn);
}

function buildCategoryList() {
  const list = $('catList');
  const sample = { speed: { kind: 'speed', value: 50 }, priority: { kind: 'stop' }, signals: { kind: 'signals' },
    crossing: { kind: 'crossing' }, camera: { kind: 'camera' }, calming: { kind: 'bump' }, rail: { kind: 'rail' }, other: { kind: 'other' } };
  for (const [key, cat] of Object.entries(SIGN_CATEGORIES)) {
    const row = document.createElement('label');
    row.className = 'row cat';
    row.innerHTML = `<span class="cat-icon">${signSvg(sample[key], 26)}</span><span class="cat-name"></span>
      <input type="checkbox" class="switch" id="cat-${key}">`;
    row.querySelector('.cat-name').textContent = cat.label;
    const input = row.querySelector('input');
    input.checked = state.cats[key];
    input.addEventListener('change', () => {
      state.cats[key] = input.checked;
      store.set('cats', state.cats);
      applySignVisibility();
    });
    list.appendChild(row);
  }
}

function toggleSettings(open) {
  $('settings').hidden = !open;
  $('settingsBtn').setAttribute('aria-expanded', String(open));
}

async function applyBasemap(choice) {
  const bm = await loadBasemapStyle(choice);
  state.vector = bm.vector;
  map.setStyle(bm.style, { diff: false });
}

function wireUi() {
  $('toggleSigns').addEventListener('click', () => {
    state.signsOn = !state.signsOn; store.set('signsOn', state.signsOn); applySignVisibility();
  });
  $('masterSwitch').addEventListener('change', e => {
    state.signsOn = e.target.checked; store.set('signsOn', state.signsOn); applySignVisibility();
  });
  // Transportlīdzeklis: rāda tikai tā vadītājam noderīgās zīmes.
  const prof = $('profileSelect');
  for (const [key, p] of Object.entries(VEHICLE_PROFILES)) prof.add(new Option(p.label, key));
  prof.value = state.profile;
  prof.addEventListener('change', () => {
    state.profile = prof.value; store.set('profile', state.profile); applySignVisibility();
    if (state.nav.route) updateRouteSummary();
  });
  $('warnSwitch').checked = state.warn;
  $('warnSwitch').addEventListener('change', e => { state.warn = e.target.checked; store.set('warn', state.warn); updateLimit(); });
  $('testSwitch').addEventListener('change', e => {
    state.testMode = e.target.checked;
    if (!state.testMode) stopSimulation();
    else if (state.nav.active) startSimulation();
    setStatus(state.testMode ? 'Testa režīms: noklikšķini uz ceļa kartē vai sāc maršrutu — tas tiks nobraukts automātiski.' : 'Testa režīms izslēgts.');
  });
  $('centerBtn').addEventListener('click', () => {
    state.follow = true;
    if (state.me) followCamera(800);
    else { setStatus(gpsProblem || 'Meklē atrašanās vietu…'); startGps(); }
  });
  $('settingsBtn').addEventListener('click', () => toggleSettings($('settings').hidden));
  $('closeSettings').addEventListener('click', () => toggleSettings(false));

  // Galamērķis
  const input = $('searchInput');
  input.addEventListener('input', () => {
    const q = input.value.trim();
    $('clearSearch').hidden = !input.value;
    clearTimeout(searchTimer);
    if (q.length < 3) { $('results').hidden = true; return; }
    searchTimer = setTimeout(() => runSearch(q, false), 300);
  });
  input.addEventListener('focus', () => { if (lastResults.length && input.value.trim().length >= 3) showResults(lastResults); });
  $('searchForm').addEventListener('submit', e => {
    e.preventDefault();
    const q = input.value.trim();
    if (q.length < 2) return;
    clearTimeout(searchTimer);
    runSearch(q, true);
  });
  $('clearSearch').addEventListener('click', () => {
    input.value = ''; $('clearSearch').hidden = true; $('results').hidden = true;
    if (!state.nav.active && state.nav.route) cancelPreview();
    input.focus();
  });
  $('startNav').addEventListener('click', startNav);
  $('cancelRoute').addEventListener('click', cancelPreview);
  $('endNav').addEventListener('click', endNav);

  // Kartes stils
  const sel = $('basemapSelect');
  for (const [key, b] of Object.entries(BASEMAP_STYLES)) sel.add(new Option(b.label, key));
  sel.value = state.basemap;
  sel.addEventListener('change', () => { state.basemap = sel.value; store.set('basemap', state.basemap); applyBasemap(state.basemap); });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (state.basemap === 'auto') applyBasemap('auto');
  });

  // Mapillary atslēga
  const tokenInput = $('mlyToken');
  tokenInput.value = state.mlyToken;
  const note = () => { $('mlyNote').textContent = state.mlyToken ? 'Atslēga saglabāta šajā ierīcē. Mapillary zīmes ir ieslēgtas.' : 'Bez atslēgas rāda tikai OpenStreetMap zīmes.'; };
  $('mlySave').addEventListener('click', () => {
    const v = tokenInput.value.trim();
    if (v && !v.startsWith('MLY|')) { $('mlyNote').textContent = 'Atslēgai jāsākas ar MLY| — nokopē "Client Token" no Mapillary.'; return; }
    state.mlyToken = v; store.set('mlyToken', v); state.mlyTiles.clear(); note(); loadMapillaryForView();
  });
  note();
}

function cancelPreview() {
  state.nav.route = null; state.nav.dest = null;
  routePrepId++;
  setBusy('prep', null);
  signs.setRoute(null);
  drawRoute(null);
  if (destMarker) { destMarker.remove(); destMarker = null; }
  $('routeCard').hidden = true;
  $('bottombar').hidden = false;
  document.documentElement.classList.remove('previewing');
}

// ---------- Starts ----------
async function init() {
  const bm = await loadBasemapStyle(state.basemap);
  state.vector = bm.vector;
  map = new maplibregl.Map({
    container: 'map', style: bm.style,
    center: [START[1], START[0]], zoom: 15,
    maxPitch: 65, fadeDuration: 250, renderWorldCopies: false,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    attributionControl: { compact: true },
  });
  signs = new SignStore(map);
  signs.decorate = signTimeInfo;
  setInterval(() => { signs.refresh(); updateLimit(); }, 60000); // laika ierobežojumi mainās

  map.on('style.load', () => {
    installRouteLayers();
    signs.install();
    roadIndex.ready = false; roadIndex.coverage = null;
    signs.setRoads(state.vector ? roadIndex : null);
    if (state.nav.route) drawRoute(state.nav.route);
    applySignVisibility();
  });
  // Ceļi zīmju piesaistei: pārbūvē, kad kartē ielādēti jauni ceļi — arī braucot
  // (agrāk to darīja tikai, kad karte apstājās, tāpēc braucot zīmes kavējās).
  let lastRoadKey = '', roadTimer = null, lastRoadAt = 0, roadGen = 0;
  const scheduleRoads = () => {
    if (!state.vector || roadTimer) return;
    roadTimer = setTimeout(() => {
      roadTimer = null;
      let loaded = false;
      try { loaded = !!map.getSource('openmaptiles') && map.isSourceLoaded('openmaptiles'); } catch { return; }
      if (!loaded) return scheduleRoads(); // gaida, kamēr ielādējas
      const b = map.getBounds();
      const key = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast(), map.getZoom()].map(v => v.toFixed(4)).join() + ':' + roadGen;
      if (key === lastRoadKey) return;
      lastRoadKey = key;
      lastRoadAt = performance.now();
      if (roadIndex.rebuild(map)) signs.roadsChanged();
    }, Math.max(150, 900 - (performance.now() - lastRoadAt)));
  };
  map.on('idle', scheduleRoads);
  map.on('moveend', scheduleRoads);
  map.on('sourcedata', e => { if (e.sourceId === 'openmaptiles' && e.tile) { roadGen++; scheduleRoads(); } });
  map.on('resize', () => { clearTimeout(init._fit); init._fit = setTimeout(fitRoute, 250); });
  map.on('styleimagemissing', e => { if (/^(mly|own):/.test(e.id)) signs.loadImage(e.id); });
  map.on('moveend', () => { signs.refresh(); clearTimeout(init._t); init._t = setTimeout(loadAllForView, 150); });
  for (const ev of ['dragstart', 'rotatestart', 'pitchstart']) {
    map.on(ev, e => { if (e.originalEvent) state.follow = false; });
  }
  map.on('click', 'signs', e => {
    const f = e.features && e.features[0];
    if (!f) return;
    const el = document.createElement('div');
    const b = document.createElement('div'); b.textContent = f.properties.title; el.appendChild(b);
    if (f.properties.info) {
      const i = document.createElement('div'); i.className = 'popup-time'; i.textContent = f.properties.info; el.appendChild(i);
    }
    const popup = new maplibregl.Popup({ closeButton: false, offset: 18, maxWidth: '270px' })
      .setLngLat(f.geometry.coordinates).setDOMContent(el).addTo(map);
    if (f.properties.mid && state.mlyToken) showSignPhoto(el, f.properties.mid, popup);
  });
  map.on('mouseenter', 'signs', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'signs', () => { map.getCanvas().style.cursor = ''; });
  map.on('click', e => {
    $('results').hidden = true;
    if (map.getLayer('signs') && map.queryRenderedFeatures(e.point, { layers: ['signs'] }).length) return;
    if (state.testMode && !state.nav.active) { state.follow = false; onFix(e.lngLat.lat, e.lngLat.lng, 55, null, 300); }
  });

  wireUi();
  buildCategoryList();
  loadVerifiedSigns();
  loadPlateTimes();
  startGps();
  map.once('load', loadAllForView);
}

init();
