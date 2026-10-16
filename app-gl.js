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
  profile: 'car',   // vienmēr vieglais automobilis (izvēle no iestatījumiem noņemta)
  mapMode: 'alerts', // kartē vienmēr tikai brīdinājumi (kā Waze); visu zīmju režīms vairs netiek piedāvāts
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

// Zīmes, kurām Mapillary virziena nav — atceras 7 dienas, lai tās katru reizi nepieprasītu no jauna.
const NODIR_MAX_AGE = 7 * 24 * 3600 * 1000;
const noDirCache = new Map(Object.entries(store.get('nodir', {})).filter(([, t]) => Date.now() - t < NODIR_MAX_AGE));
let noDirSaveTimer = null;
function rememberNoDir(keys) {
  const now = Date.now();
  for (const k of keys) noDirCache.set(k, now);
  clearTimeout(noDirSaveTimer);
  noDirSaveTimer = setTimeout(() => {
    let entries = [...noDirCache];
    if (entries.length > 20000) entries = entries.slice(-20000);
    store.set('nodir', Object.fromEntries(entries));
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
  node["hazard"](${bb});
  way["hazard"]["highway"](${bb});
  way["highway"="construction"](${bb});
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

// Abi Overpass serveri paralēli — ņem ātrāko; ilgāk par 35 s negaida (serveri bieži pārslogoti).
// Vienādi vaicājumi, kas notiek vienlaikus, tiek sūtīti tikai vienreiz.
function fetchOverpass(query, timeoutMs = 35000) {
  return onceInflight('ovp|' + query, () => {
    const controllers = OVERPASS_URLS.map(() => new AbortController());
    const timer = setTimeout(() => controllers.forEach(c => c.abort()), timeoutMs);
    const attempts = OVERPASS_URLS.map(async (url, i) => {
      const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), signal: controllers[i].signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      controllers.forEach((c, j) => { if (j !== i) c.abort(); });
      return json;
    });
    return Promise.any(attempts).finally(() => clearTimeout(timer));
  });
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
      const limit = parseMaxspeed(el.tags.maxspeed);
      if (!limit) continue;
      const pts = el.geometry.map(p => [p.lat, p.lon]);
      state.ways.set(el.id, { limit, pts });
      indexWay(limit, pts, speedCondition(el.tags));
      added += addWaySpeedSign(pts, limit);
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
  const counts = new Map(), asked = [];
  signs.eachInBox(s, w, n, e, x => {
    if (!x.value || x.face != null || !signNeedsDirection(x)) return;   // liekās zīmes izlaiž
    const k = faceKey(x.value, x.lat, x.lng);
    if (noDirCache.has(k)) return;               // jau zināms, ka virziena nav
    asked.push(x);
    counts.set(x.value, (counts.get(x.value) || 0) + 1);
  });
  if (!counts.size) return 0;
  const found = await fetchMapillaryDirectionsArea(w, s, e, n, state.mlyToken, counts);
  let matched = 0;
  for (const f of found) {
    const x = signs.findNear(f.lat, f.lng, 5, z => z.value === f.value && z.face == null);
    if (x) { x.face = MLY_DIR_IS_FACE ? f.dir : (f.dir + 180) % 360; signs.faceChanged(x); rememberFace(x); matched++; }
  }
  rememberNoDir(asked.filter(x => x.face == null).map(x => faceKey(x.value, x.lat, x.lng)));
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

// ---------- Bultas krāsa (iestatījumos 10 krāsas) ----------
// No vienas pamatkrāsas aprēķina visus toņus: gaišo un tumšo šķautni, biezumu un lodītes atspīdumu.
const ARROW_COLORS = [
  { id: 'green',  label: 'Zaļa',      hex: '#74C476' },
  { id: 'blue',   label: 'Zila',      hex: '#3B8BFF' },
  { id: 'cyan',   label: 'Tirkīza',   hex: '#33CDF0' },
  { id: 'purple', label: 'Violeta',   hex: '#8B5CF6' },
  { id: 'pink',   label: 'Rozā',      hex: '#EC4899' },
  { id: 'red',    label: 'Sarkana',   hex: '#EF4444' },
  { id: 'orange', label: 'Oranža',    hex: '#F97316' },
  { id: 'yellow', label: 'Dzeltena',  hex: '#F5C518' },
  { id: 'slate',  label: 'Pelēka',    hex: '#64748B' },
  { id: 'black',  label: 'Melna',     hex: '#2B2F36' },
];
function mixHex(hex, to, k) {          // k = 0..1, to = [r, g, b]
  const n = parseInt(hex.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255];
  return '#' + c.map((v, i) => Math.round(v + (to[i] - v) * k).toString(16).padStart(2, '0')).join('');
}
function applyArrowColor(id) {
  const c = ARROW_COLORS.find(x => x.id === id) || ARROW_COLORS[0];
  const W = [255, 255, 255], K = [0, 0, 0], st = document.documentElement.style;
  const v = {
    t0: mixHex(c.hex, W, .55), t1: c.hex, t2: mixHex(c.hex, K, .12),
    r0: mixHex(c.hex, K, .1), r1: mixHex(c.hex, K, .3),
    s0: mixHex(c.hex, K, .55), s1: mixHex(c.hex, K, .7),
    b0: mixHex(c.hex, W, .7), b2: mixHex(c.hex, K, .3),
  };
  for (const [k, val] of Object.entries(v)) st.setProperty('--me-' + k, val);
  for (const b of document.querySelectorAll('#arrowColors [data-color]')) b.setAttribute('aria-pressed', String(b.dataset.color === c.id));
  state.arrowColor = c.id;
}
function wireArrowColors() {
  const box = $('arrowColors');
  for (const c of ARROW_COLORS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'color-swatch'; b.dataset.color = c.id;
    b.title = c.label; b.setAttribute('aria-label', 'Bultas krāsa: ' + c.label);
    b.style.setProperty('--sw', c.hex);
    b.addEventListener('click', () => { applyArrowColor(c.id); store.set('arrowColor', c.id); });
    box.appendChild(b);
  }
  applyArrowColor(store.get('arrowColor', 'green'));
}

// ---------- Mana atrašanās vieta ----------
let meMarker = null, meTween = null;
function createMeMarker(lng, lat) {
  const el = document.createElement('div');
  el.className = 'me-icon';
  // 3D bulta kā Waze: maigi zaļa virsma (#74C476) ar šķautni, bieza balta mala, tumši zaļš "sāns" (biezums)
  // un ēna; ap to gaiši pelēks aplis, kas viegli pulsē. Kamēr virziens nav zināms — spīdīga lodīte.
  el.innerHTML = `<div class="me-halo"></div>
    <svg class="me-arrow" viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="meTop" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--me-t0)"/><stop offset=".55" style="stop-color:var(--me-t1)"/><stop offset="1" style="stop-color:var(--me-t2)"/></linearGradient>
        <linearGradient id="meRight" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--me-r0)"/><stop offset="1" style="stop-color:var(--me-r1)"/></linearGradient>
        <linearGradient id="meSide" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--me-s0)"/><stop offset="1" style="stop-color:var(--me-s1)"/></linearGradient>
        <filter id="meBlur" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="2.4"/></filter>
        <radialGradient id="meBall" cx=".38" cy=".32" r=".75"><stop offset="0" style="stop-color:var(--me-b0)"/><stop offset=".5" style="stop-color:var(--me-t1)"/><stop offset="1" style="stop-color:var(--me-b2)"/></radialGradient>
      </defs>
      <g class="me-chevron">
        <path d="M32 13 52 47 32 39 12 47Z" fill="rgba(10,20,50,.45)" stroke="rgba(10,20,50,.45)" stroke-width="6" stroke-linejoin="round" filter="url(#meBlur)" transform="translate(0 8)"/>
        <path d="M32 13 52 47 32 39 12 47Z" fill="url(#meSide)" stroke="#fff" stroke-width="6.5" stroke-linejoin="round" transform="translate(0 5)"/>
        <path d="M32 13 52 47 32 39 12 47Z" fill="url(#meSide)" stroke="url(#meSide)" stroke-width="3" stroke-linejoin="round" transform="translate(0 5)"/>
        <path d="M32 13 52 47 32 39 12 47Z" fill="#fff" stroke="#fff" stroke-width="6.5" stroke-linejoin="round"/>
        <path d="M32 13 32 39 12 47Z" fill="url(#meTop)" stroke="url(#meTop)" stroke-width="1" stroke-linejoin="round"/>
        <path d="M32 13 52 47 32 39Z" fill="url(#meRight)" stroke="url(#meRight)" stroke-width="1" stroke-linejoin="round"/>
        <path d="M30.8 17.5 17.4 41.5" stroke="rgba(255,255,255,.7)" stroke-width="1.5" stroke-linecap="round"/>
      </g>
      <g class="me-ball">
        <ellipse cx="32" cy="37" rx="10" ry="4" fill="rgba(10,20,50,.35)" filter="url(#meBlur)"/>
        <circle cx="32" cy="32" r="11" fill="#fff"/>
        <circle cx="32" cy="32" r="8.4" fill="url(#meBall)"/>
        <ellipse cx="29.3" cy="28.7" rx="3.1" ry="2" fill="rgba(255,255,255,.8)"/>
      </g>
    </svg>`;
  meMarker = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' })
    .setLngLat([lng, lat]).addTo(map);
}
// Bulta slīd uz jauno vietu vienmērīgi (tikpat ilgi kā kamera).
function moveMeMarker(lng, lat, dur) {
  if (!meMarker) return createMeMarker(lng, lat);
  const from = meMarker.getLngLat();
  cancelAnimationFrame(meTween);
  cancelAnimationFrame(navAnim);
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
  // Navigācijā kamera seko bultai uz maršruta (tur, kur tā būs pēc animācijas).
  const c = state.nav.active && state.nav.onRoute && state.nav.target != null ? routePointAt(state.nav.route, state.nav.target) : null;
  map.easeTo({
    center: c ? [c.lng, c.lat] : [state.me.lng, state.me.lat],
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
  // Navigācijā bulta brauc pa maršruta līniju, nobrauktā daļa aiz tās pazūd.
  let onRoute = false;
  if (state.nav.active && state.nav.route && state.gpsQuality !== 'poor') {
    const loc = locateOnRoute(state.nav.route, lat, lng);
    if (loc.off <= ROUTE_SNAP_M) {
      state.nav.target = smoothProgress(state.nav.target, loc.along);
      navShow(state.nav.target, state.follow ? dur : 300);
      onRoute = true;
    }
  }
  state.nav.onRoute = onRoute;
  if (!onRoute) moveMeMarker(lng, lat, state.follow ? dur : 300);
  $('speedValue').textContent = speedKmh == null ? '–' : Math.round(speedKmh);
  // Vājš signāls: neatjauno braukšanas virzienu (tas lēkātu) un brīdina.
  setBusy('gps', state.gpsQuality === 'poor' ? `Vājš GPS signāls (±${Math.round(accuracy)} m) — zīmes var būt neprecīzas` : null);
  if (state.gpsQuality !== 'poor') updateHeading(lat, lng, gpsHeading, speedKmh);
  // Kartes piesaiste ar vēsturi: uz kura ceļa posma esmu (zīmju atlasei un ātrumam).
  signs.setPosition(lat, lng, state.heading, accuracy == null ? 10 : accuracy);
  updateLimit();
  loadDirectionsNearMe();
  loadWeather(false);
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
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=7&lat=${c.lat.toFixed(2)}&lon=${c.lng.toFixed(2)}`;
  // Tas pats teksts ~1 km apkārtnē — no kešatmiņas (1 diena)
  const json = await cachedJson('photon', q.toLowerCase() + '@' + c.lat.toFixed(2) + ',' + c.lng.toFixed(2), 24 * 3600 * 1000,
    () => fetchJson(url, {}, 7000));
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
  const json = await cachedJson('nominatim', q.toLowerCase(), 24 * 3600 * 1000, () => fetchJson(url, {}, 8000));
  return json.map(it => {
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
// Maršruta līnija. along — cik metru jau nobraukts: tad zīmē TIKAI atlikušo daļu
// (no bultas līdz galamērķim pa maršruta punktiem). Viens avots — vecās līnijas nepaliek.
function drawRoute(route, along = null) {
  const src = map.getSource('route');
  if (src) src.setData(route ? { type: 'Feature', geometry: { type: 'LineString', coordinates: routeRemaining(route, along) }, properties: {} } : EMPTY_FC);
}

// ---------- Bulta uz maršruta; nobrauktā daļa pazūd aiz tās ----------
// Navigācijā bultu novieto uz maršruta (kartes piesaiste maršrutam) un kopā ar to
// vienmērīgi (pa maršruta līkumiem) pārvieto līnijas sākumu. GPS svārstības atpakaļ
// neņem vērā (smoothProgress), tāpēc līnija nelēkā un nobrauktā daļa neatgriežas.
const ROUTE_SNAP_M = 30;     // tālāk par šo no maršruta — bulta rāda GPS vietu, līnija netiek griezta
let navAnim = 0, lastRouteDraw = 0;
function navShow(target, dur) {
  const route = state.nav.route;
  if (!route) return;
  cancelAnimationFrame(navAnim);
  cancelAnimationFrame(meTween);
  const from = state.nav.shown == null ? target : state.nav.shown;
  const place = (a, force) => {
    state.nav.shown = a;
    const p = routePointAt(route, a);
    if (meMarker) meMarker.setLngLat([p.lng, p.lat]); else createMeMarker(p.lng, p.lat);
    const now = performance.now();
    if (force || now - lastRouteDraw > 200) { lastRouteDraw = now; drawRoute(route, a); }   // ~5 reizes sekundē (vieglāk telefonam)
  };
  if (!dur || Math.abs(target - from) > 400) return place(target, true);
  const t0 = performance.now();
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / dur);
    place(from + (target - from) * k, k === 1);
    if (k < 1) navAnim = requestAnimationFrame(step);
  };
  step();
}
function resetNavProgress() {
  cancelAnimationFrame(navAnim);
  state.nav.target = null;
  state.nav.shown = null;
}

// Maršruts: tas pats sākums (~10 m) un galamērķis 10 min laikā — no kešatmiņas (piem. atkārtoti atverot to pašu vietu).
async function cachedRoute(from, to) {
  const key = from.lat.toFixed(4) + ',' + from.lng.toFixed(4) + '>' + to.lat.toFixed(5) + ',' + to.lng.toFixed(5);
  const hit = await cacheGet('route', key, 10 * 60000);
  if (hit) return structuredClone(hit);          // kopija — navigācija maina maršruta stāvokli
  const route = await onceInflight('route|' + key, () => requestRoute(from, to));
  cachePut('route', key, structuredClone(route));
  return route;
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
    const route = await cachedRoute(from, dest);
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

// ---------- Balss norādes un ekrāns ----------
const voice = new Voice();
voice.enabled = store.get('voiceOn', true);
// Dabiskā balss (neironu tīkls telefonā): Rūdolfs / Aivars; "system" — telefona iebūvētā balss.
const neuralVoice = typeof NeuralVoice !== 'undefined' ? new NeuralVoice() : null;
// Ierakstītā Google balss (ja lapā ir voice/lv/manifest.json) — pēc noklusējuma, kad pieejama.
const recordedVoice = typeof RecordedVoice !== 'undefined' ? new RecordedVoice() : null;
if (recordedVoice) recordedVoice.onFail = parts => voice._fallback(parts.join(' '), parts, false);
let voiceKind = store.get('voiceKind', null) || 'rudolfs';
const voiceKindChosen = !!store.get('voiceKind', null);
async function loadRecordedVoice() {
  if (!recordedVoice || !(await recordedVoice.load())) {
    if (voiceKind === 'google') {          // ieraksti vairs nav pieejami → dabiskā balss
      voiceKind = 'rudolfs'; if ($('voiceKind')) $('voiceKind').value = voiceKind;
      voice.recorded = null; loadNeuralVoice(false);
    }
    return false;
  }
  const sel = $('voiceKind');
  if (sel && !sel.querySelector('option[value="google"]')) {
    const o = document.createElement('option');
    o.value = 'google'; o.textContent = `${recordedVoice.label} (ieraksti)`;
    sel.insertBefore(o, sel.firstChild);
  }
  // Pirmo reizi, kad ieraksti parādās, pārslēdz uz tiem (vēlāk lietotāja izvēle tiek ievērota).
  if (!voiceKindChosen || !store.get('voiceGoogleOffered', false)) { voiceKind = 'google'; store.set('voiceKind', voiceKind); }
  store.set('voiceGoogleOffered', true);
  if (sel) sel.value = voiceKind;
  applyVoiceKind();
  recordedVoice.warm();          // saglabā telefonā fonā (~2–3 MB), lai strādā bez interneta
  return true;
}
// Izvēlētā balss → kura balss runā pirmā (pārējās paliek rezervē).
function applyVoiceKind() {
  voice.recorded = voiceKind === 'google' && recordedVoice && recordedVoice.ready ? recordedVoice : null;
  if (voice.recorded) voiceNote(`Balss "${recordedVoice.label}" ir gatava (ieraksti saglabāti telefonā, darbojas arī bez interneta).`);
}
function voiceNote(text) { const el = $('voiceNote'); if (el) el.textContent = text; }
// Ielādē dabisko balsi. download=false — tikai, ja jau ir telefonā (nekad nelejupielādē klusi).
async function loadNeuralVoice(download) {
  if (!neuralVoice || !NEURAL_VOICES[voiceKind]) { voice.neural = null; return; }
  const kind = voiceKind;
  if (!download && !(await neuralVoice.isDownloaded(kind))) {
    voiceNote('Dabiskā balss vēl nav telefonā (~63 MB, vienreiz). Tā lejupielādēsies, nospiežot "Pārbaudīt" vai sākot navigāciju — ieteicams Wi-Fi.');
    return;
  }
  try {
    await neuralVoice.load(kind, p => voiceNote(`Lejupielādē balsi "${NEURAL_VOICES[kind].label}"… ${Math.round(p * 100)}%`));
    if (kind !== voiceKind) return;
    voice.neural = neuralVoice;
    voiceNote(`Dabiskā balss "${NEURAL_VOICES[kind].label}" ir gatava (darbojas arī bez interneta).`);
    setTimeout(() => neuralVoice.prefetch(['Esi ieradies galamērķī', 'Maršruts pārrēķināts', 'galamērķis', ...voiceDistancePhrases(),
      'pagriezies pa labi', 'pagriezies pa kreisi', 'nogriezies pa labi', 'nogriezies pa kreisi']), 3000);
  } catch (err) {
    console.warn('Dabiskā balss nav ielādēta', err);
    voice.neural = null;
    voiceNote('Neizdevās ielādēt dabisko balsi — runās telefona balss.');
  }
}
const screenAwake = new ScreenAwake();
let voiceSaid = new Set();
document.addEventListener('visibilitychange', () => screenAwake.resume());
function voiceSay(item, urgent) { if (item) voice.say(item.text, urgent, item.parts); }
let voicePrefetched = -1;
// Par katru manevru — viens īss teikums īsi pirms tā (bez ielas nosaukuma, bez atkārtojumiem).
function voiceNav(p) {
  const route = state.nav.route;
  const id = route.steps.indexOf(p.next);
  const v = state.me ? state.me.speedKmh : 0;
  const after = route.steps[id + 1] || null;
  const gapAfter = after ? route.cum[after._start] - route.cum[p.next._start] : Infinity;
  // Dabiskā balss: nākamā manevra teikumu sagatavo jau tagad, lai pēc tam runātu bez aizkaves
  if (voicePrefetched !== id) {
    voicePrefetched = id;
    if (voiceWorthy(p.next)) {
      const w = [voiceManeuverShort(p.next)];
      if (after && voiceWorthy(after) && gapAfter < 120) w.push(voiceThen(after));
      voice.prefetch([...w, upperFirst(w[0]), voiceDistance(voiceThresholds(v).near)]);
    }
  }
  const item = voiceForManeuver(id, p.next, p.toNext, v, voiceSaid, after, gapAfter);
  if (item) voiceSay(item, false);
}
function voiceAlert(key, label, d) {
  if (!state.me || ((state.me.speedKmh ?? 0) < 8 && !state.nav.active)) return;
  voiceSay(voiceForAlert(key, label, d, state.me.speedKmh, voiceSaid), false);
}

function startNav() {
  if (!state.nav.route) return;
  voice.unlock();                    // telefoni atļauj runāt tikai pēc pieskāriena
  screenAwake.on();                  // ekrāns neizslēdzas, kamēr navigē
  if (voice.enabled && !voice.neural && !voice.recorded && NEURAL_VOICES[voiceKind]) loadNeuralVoice(true);   // pirmajā reizē lejupielādē
  voiceSaid = new Set(); voicePrefetched = -1;
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
  resetNavProgress();
  drawRoute(state.nav.route);
  if (state.testMode) startSimulation();
  else if (state.me) onFix(state.me.lat, state.me.lng, state.me.speedKmh, null, 1200, state.me.accuracy);
}

function endNav() {
  screenAwake.off();
  voice.stop();
  stopSimulation();
  resetNavProgress();
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
    if (!voiceSaid.has('arrived')) { voiceSaid.add('arrived'); voice.say('Esi ieradies galamērķī', false, ['Esi ieradies galamērķī']); }
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
  if (state.gpsQuality !== 'poor' && p.loc.off < 50) voiceNav(p);
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
  const alertsMode = state.mapMode === 'alerts';
  const test = alertsMode ? (x => !!alertTypeForSign(x)) : isNoticeSign;
  let next = null, d = 0;
  if (state.signsOn && state.nav.active && state.nav.along != null) {
    next = signs.routeSignsAhead(state.nav.along + 3, 700, test)[0];
    if (next) d = next.along - state.nav.along;
  } else if (state.signsOn && !state.nav.route && state.me && state.heading != null &&
             (state.me.speedKmh ?? 0) > 8 && state.gpsQuality !== 'poor') {
    next = signs.signsAheadOnRoad(state.me.lat, state.me.lng, state.heading, state.me.accuracy || 10, 400, test)[0];
    if (next) d = next.along;
  }
  // Brīdinājumu režīmā: arī ziņojumi / OSM notikumi priekšā uz mana ceļa.
  if (alertsMode && state.signsOn) {
    const a = nextAlertAhead();
    if (a && (!next || a.dist < d)) {
      next = null; d = a.dist;
      setNextCard(alertDataUrl(a.it.type), d, ALERT_TYPES[a.it.type].label + (a.it.source === 'user' ? ' (tavs ziņojums)' : ''));
      voiceAlert(a.it.id, ALERT_TYPES[a.it.type].label, d);
      return;
    }
  }
  if (!next) { card.hidden = true; return; }
  if (alertsMode) {
    const t = alertTypeForSign(next.s);
    const ti = signTimeInfo(next.s);
    if (t !== 'traffic-light' && next.status !== 'probable' && !(ti && ti.off)) voiceAlert(next.s.uid, ALERT_TYPES[t].label, d);
    setNextCard(alertDataUrl(t), d, (t === 'restriction' ? describeRestriction(next.s.title, next.s.restriction) : ALERT_TYPES[t].label) +
      (next.status === 'probable' ? (next.reason === 'after-junction' ? ' (ja brauksi taisni)' : ' (virziens nav apstiprināts)') : '') +
      (ti && ti.off ? ' (tagad nav spēkā)' : ''));
    return;
  }
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
  if (state.mapMode === 'alerts') return updateRouteAlertSummary();
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
    const route = await cachedRoute(state.me, state.nav.dest);
    state.nav.route = route;
    state.nav.along = null;
    resetNavProgress();              // jauns maršruts sākas no manis — līnija no jauna
    voiceSaid = new Set([...voiceSaid].filter(k => k.startsWith('alert:')));   // manevri no jauna, brīdinājumi ne
    voice.say('Maršruts pārrēķināts', true, ['Maršruts pārrēķināts']); voicePrefetched = -1;   // urgent: vecās norādes vairs neder
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

// ---------- Brīdinājumi (kā Waze) ----------
// Notikumi, kas nav ceļa zīmes: lietotāja ziņojumi, OSM būvdarbi / bīstamas vietas.
// Laikapstākļi — josla zem meklēšanas (tie attiecas uz apkārtni, ne vienu punktu).
let alerts = null;

// OSM objekts → brīdinājums (būvējams ceļš, hazard=*). Mezglam — tā vieta, ceļam — vidus.
function readOsmAlert(el) {
  const type = alertTypeForOsm(el.tags);
  if (!type || !alerts) return;
  const id = 'osm:' + el.type + el.id;
  if (alerts.items.has(id)) return;
  let lat = el.lat, lng = el.lon;
  if (el.type === 'way' && el.geometry && el.geometry.length) {
    const g = el.geometry[Math.floor(el.geometry.length / 2)];
    lat = g.lat; lng = g.lon;
  }
  if (lat == null) return;
  const name = el.tags.name ? el.tags.name + ' — ' : '';
  const what = type === 'roadworks' ? 'ceļš tiek būvēts vai remontēts' : 'bīstama vieta' + (el.tags.hazard ? ' (' + el.tags.hazard.replace(/_/g, ' ') + ')' : '');
  alerts.add({ id, type, lat, lng, source: 'osm', title: ALERT_TYPES[type].label, info: name + what, createdAt: Date.now(), expiresAt: null });
  refreshAlertsSoon();
}

function installAlertLayer() {
  if (map.getSource('alerts')) return;
  map.addSource('alerts', { type: 'geojson', data: EMPTY_FC });
  map.addLayer({
    id: 'alerts', type: 'symbol', source: 'alerts',
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.55, 16, 0.85, 18.5, 1.1],
      'icon-allow-overlap': true,
      'icon-pitch-alignment': 'viewport', 'icon-rotation-alignment': 'viewport',
      'symbol-sort-key': ['get', 'prio'],
    },
  });
  refreshAlerts();
}
let alertsTimer = null;
function refreshAlertsSoon() { clearTimeout(alertsTimer); alertsTimer = setTimeout(refreshAlerts, 200); }
function refreshAlerts() {
  const src = map && map.getSource && map.getSource('alerts');
  if (!src || !alerts) return;
  const show = state.signsOn && state.mapMode === 'alerts';
  const list = show ? alerts.list() : [];
  src.setData({ type: 'FeatureCollection', features: list.map(it => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [it.lng, it.lat] },
    properties: { id: it.id, icon: 'alert:' + it.type, prio: it.source === 'user' ? 0 : 5 },
  })) });
}

function showAlertPopup(id, coords) {
  const it = alerts.items.get(id);
  if (!it) return;
  const el = document.createElement('div');
  const b = document.createElement('div'); b.textContent = ALERT_TYPES[it.type].label; el.appendChild(b);
  const i = document.createElement('div'); i.className = 'popup-time'; i.textContent = alertInfo(it); el.appendChild(i);
  const popup = new maplibregl.Popup({ closeButton: false, offset: 18, maxWidth: '270px' }).setLngLat(coords).setDOMContent(el).addTo(map);
  if (it.source === 'user') {
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'btn ghost small popup-btn'; del.textContent = 'Vairs nav — noņemt';
    del.addEventListener('click', () => { alerts.remove(id); refreshAlerts(); popup.remove(); });
    el.appendChild(del);
  }
}

// Nākamais notikums priekšā uz maršruta vai mana ceļa: { it, dist } vai null.
function nextAlertAhead() {
  if (!alerts) return null;
  let best = null;
  for (const it of alerts.list()) {
    let dist = null, bearing = null;
    if (state.nav.active && state.nav.route && state.nav.along != null) {
      const r = signs._matchRoute(it.lat, it.lng);
      if (!r || r.d > 30) continue;
      dist = r.along - state.nav.along; bearing = r.bearing;
      if (dist < 3 || dist > 1500) continue;
    } else if (!state.nav.route && signs.pos && state.heading != null) {
      const f = signs._freeApplicable();
      if (!f) continue;
      const pr = f.path.project(it.lng, it.lat);
      if (!pr || pr.d > 25) continue;
      dist = pr.along - f.path.from + 2; bearing = pr.bearing;
      if (dist < 3 || dist > 400) continue;
    } else continue;
    if (it.heading != null && bearing != null && angleDiff(it.heading, bearing) > 90) continue;   // ziņots pretējā virzienā
    if (!best || dist < best.dist) best = { it, dist };
  }
  return best;
}

function setNextCard(src, d, title) {
  const card = $('nextSign');
  if ($('nextSignImg').dataset.src !== src) { $('nextSignImg').src = src; $('nextSignImg').dataset.src = src; }
  $('nextSignDist').textContent = d < 30 ? 'Tagad' : 'Pēc ' + navDist(d);
  $('nextSignTitle').textContent = title;
  card.hidden = false;
}

// Maršruta kartītē: kādi brīdinājumi būs pa ceļam.
function updateRouteAlertSummary() {
  const counts = {};
  for (const it of signs.routeSignsAhead(-1, Infinity, x => !!alertTypeForSign(x))) {
    const t = alertTypeForSign(it.s); counts[t] = (counts[t] || 0) + 1;
  }
  for (const it of alerts ? alerts.list() : []) {
    const r = signs._matchRoute(it.lat, it.lng);
    if (r && r.d <= 30) counts[it.type] = (counts[it.type] || 0) + 1;
  }
  const order = ['police', 'police-hidden', 'camera-mobile', 'camera-fixed', 'accident', 'jam', 'closure', 'lane-closed', 'roadworks',
    'restriction', 'rail', 'school', 'traffic-light'];
  const parts = Object.keys(counts).sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99)
    .map(t => `${counts[t]} × ${ALERT_TYPES[t].label.toLowerCase()}`);
  $('routeSigns').textContent = parts.length ? 'Pa ceļam: ' + parts.join(' · ') : (state.mlyToken ? 'Meklē brīdinājumus pa ceļam…' : '');
}

// ---------- Laikapstākļi (Open-Meteo, bez atslēgas) ----------
let weatherAt = null, weatherTime = 0;
async function loadWeather(force) {
  if (!state.me) return;
  const moved = !weatherAt || distM(weatherAt[0], weatherAt[1], state.me.lat, state.me.lng) > 15000;
  if (!force && !moved && Date.now() - weatherTime < 10 * 60000) return;
  weatherAt = [state.me.lat, state.me.lng]; weatherTime = Date.now();
  try {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + state.me.lat.toFixed(3) + '&longitude=' + state.me.lng.toFixed(3) +
      '&current=temperature_2m,precipitation,rain,showers,snowfall,weather_code,wind_gusts_10m,visibility&wind_speed_unit=ms&timezone=auto';
    // ~1 km apkārtnē 10 min derīgs (arī pēc lapas pārlādes)
    const j = await cachedJson('wx', state.me.lat.toFixed(2) + ',' + state.me.lng.toFixed(2), 10 * 60000, () => fetchJson(url, {}, 8000));
    state.weather = { list: weatherAlerts(j.current), time: j.current && j.current.time };
  } catch (err) {
    console.warn('Laikapstākļi nav ielādēti', err);
    state.weather = null;
  }
  renderWeather();
}
function renderWeather() {
  const bar = $('wxBar');
  const list = state.signsOn && state.mapMode === 'alerts' && state.weather ? state.weather.list : [];
  bar.textContent = '';
  for (const w of list) {
    const chip = document.createElement('div');
    chip.className = 'wx-chip';
    chip.title = 'Laikapstākļi tavā apkārtnē · Open-Meteo' + (state.weather.time ? ' · ' + state.weather.time.slice(11, 16) : '');
    const img = document.createElement('img'); img.src = alertDataUrl(w.type); img.alt = ''; img.width = 22; img.height = 22;
    const t = document.createElement('span'); t.textContent = w.text;
    chip.append(img, t);
    bar.appendChild(chip);
  }
  bar.hidden = !list.length;
}

// ---------- Ziņot (lietotāja ziņojumi) ----------
function wireAlerts() {
  const grid = $('reportGrid');
  for (const [type, t] of Object.entries(ALERT_TYPES)) {
    if (!t.report) continue;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'report-btn';
    b.innerHTML = `<img src="${alertDataUrl(type)}" alt="" width="40" height="40"><span></span>`;
    b.querySelector('span').textContent = t.label;
    b.addEventListener('click', () => reportAlert(type));
    grid.appendChild(b);
  }
  $('reportBtn').addEventListener('click', () => { $('reportSheet').hidden = false; });
  $('closeReport').addEventListener('click', () => { $('reportSheet').hidden = true; });
  setInterval(() => loadWeather(false), 60000);
}
function reportAlert(type) {
  // Vieta: uz ceļa, kur esmu (kartes piesaiste), citādi GPS vieta.
  const p = signs.pos && !signs.pos.uncertain ? { lat: signs.pos.P[1], lng: signs.pos.P[0] } : state.me;
  if (!p) { setStatus('Atrašanās vieta vēl nav zināma — ziņojumu nevar pievienot.'); return; }
  const it = alerts.add(makeReport(type, p.lat, p.lng, state.heading));
  $('reportSheet').hidden = true;
  refreshAlerts();
  setStatus(`Paldies! „${ALERT_TYPES[type].label}” būs redzams ${ALERT_TYPES[type].ttl >= 120 ? Math.round(ALERT_TYPES[type].ttl / 60) + ' h' : ALERT_TYPES[type].ttl + ' min'} (tikai šajā ierīcē).`);
  return it;
}

// ---------- Saskarne ----------
function applySignVisibility() {
  const alertsMode = state.mapMode === 'alerts';
  signs.setEnabled(state.signsOn);
  if (alertsMode) {
    // Brīdinājumu režīms: no zīmēm rāda TIKAI brīdinājumus (kameras, pārbrauktuves, luksofori,
    // skolas zonas, šobrīd spēkā esoši ierobežojumi) ar vienotām ikonām.
    signs.setFilter(s => !!alertTypeForSign(s) && signFitsProfile(s, state.profile));
    signs.iconFor = s => 'alert:' + (alertTypeForSign(s) || 'hazard');
    signs.titleFor = s => { const t = alertTypeForSign(s); return t ? ALERT_TYPES[t].label : s.title; };
  } else {
    signs.setFilter(s => state.cats[s.cat] && signFitsProfile(s, state.profile));
    signs.iconFor = null;
    signs.titleFor = null;
  }
  signs.refresh();
  refreshAlerts();
  const btn = $('toggleSigns');
  btn.setAttribute('aria-pressed', String(state.signsOn));
  btn.classList.toggle('off', !state.signsOn);
  $('toggleSignsLabel').textContent = !state.signsOn ? 'Izslēgts' : alertsMode ? 'Brīdin.' : 'Zīmes';
  $('masterSwitch').checked = state.signsOn;
  $('catList').classList.toggle('disabled', !state.signsOn);
  $('catList').hidden = alertsMode;
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
  wireArrowColors();
  $('toggleSigns').addEventListener('click', () => {
    state.signsOn = !state.signsOn; store.set('signsOn', state.signsOn); applySignVisibility();
  });
  $('masterSwitch').addEventListener('change', e => {
    state.signsOn = e.target.checked; store.set('signsOn', state.signsOn); applySignVisibility();
  });
  // Balss norādes
  $('voiceSwitch').checked = voice.enabled;
  $('voiceSwitch').addEventListener('change', e => {
    voice.enabled = e.target.checked; store.set('voiceOn', voice.enabled);
    if (!voice.enabled) voice.stop();
  });
  const sample = ['Pēc simt piecdesmit metriem', 'pagriezies pa kreisi'];
  $('voiceKind').value = voiceKind;
  $('voiceKind').addEventListener('change', e => {
    voiceKind = e.target.value; store.set('voiceKind', voiceKind);
    voice.stop(); voice.neural = null;
    applyVoiceKind();
    if (voiceKind === 'google') return;
    if (NEURAL_VOICES[voiceKind]) loadNeuralVoice(false);
    else voiceNote(!voice.ok ? 'Šis pārlūks nemāk runāt.' : voice.hasLatvian ? 'Runās telefona latviešu balss.' : 'Telefonā nav latviešu balss — runās cita balss ar akcentu.');
  });
  $('voiceTest').addEventListener('click', async () => {
    voice.unlock();
    const was = voice.enabled; voice.enabled = true;
    if (voiceKind === 'google' && !voice.recorded) await loadRecordedVoice();
    if (NEURAL_VOICES[voiceKind] && !voice.neural) {
      await loadNeuralVoice(true);
    }
    voice.say(sample.join(' '), true, sample);
    voice.enabled = was;
  });
  if (NEURAL_VOICES[voiceKind]) loadNeuralVoice(false);
  loadRecordedVoice();
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
  $('settingsBtn').addEventListener('click', () => { if ($('settings').hidden) closePlaces(); toggleSettings($('settings').hidden); });
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

// ---------- Vietas tuvumā (degviela, ēdiens, viesnīcas…) ----------
let placeMarkers = [], placeSeq = 0;
function clearPlaceMarkers() { for (const m of placeMarkers) m.remove(); placeMarkers = []; }
function openPlaces() {
  toggleSettings(false);
  tilePoiSnapshot = readTilePois();
  $('results').hidden = true;
  showPlaceCats();
  $('placesSheet').hidden = false;
}
// Kamēr saraksts atvērts, statusi ("aizveras pēc 12 min") atjaunojas katru minūti
setInterval(() => {
  if ($('placesSheet').hidden || $('placeResults').hidden || !lastPlacesRender) return;
  const { places, catId, c } = lastPlacesRender;
  renderPlaces(places, catId, c, false);
}, 60000);
function closePlaces() {
  $('placesSheet').hidden = true;
  placeSeq++;
  clearPlaceMarkers();
}
function showPlaceCats() {
  placeSeq++;
  clearPlaceMarkers();
  $('placesTitle').textContent = 'Kategorijas';
  $('placesBack').hidden = true;
  $('placeResults').hidden = true;
  $('placeCats').hidden = false;
}
function placeSub(p, st) {
  const bits = [navDist(p.d)];
  if (st && st.text) bits.push(st.text);
  if (p.addr) bits.push(p.addr);
  bits.push(...p.extra);
  return bits.join(' · ');
}
// Ātri:
//  1) telefona kešatmiņa (tā pati kategorija ~1 km rādiusā, ≤ 24 h) — uzreiz;
//  2) vietas, kas jau ir ielādētajā kartē (flīžu POI) — uzreiz, bez interneta;
//  3) tīkls: Photon; ja tas 2,5 s neatbild — paralēli arī Overpass; ņem pirmo atbildi;
//  4) fonā darba laiki pēc OSM id. Visi pieprasījumi ar laika limitu.
const PLACES_MAX_AGE = 24 * 3600 * 1000;
function placesKey(catId, c) { return catId + ':' + Math.round(c.lat / 0.01) + ':' + Math.round(c.lng / 0.01); }
function freshPlaces(list, c) {        // attālumi no tagadējās vietas, "atvērts" pēc tagadējā laika
  const now = new Date();
  return resortPlaces(list, c.lat, c.lng).map(p => Object.assign(p, { open: placeOpenNow(p.oh, now, parseCondition) }));
}
async function fetchPhotonPlaces(catId, c) {
  let places = [];
  for (const km of [5, 25]) {                      // ja tuvumā maz — meklē tālāk
    const j = await fetchJson(buildPhotonPlacesUrl(catId, c.lat, c.lng, km, 25), {}, 8000);
    places = parsePhotonPlaces(j.features, catId, c.lat, c.lng);
    if (places.length >= 5) break;
  }
  return places;
}
async function fetchOverpassPlaces(catId, c) {
  let places = [];
  for (const r of [3000, 15000]) {
    const data = await fetchOverpass(buildPlacesQuery(catId, c.lat, c.lng, r), 20000);
    places = parsePlaces(data.elements, catId, c.lat, c.lng, new Date(), parseCondition);
    if (places.length >= 5) break;
  }
  return places;
}
// Kartes POI nolasa brīdī, kad atver "Atrast tuvumā" (tad karte rāda lietotāja apkārtni);
// vēlāk karte var būt attālināta citas kategorijas rezultātiem, tāpēc izmanto šo momentuzņēmumu.
let tilePoiSnapshot = null;
function readTilePois() {
  try {
    const st = map.getStyle();
    const src = st && Object.keys(st.sources).find(k => st.sources[k].type === 'vector');
    return src ? map.querySourceFeatures(src, { sourceLayer: 'poi' }).map(f => ({ properties: f.properties, geometry: f.geometry })) : [];
  } catch { return []; }
}
// Darba laiki pēc OSM id no OpenStreetMap API (~0,3 s, daudz stabilāk par Overpass);
// ja tas neatbild — Overpass. Atgriež elementus { type, id, tags }.
async function fetchPlaceDetails(places) {
  const ids = { node: [], way: [], relation: [] };
  for (const p of places) if (p.osmType && p.osmId) ids[p.osmType].push(p.osmId);
  try {
    const parts = await Promise.all(Object.entries(ids).filter(([, v]) => v.length).map(([t, v]) =>
      fetchJson(`https://api.openstreetmap.org/api/0.6/${t}s.json?${t}s=${v.join(',')}`, {}, 8000)));
    return parts.flatMap(j => j.elements || []);
  } catch {
    const q = buildPlaceDetailsQuery(places);
    if (!q) return [];
    return (await fetchOverpass(q, 20000)).elements || [];
  }
}
async function enrichPlaces(places, key, catId, c, seq) {
  if (!places.some(p => p.osmType && !p.det)) return;
  try {
    const els = await fetchPlaceDetails(places);
    const merged = mergePlaceDetails(places, els, new Date(), parseCondition).map(p => Object.assign(p, { det: true }));
    cachePut('places', key, merged);
    if (seq !== placeSeq) return;
    $('placeStatus').textContent = placesStatusText(merged, c);
    renderPlaces(merged, catId, c, false);
  } catch { /* bez darba laikiem saraksts paliek kā ir */ }
}
function tilePlaces(catId, c) {
  if (!tilePoiSnapshot || !tilePoiSnapshot.length) tilePoiSnapshot = readTilePois();
  return parseTilePlaces(tilePoiSnapshot, catId, c.lat, c.lng);
}
function placesStatusText(places, c) {
  return places.length
    ? (state.me ? 'Tuvākās no tavas atrašanās vietas' : 'Tuvākās no kartes centra') + ' · dati: OpenStreetMap'
    : 'Tuvumā nekas netika atrasts.';
}
const PLACE_DOT_TITLE = { open: 'Atvērts', closing: 'Drīz aizvērsies', opening: 'Drīz atvērsies', closed: 'Slēgts', unknown: 'Darba laiks nav zināms' };
let lastPlacesRender = null;
function renderPlaces(places, catId, c, fit) {
  lastPlacesRender = { places, catId, c };
  const ul = $('placeList');
  ul.textContent = '';
  clearPlaceMarkers();
  const now = new Date();
  for (const p of places) {
    const st = placeStatus(p.oh, now, parseCondition);
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'place-item';
    b.innerHTML = placeIconSvg(catId, 34) + '<span class="pl-text"><span class="pl-name"><span class="pl-dot"></span><strong></strong></span><span class="pl-sub"></span></span><span class="pl-go">Braukt</span>';
    const dot = b.querySelector('.pl-dot');
    dot.classList.add('st-' + st.state); dot.title = PLACE_DOT_TITLE[st.state];
    b.querySelector('strong').textContent = p.name;
    b.querySelector('.pl-sub').innerHTML = '';
    const sub = b.querySelector('.pl-sub');
    const bits = placeSub(p, null);
    if (st.text) { const em = document.createElement('span'); em.className = 'pl-st st-' + st.state; em.textContent = st.text; sub.append(navDist(p.d) + ' · ', em); const rest = bits.slice(navDist(p.d).length); if (rest) sub.append(rest); }
    else sub.textContent = bits;
    b.addEventListener('click', () => goToPlace(p));
    li.appendChild(b); ul.appendChild(li);
    const el = document.createElement('button');
    el.type = 'button'; el.className = 'place-marker'; el.title = p.name + (st.text ? ' — ' + st.text : '');
    el.innerHTML = placeIconSvg(catId, 30) + '<span class="pm-dot st-' + st.state + '"></span>';
    el.addEventListener('click', ev => { ev.stopPropagation(); goToPlace(p); });
    placeMarkers.push(new maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map));
  }
  if (fit && places.length) {
    state.follow = false;
    const pts = places.slice(0, 8).map(p => [p.lng, p.lat]).concat([[c.lng, c.lat]]);
    const lngs = pts.map(q => q[0]), lats = pts.map(q => q[1]);
    const sheetH = $('placesSheet').offsetHeight;
    map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: { top: 90, bottom: Math.min(sheetH + 30, map.getContainer().clientHeight - 200), left: 40, right: 90 }, maxZoom: 16, pitch: 0, bearing: 0, duration: 800 });
  }
}
async function showPlaces(catId) {
  const cat = PLACE_CATEGORIES.find(c => c.id === catId);
  const seq = ++placeSeq;
  clearPlaceMarkers();
  $('placesTitle').textContent = cat.label;
  $('placesBack').hidden = false;
  $('placeCats').hidden = true;
  $('placeResults').hidden = false;
  $('placeList').textContent = '';
  const c = state.me || { lat: map.getCenter().lat, lng: map.getCenter().lng };
  const key = placesKey(catId, c);

  // 1) Kešatmiņa
  const hit = await cacheGet('places', key, PLACES_MAX_AGE);
  if (seq !== placeSeq) return;
  if (hit) {
    const list = freshPlaces(hit, c).slice(0, 25);
    $('placeStatus').textContent = placesStatusText(list, c);
    renderPlaces(list, catId, c, true);
    return enrichPlaces(hit, key, catId, c, seq);     // ja saglabātajam sarakstam vēl nav darba laiku
  }

  // 2) Uzreiz no kartes
  const tile = tilePlaces(catId, c).slice(0, 25);
  if (tile.length) {
    $('placeStatus').textContent = 'Tuvākās kartē · meklē vēl…';
    renderPlaces(tile, catId, c, true);
  } else $('placeStatus').textContent = 'Meklē tuvumā…';

  // 3) Tīkls: Photon, pēc 2,5 s paralēli arī Overpass
  let settled = false;
  const photon = fetchPhotonPlaces(catId, c).then(p => ({ p, viaPhoton: true }));
  const overpass = new Promise((res, rej) => setTimeout(() => {
    if (settled || seq !== placeSeq) return rej(new Error('skip'));
    fetchOverpassPlaces(catId, c).then(p => res({ p, viaPhoton: false }), rej);
  }, 2500));
  let result;
  try { result = await Promise.any([photon, overpass]); }
  catch {
    settled = true;
    if (seq !== placeSeq) return;
    if (tile.length) { $('placeStatus').textContent = 'Rādītas vietas no kartes (meklēšanas serveri šobrīd neatbild).'; return; }
    $('placeStatus').textContent = 'Neizdevās ielādēt vietas. ';
    const retry = document.createElement('button');
    retry.type = 'button'; retry.className = 'link-btn'; retry.textContent = 'Mēģināt vēlreiz';
    retry.addEventListener('click', () => showPlaces(catId));
    $('placeStatus').appendChild(retry);
    return;
  }
  settled = true;
  let places = result.p.slice(0, 25);
  if (!places.length && tile.length) places = tile;     // tīklā nekas — paliek kartes vietas
  cachePut('places', key, places);
  if (seq !== placeSeq) return;
  $('placeStatus').textContent = placesStatusText(places, c);
  renderPlaces(places, catId, c, !tile.length);
  if (!result.viaPhoton || !places.length) return;
  // Fonā: darba laiks (krāsainais punkts), maksa, vietu skaits
  await enrichPlaces(places, key, catId, c, seq);
}
function goToPlace(p) {
  closePlaces();
  selectDestination({ name: p.name, sub: [p.addr, PLACE_CATEGORIES.find(c => c.id === p.cat).label].filter(Boolean).join(', '), lat: p.lat, lng: p.lng });
}
function wirePlaces() {
  const icons = $('placesBtnIcons');
  for (const id of ['fuel', 'food', 'parking', 'hotel']) icons.insertAdjacentHTML('beforeend', placeIconSvg(id, 26));
  const ul = $('placeCats');
  for (const c of PLACE_CATEGORIES) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'place-cat';
    b.innerHTML = placeIconSvg(c.id, 34) + '<span></span><svg class="pc-chev" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    b.querySelector('span').textContent = c.label;
    b.addEventListener('click', () => showPlaces(c.id));
    li.appendChild(b); ul.appendChild(li);
  }
  $('placesBtn').addEventListener('click', openPlaces);
  $('placesBack').addEventListener('click', showPlaceCats);
  $('closePlaces').addEventListener('click', closePlaces);
}

// ---------- Starts ----------
async function init() {
  setTimeout(() => cachePrune(), 20000);   // izmet > 7 dienas vecus kešatmiņas ierakstus
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
  alerts = new AlertStore({ load: () => store.get('reports', []), save: list => store.set('reports', list) });
  setInterval(() => { if (alerts.prune()) refreshAlerts(); }, 30000);   // novecojušos ziņojumus noņem
  setInterval(() => { signs.refresh(); updateLimit(); }, 60000); // laika ierobežojumi mainās

  map.on('style.load', () => {
    installRouteLayers();
    signs.install();
    installAlertLayer();
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
  map.on('styleimagemissing', e => {
    if (/^alert:/.test(e.id)) { signs.iconUrl.set(e.id, alertDataUrl(e.id.slice(6))); signs.loadImage(e.id); }
    else if (/^(mly|own):/.test(e.id)) signs.loadImage(e.id);
  });
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
  map.on('click', 'alerts', e => {
    const f = e.features && e.features[0];
    if (f) showAlertPopup(f.properties.id, f.geometry.coordinates);
  });
  map.on('mouseenter', 'signs', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'signs', () => { map.getCanvas().style.cursor = ''; });
  map.on('click', e => {
    $('results').hidden = true;
    if (map.getLayer('signs') && map.queryRenderedFeatures(e.point, { layers: ['signs', 'alerts'].filter(l => map.getLayer(l)) }).length) return;
    if (state.testMode && !state.nav.active) { state.follow = false; onFix(e.lngLat.lat, e.lngLat.lng, 55, null, 300); }
  });

  wireUi();
  buildCategoryList();
  loadVerifiedSigns();
  loadPlateTimes();
  wireAlerts();
  wirePlaces();
  startGps();
  map.once('load', loadAllForView);
}

init();
