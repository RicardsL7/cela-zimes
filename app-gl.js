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

// Kopīgā Mapillary atslēga visiem (mly-config.js); lietotāja paša atslēga (iestatījumos) ir noteicošā.
function mlyPublicToken() {
  const t = typeof MLY_CONFIG !== 'undefined' && MLY_CONFIG && typeof MLY_CONFIG.token === 'string' ? MLY_CONFIG.token.trim() : '';
  return /^MLY\|/.test(t) ? t : '';
}
const state = {
  signsOn: store.get('signsOn', true),
  cats: Object.assign(
    Object.fromEntries(Object.keys(SIGN_CATEGORIES).map(k => [k, true])),
    store.get('cats', {})
  ),
  warn: store.get('warn', true),
  profile: 'car',   // vienmēr vieglais automobilis (izvēle no iestatījumiem noņemta)
  mapMode: 'alerts', // kartē vienmēr tikai brīdinājumi; visu zīmju režīms vairs netiek piedāvāts
  basemap: store.get('basemap', 'auto'),
  mlyToken: store.get('mlyToken', '') || mlyPublicToken(),
  testMode: false,
  testSpeed: 55,          // F7: testa režīmā simulētais ātrums (klikšķis uz kartes bez maršruta)
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
// F2: kamēr atrašanās vieta liegta / nav atbalstīta, šo ziņu citi izsaukumi nepārraksta (force — tikai GPS ziņām)
let statusLock = false;
function setStatus(text, force = false) { if (statusLock && !force) return; $('statusText').textContent = text; }
// F2/F6: izstrādātāja režīms — tehniskā info un izstrādātāja iestatījumi. Ieslēdz ?dev=1 vai 7 pieskārieni iestatījumu virsrakstam;
// izslēdz ?dev=0 vai poga blokā „Izstrādātājam”. Saglabājas localStorage 'devMode'.
let CZ_DEV = czDevInit();
function czDevInit() {
  const q = location.search, on = /[?&]dev=1(&|$)/.test(q), off = /[?&]dev=0(&|$)/.test(q);
  try {
    if (on) localStorage.setItem('devMode', '1');
    else if (off) localStorage.removeItem('devMode');
    return localStorage.getItem('devMode') === '1';
  } catch { return on; }
}
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

// ---------- Radari uzreiz (bez gaidīšanas uz zīmju ielādi) ----------
// 1) Visas Latvijas ātruma kameras no OpenStreetMap (data/osm/cameras.json, atjauno katru nakti).
// 2) Šajā ierīcē jau redzētās Mapillary kameras (atceras, lai nākamreiz tās rādītu uzreiz).
const RADAR_MEM_KEY = 'cz.radars.v1', RADAR_MEM_DAYS = 120;
let radarMem = null, radarMemTimer = null;
function radarMemGet() {
  if (!radarMem) { try { radarMem = JSON.parse(localStorage.getItem(RADAR_MEM_KEY) || '{}') || {}; } catch { radarMem = {}; } }
  return radarMem;
}
function radarRemember(id, lat, lng, value, fromShared = false) {
  const m = radarMemGet(), old = m[id];
  if (!fromShared) radarShare(id, lat, lng, value, old && old[4]);
  if (old && !fromShared && Date.now() - old[3] < 86400000) return;
  m[id] = [Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6, value, Date.now(), fromShared ? Date.now() : old ? old[4] || 0 : 0];
  radarMemSave();
}
function radarMemSave() {
  const m = radarMemGet();
  clearTimeout(radarMemTimer);
  radarMemTimer = setTimeout(() => {
    const cut = Date.now() - RADAR_MEM_DAYS * 86400000;
    for (const [k, v] of Object.entries(m)) if (!v || v[3] < cut) delete m[k];
    try { localStorage.setItem(RADAR_MEM_KEY, JSON.stringify(m)); } catch { /* pilna atmiņa — nav svarīgi */ }
  }, 2000);
}
// 3) Kopīgais radaru saraksts visiem lietotājiem (supabase/radars.sql). Tajā ir tikai Mapillary
//    zīmju numuri — pirms parādīšanas katru pārbauda pašā Mapillary (vieta un veids no turienes),
//    tāpēc viltotu radaru tur iesūtīt nevar.
const radarShared = { ids: new Set(), loaded: false, queue: new Map(), timer: null };
function radarRpc(name, body) {
  const cfg = typeof RIDES_CONFIG !== 'undefined' ? RIDES_CONFIG : null;
  if (!cfg || !cfg.url || !cfg.anonKey) return Promise.reject(new Error('nav servera'));
  return fetch(cfg.url.replace(/\/$/, '') + '/rest/v1/rpc/' + name, {
    method: 'POST', headers: { apikey: cfg.anonKey, 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  }).then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)));
}
// Mapillary pārbauda līdz 50 zīmēm reizē. Ja kāds numurs neeksistē, tas noraida visu grupu —
// tad grupu dala uz pusēm, līdz atrod nederīgos.
async function mlyVerify(ids, token, bad) {
  if (!ids.length) return [];
  const r = await fetch(`https://graph.mapillary.com/?ids=${ids.join(',')}&fields=id,object_value,geometry&access_token=${encodeURIComponent(token)}`);
  if (r.ok) { const j = await r.json(); return ids.map(id => j[id]).filter(Boolean); }
  if (r.status === 400) {
    if (ids.length === 1) { bad.push(ids[0]); return []; }
    const h = ids.length >> 1;
    return [...await mlyVerify(ids.slice(0, h), token, bad), ...await mlyVerify(ids.slice(h), token, bad)];
  }
  throw new Error('Mapillary HTTP ' + r.status);
}
async function loadSharedRadars() {
  let list;
  try { list = await radarRpc('radar_list'); } catch (e) { console.warn('Kopīgie radari nav ielādēti', e); return; }
  for (const x of list || []) radarShared.ids.add(String(x.mly_id));
  radarShared.loaded = true;
  if (!state.mlyToken) return;
  const todo = [...radarShared.ids].filter(id => !mlyIds.has(id));
  const bad = [];
  let added = 0;
  for (let i = 0; i < todo.length; i += 50) {
    let got;
    try { got = await mlyVerify(todo.slice(i, i + 50), state.mlyToken, bad); } catch (e) { console.warn(e); break; }
    for (const f of got) {
      const id = String(f.id), v = String(f.object_value || ''), c = f.geometry && f.geometry.coordinates;
      const cls = classifyMapillary(v);
      if (!c || cls.cat !== 'camera') { bad.push(id); continue; }
      if (mlyIds.has(id)) continue;
      mlyIds.add(id);
      radarRemember(id, c[1], c[0], v, true);
      if (addSign(c[1], c[0], cls, v, id)) added++;
    }
    if (added) { signs.refresh(); added = 0; }
  }
  if (bad.length && czConsentOk()) radarRpc('radar_bad', { ids: bad.slice(0, 50) }).catch(() => {});
}
// Paziņo citiem: jauns radars (vai ilgi nav apstiprināts — reizi nedēļā)
function radarShare(id, lat, lng, value, reportedAt) {
  if (typeof czConsentOk === 'function' && !czConsentOk()) return;      // bez piekrišanas neko nesūta
  if (!radarShared.loaded) { setTimeout(() => radarShare(id, lat, lng, value, reportedAt), 5000); return; }
  if (radarShared.ids.has(id) && Date.now() - (reportedAt || 0) < 7 * 86400000) return;
  if (radarShared.queue.has(id)) return;
  radarShared.queue.set(id, { id, v: value, lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 });
  clearTimeout(radarShared.timer);
  radarShared.timer = setTimeout(radarFlush, 4000);
}
async function radarFlush() {
  const items = [...radarShared.queue.values()].slice(0, 30);
  if (!items.length) return;
  items.forEach(it => radarShared.queue.delete(it.id));
  try {
    await radarRpc('radar_report', { items });
    const m = radarMemGet();
    for (const it of items) { radarShared.ids.add(it.id); if (m[it.id]) m[it.id][4] = Date.now(); }
    radarMemSave();
  } catch (e) { console.warn('Radaru paziņošana neizdevās', e); }
  if (radarShared.queue.size) radarShared.timer = setTimeout(radarFlush, 1000);
}
async function loadKnownRadars() {
  let added = 0;
  for (const [id, v] of Object.entries(radarMemGet())) {
    if (!v || mlyIds.has(id)) continue;
    mlyIds.add(id);
    if (addSign(v[0], v[1], classifyMapillary(v[2]), v[2], id)) added++;
  }
  if (added) signs.refresh();
  try {
    const r = await fetch('data/osm/cameras.json', { cache: 'no-cache' });
    if (!r.ok) return;
    const j = await r.json();
    const els = (j.n || []).map(([id, lat, lon, tags]) => ({ type: 'node', id: id || 'cam:' + lat + ',' + lon, lat, lon, tags }));
    const n = processOsmElements(els);
    if (n) osmApplied(n);
  } catch (e) { console.warn('Radaru saraksts nav ielādēts', e); }
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
  if (state.nav.active || !CZ_DEV) return;                    // F2: parastam lietotājam zīmju skaitu nerāda
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
    if (mem) sign = mem.limit;
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
  const badge = $('limitBadge');
  if (!state.me) { badge.hidden = true; return; }
  const res = speedHold.update(resolveSpeedLimit(), Date.now(), state.me.lat, state.me.lng);
  badge.hidden = !res;
  if (res) $('limitValue').textContent = res.limit;
  document.documentElement.classList.toggle('has-limit', !!res);   // F7: „nākamā zīme” blakus plāksnītei, ne virsū
  badge.classList.toggle('approx', !!(res && res.approx));
  const label = !res ? '' : res.approx ? `Aptuvenais ierobežojums ${res.limit} km/h (zīme nav atrasta)` : `Ātruma ierobežojums ${res.limit} km/h`;
  badge.title = label;
  badge.setAttribute('aria-label', label);
  const over = isOverspeed(state.me.speedKmh, res, state.warn);
  $('speedBox').classList.toggle('over', over);
  badge.classList.toggle('pulse', over);
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
      if (r.reason && r.reason.badToken) {
        // F9: uznirstošā ziņa (iestatījumu logs var būt atvērts) un tikai vienreiz, nevis par katru flīzi
        if (!state.mlyBadShown) { state.mlyBadShown = true; czToast('Mapillary atslēga nav derīga. Pārbaudi to iestatījumos.', true); }
        state.mlyToken = '';
      }
      return;
    }
    state.mlyTiles.add(key);
    for (const z of r.value) {
      const cls = classifyMapillary(z.value);
      if (cls.cat === 'camera' && isPlausibleSign(z.value, z.lat, z.lng)) radarRemember(z.id, z.lat, z.lng, z.value);   // arī jau zināmām — atjauno laiku
      if (mlyIds.has(z.id)) continue;
      mlyIds.add(z.id);
      if (!isPlausibleSign(z.value, z.lat, z.lng)) continue; // acīmredzamas atpazīšanas kļūdas
      if (addSign(z.lat, z.lng, cls, z.value, z.id)) added++;
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
  // 3D bulta: maigi zaļa virsma (#74C476) ar šķautni, bieza balta mala, tumši zaļš "sāns" (biezums)
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
// bulta ir ekrāna lejasdaļā, lai priekšā redzams ceļš.
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
  if (typeof trafficOnFix === 'function') trafficOnFix(lat, lng, speedKmh, state.heading, accuracy);   // sastrēgumu karte (traffic-gl.js)
  if ($('reportSheet') && !$('reportSheet').hidden) reportGpsRefresh();   // F20: vieta ir — pogas aktīvas
}

// ---------- GPS ----------
let gpsProblem = 'Meklē GPS signālu… Ārā tas notiek ātrāk nekā telpās.';
let watchId = null;
let gpsState = null;              // F2: 'denied' | 'unavailable' | 'timeout' | 'unsupported' | null
let gpsRetryTimer = null, gpsPermWatch = false;
const GPS_TEXT = {
  denied: 'Atrašanās vieta nav atļauta. Ieslēdz to pārlūka iestatījumos.',
  unavailable: 'Neizdevās noteikt atrašanās vietu. Pārbaudi, vai ierīcē ir ieslēgta atrašanās vieta (GPS).',
  timeout: 'Atrašanās vietu neizdevās noteikt laikā. Mēģinām vēlreiz…',
  unsupported: 'Šis pārlūks neatbalsta atrašanās vietas noteikšanu.',
};
function gpsKind(err) { return err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'unavailable'; }
let gpsTimeouts = 0;              // F20: pēc kārtas TIMEOUT kļūdas (otrā — „nav pieejama”)
// F20: kāpēc atrašanās vietas nav — viena vieta visai lietotnei (ziņošana, maršruts, stāvēšana).
// 'ok' — vieta ir (arī testa režīmā ar klikšķi kartē); 'denied' — atļauja liegta (kļūda code 1 / Permissions API);
// 'unavailable' — code 2, atkārtots TIMEOUT vai pārlūks neatbalsta; 'searching' — atļauja ir / nav jautāta, vieta vēl nav pienākusi.
function getLocationState() {
  if (state.me && (state.testMode || gpsState !== 'denied')) return 'ok';
  if (gpsState === 'denied') return 'denied';
  if (gpsState === 'unavailable' || gpsState === 'unsupported' || (gpsState === 'timeout' && gpsTimeouts >= 2)) return 'unavailable';
  return 'searching';
}
function gpsErrorText(err) { return GPS_TEXT[gpsKind(err)]; }
// Ziņa statusa joslā (+ poga „Kā ieslēgt?”, ja liegts). Liegts / neatbalsta — citi setStatus to nepārraksta.
function gpsShow(kind) {
  gpsState = kind; gpsProblem = kind ? GPS_TEXT[kind] : null;
  statusLock = kind === 'denied' || kind === 'unsupported';
  $('gpsHelpBtn').hidden = kind !== 'denied';
  $('statusBox').classList.toggle('gps-off', statusLock);
  if (kind) setStatus(gpsProblem, true);
  if ($('reportSheet') && !$('reportSheet').hidden) reportGpsRefresh();
}
function gpsClear() {
  if (!gpsState) return;
  gpsShow(null);
  if (!$('gpsSheet').hidden) $('gpsSheet').hidden = true;
}
function onPosition(pos) {
  if (state.testMode) return;
  const sp = pos.coords.speed;
  const first = !state.me, wasOff = !!gpsState;
  gpsTimeouts = 0;
  gpsClear();                                                  // F2: vieta ir — ziņa un poga pazūd
  onFix(pos.coords.latitude, pos.coords.longitude, sp == null || sp < 0 ? null : sp * 3.6, pos.coords.heading, first ? 0 : 900, pos.coords.accuracy);
  if (first && state.nav.dest && !state.nav.active) previewRoute(); // maršruts no manas īstās vietas
  else if (first) { map.jumpTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: Math.max(map.getZoom(), 15.5) }); loadAllForView(); }
  gpsProblem = null;
  if (!state.nav.active && (first || wasOff || (CZ_DEV && !state.counts.mly && !state.counts.osm))) setStatus('GPS darbojas.');
}
function onGpsError(err) {
  const kind = gpsKind(err);
  gpsTimeouts = kind === 'timeout' ? gpsTimeouts + 1 : 0;
  if (kind === 'denied') return gpsShow('denied');             // liegts — rāda vienmēr (arī ja vieta bija)
  gpsProblem = GPS_TEXT[kind];
  if (state.me) return;
  gpsShow(kind);
  if (kind === 'timeout' && !gpsRetryTimer) gpsRetryTimer = setTimeout(() => { gpsRetryTimer = null; if (!state.me && gpsState === 'timeout') startGps(); }, 5000);
}
// Atļaujas maiņa bez lapas pārlādes (Permissions API; vecākā Safari tās nav — tad iztiek bez tās)
function gpsWatchPermission() {
  if (gpsPermWatch || !navigator.permissions || !navigator.permissions.query) return;
  gpsPermWatch = true;
  navigator.permissions.query({ name: 'geolocation' }).then(st => {
    if (st.state === 'denied') gpsShow('denied');
    st.onchange = () => {
      if (st.state === 'denied') gpsShow('denied');
      else { gpsClear(); startGps(); }                          // atļauts → pirmā vieta pārvieto karti
    };
  }).catch(() => { gpsPermWatch = false; });
}
// onDenied — izsauc, ja atļauja joprojām liegta (poga „Mēģināt vēlreiz”)
function startGps(onDenied) {
  if (!('geolocation' in navigator) || !window.isSecureContext) { gpsShow('unsupported'); return; }
  gpsWatchPermission();
  navigator.geolocation.getCurrentPosition(onPosition, err => { if (err.code === 1) { gpsShow('denied'); if (onDenied) onDenied(); } },
    { enableHighAccuracy: false, maximumAge: 60000, timeout: 10000 });
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(onPosition, onGpsError, { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
}
// „Kā ieslēgt?” — instrukcijas; ierīcei atbilstošā pirmā un atvērta
function gpsDevice() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}
function openGpsHelp() {
  const box = $('gpsHelpList'), dev = gpsDevice();
  const items = [...box.querySelectorAll('details')];
  items.sort((a, b) => (b.dataset.dev === dev) - (a.dataset.dev === dev)).forEach(d => { d.open = d.dataset.dev === dev; box.append(d); });
  if (typeof toggleSettings === 'function') toggleSettings(false);
  $('gpsSheet').hidden = false;
  $('gpsRetry').focus({ preventScroll: true });
}
function gpsRetry() {
  const btn = $('gpsRetry');
  btn.disabled = true;
  setTimeout(() => { btn.disabled = false; }, 2500);
  startGps(() => czToast('Atrašanās vieta joprojām nav atļauta. Ieslēdz to pārlūka iestatījumos un pārlādē lapu.', true));
}

// ---------- Galamērķa meklēšana ----------
let searchTimer = null, searchSeq = 0, lastResults = [];
const PIN_ICON = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 2.5c-3.9 0-7 3-7 6.8C5 14.5 12 21.5 12 21.5s7-7 7-12.2c0-3.8-3.1-6.8-7-6.8Z" fill="currentColor"/><circle cx="12" cy="9.4" r="2.4" fill="#fff"/></svg>';

async function searchPhoton(q) {
  const c = state.me || { lat: map.getCenter().lat, lng: map.getCenter().lng };
  // F3: lang=default — vietējie (Latvijā latviskie) nosaukumi neatkarīgi no pārlūka valodas
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=7&lat=${c.lat.toFixed(2)}&lon=${c.lng.toFixed(2)}&lang=${PHOTON_LANG}`;
  // Tas pats teksts ~1 km apkārtnē — no kešatmiņas (1 diena); 'photon-lv' — vecie angliskie rezultāti netiek ņemti
  const json = await cachedJson('photon-lv', q.toLowerCase() + '@' + c.lat.toFixed(2) + ',' + c.lng.toFixed(2), 24 * 3600 * 1000,
    () => fetchJson(url, {}, 7000));
  return (json.features || []).map(photonSearchItem);
}
async function searchNominatim(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=lv&q=' + encodeURIComponent(q);
  const json = await cachedJson('nominatim', q.toLowerCase(), 24 * 3600 * 1000, () => fetchJson(url, {}, 8000));
  return json.map(it => {
    const [name, ...rest] = it.display_name.split(', ');
    return { name, sub: rest.filter(x => x !== 'Latvija').slice(0, 3).join(', '), lat: +it.lat, lng: +it.lon };   // F3: valsti Latvijā nerāda
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
  map.addSource('route-alt', { type: 'geojson', data: EMPTY_FC });
  map.addSource('route', { type: 'geojson', data: EMPTY_FC });
  // Alternatīvie maršruti — gaiši zili, puscaurspīdīgi, zem izvēlētā
  map.addLayer({ id: 'route-alt-casing', type: 'line', source: 'route-alt',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#2f7be0', 'line-opacity': 0.35, 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, 5, 15, 11, 18, 26] } });
  map.addLayer({ id: 'route-alt-line', type: 'line', source: 'route-alt',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#9cc8ff', 'line-opacity': 0.75, 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, 3, 15, 7, 18, 18] } });
  map.addLayer({ id: 'route-alt-hit', type: 'line', source: 'route-alt',      // plats, neredzams — vieglāk uzspiest
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 28 } });
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

async function cachedRoutes(from, to) {
  const key = from.lat.toFixed(4) + ',' + from.lng.toFixed(4) + '>' + to.lat.toFixed(5) + ',' + to.lng.toFixed(5);
  const hit = await cacheGet('routes', key, 10 * 60000);
  if (hit && hit.length) return structuredClone(hit);
  const routes = await onceInflight('routes|' + key, () => requestRoutes(from, to, 3));
  cachePut('routes', key, structuredClone(routes));
  return routes;
}

// ---------- Alternatīvie maršruti ----------
// Izvēlētais — pilnā zilā; pārējie — gaiši zili zem tā ar laika uzrakstu. Uzspiežot — izvēlas.
let altMarkers = [];
function clearAltRoutes() {
  for (const m of altMarkers) m.remove();
  altMarkers = [];
  const src = map.getSource('route-alt');
  if (src) src.setData(EMPTY_FC);
  const box = $('routeAlts');
  if (box) { box.hidden = true; box.textContent = ''; }
}
function drawAltRoutes() {
  for (const m of altMarkers) m.remove();
  altMarkers = [];
  const routes = state.nav.routes || [], sel = state.nav.route;
  const src = map.getSource('route-alt');
  if (!routes.length || routes.length < 2 || state.nav.active) { clearAltRoutes(); return; }
  if (src) src.setData({ type: 'FeatureCollection', features: routes.map((r, i) => r === sel ? null :
    { type: 'Feature', geometry: { type: 'LineString', coordinates: r.coords }, properties: { i } }).filter(Boolean) });
  const selEta = routeEta(sel);
  routes.forEach((r, i) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'alt-bubble' + (r === sel ? ' sel' : '');
    const d = Math.round((routeEta(r) - selEta) / 60);
    el.innerHTML = `<b>${navTime(routeEta(r))}</b>` + (r === sel ? '' : `<small>${d > 0 ? '+' + d + ' min' : d < 0 ? '−' + (-d) + ' min' : 'tikpat'}</small>`);
    el.addEventListener('click', ev => { ev.stopPropagation(); chooseRoute(i, true); });
    const at = routeLabelPoint(r, routes.filter(o => o !== r));
    altMarkers.push(new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(at).addTo(map));
  });
  const box = $('routeAlts');
  if (!box) return;
  const labels = labelRoutes(routes);
  box.textContent = '';
  routes.map((r, i) => ({ r, i, l: labels[i] })).sort((a, b) => routeEta(a.r) - routeEta(b.r)).forEach(({ r, i, l }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'route-alt' + (r === sel ? ' sel' : '');
    const jam = r.jamSec == null ? '' : r.jamSec >= 60 ? ` · 🚦 +${Math.round(r.jamSec / 60)} min` : ' · bez sastrēgumiem';
    b.innerHTML = `<span class="ra-time"></span><span class="ra-txt"><span class="ra-lbl"></span><span class="ra-meta"></span></span>`;
    b.querySelector('.ra-time').textContent = navTime(routeEta(r));
    b.querySelector('.ra-lbl').textContent = l;
    const bar = !r.barriers ? '' : r.barriers.length ? ' · ⚠ barjera' : ' · bez barjerām';
    b.querySelector('.ra-meta').textContent = navDist(r.distance) + jam + bar;
    b.addEventListener('click', () => chooseRoute(i, true));
    box.append(b);
  });
  box.hidden = false;
}
// Izvēlas maršrutu no saraksta (byUser — lietotājs pats izvēlējās; tad automātiski vairs nemaina).
function chooseRoute(i, byUser) {
  const r = (state.nav.routes || [])[i];
  if (!r || state.nav.active) return;
  if (byUser) state.nav.altPicked = true;
  if (r === state.nav.route) return;
  state.nav.route = r;
  drawRoute(r);
  signs.setRoute(r);
  prepareRoute(r);
  fillRouteCard(r);
  drawAltRoutes();
  updateRouteSummary();
}
function fillRouteCard(route) {
  $('routeTime').textContent = navTime(routeEta(route));
  $('routeMeta').textContent = `${navDist(route.distance)} · ieradīsies ${clockIn(routeEta(route))}`;
  if (typeof trafficLine === 'function') trafficLine(route);
  showBarrierCard();                               // F4: barjeras brīdinājums šim maršrutam
}
// Sastrēgumi visiem maršrutiem; ja cits maršruts ar sastrēgumiem ir ātrāks (≥1 min) — izvēlas to.
async function trafficForPreview(routes) {
  if (typeof trafficForRoutes !== 'function' || !(await trafficForRoutes(routes))) return;
  if (state.nav.routes !== routes || state.nav.active) return;
  const best = routes.reduce((a, b) => routeEta(b) < routeEta(a) ? b : a);
  if (!state.nav.altPicked && best !== state.nav.route && routeEta(state.nav.route) - routeEta(best) >= 60) chooseRoute(routes.indexOf(best), false);
  else { fillRouteCard(state.nav.route); drawAltRoutes(); }
}

// ---------- F4: barjeras un privāti ceļi maršrutā ----------
// Pēc priekšskatījuma (asinhroni, nebloķē „Sākt”) vienā Overpass vaicājumā gar visiem maršrutiem meklē vārtus /
// barjeras / privātus ceļus. Brīdinājums — maršruta kartītē (ne statusa joslā, F9), barjera — marķieris kartē.
// Ja kāda alternatīva iet bez barjerām — izvēlas to; citādi piedāvā apbraukt vai braukt līdz ieejai.
const BARRIER_WAIT_MS = 45000;
const barrierCache = new Map();      // Overpass vaicājums → elementi (sesijas laikā)
let barrierMarkers = [];
async function barrierElements(routes) {
  const q = barrierQuery(routes);
  if (barrierCache.has(q)) return barrierCache.get(q);
  // Asinhroni — „Sākt” negaida. Overpass serveri bieži pārslogoti (mērīts: 16–44 s), tāpēc gaida līdz 45 s.
  const j = await fetchOverpass(q, BARRIER_WAIT_MS);
  // Pārslogots serveris var atdot tukšu sarakstu ar piezīmi „Query timed out” — tas nav „barjeru nav”
  if (!j || !Array.isArray(j.elements) || /error|timed out/i.test(j.remark || '')) throw new Error('overpass');
  const els = j.elements;
  if (barrierCache.size > 30) barrierCache.delete(barrierCache.keys().next().value);
  barrierCache.set(q, els);
  return els;
}
function clearBarriers() {
  for (const m of barrierMarkers) m.remove();
  barrierMarkers = [];
  const box = $('routeBarrier');
  if (box) { box.hidden = true; box.textContent = ''; }
}
async function barriersForPreview(routes, dest) {
  let els;
  try { els = await barrierElements(routes); } catch { return; }        // Overpass neatbild — maršruts kā līdz šim
  if (state.nav.routes !== routes || state.nav.dest !== dest || state.nav.active) return;   // vecs rezultāts
  for (const r of routes) r.barriers = routeBarriers(r, els);
  state.nav.barrierEls = els;
  const sel = state.nav.route;
  if (!state.nav.altPicked && sel.barriers.length) {
    const clean = routes.filter(r => !r.barriers.length && routeEta(r) <= routeEta(sel) * 1.45)
      .sort((a, b) => routeEta(a) - routeEta(b))[0];
    if (clean) { chooseRoute(routes.indexOf(clean), false); return; }   // chooseRoute pārzīmē arī kartīti
  }
  fillRouteCard(state.nav.route);
  drawAltRoutes();
}
const BARRIER_PIN = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="7" width="4" height="20" rx="1.5" fill="#333"/><rect x="6" y="10" width="24" height="6" rx="2" fill="#fff" stroke="#c81e3a" stroke-width="1.5"/><path d="M11 10l-3 6M17 10l-3 6M23 10l-3 6M29 10l-3 6" stroke="#c81e3a" stroke-width="2.2"/></svg>';
function barrierText(b) {
  return b.kind === 'private' ? '⚠ Maršruts iet caur privātu teritoriju — iespējams, iebraukt nevar.'
    : '⚠ Maršrutā ir barjera — iespējams, iebraukt nevar.';
}
// Kartītes brīdinājums un marķieri izvēlētajam maršrutam
function showBarrierCard() {
  const box = $('routeBarrier');
  if (!box) return;
  for (const m of barrierMarkers) m.remove();
  barrierMarkers = [];
  box.textContent = '';
  const r = state.nav.route;
  if (!r || state.nav.active || !r.barriers) { box.hidden = true; return; }
  const say = (cls, text) => { const p = document.createElement('div'); p.className = cls; p.textContent = text; box.append(p); return p; };
  if (r.barrierNote) say('rb-note', r.barrierNote);
  if (r.barrierMsg) say('rb-note rb-fail', r.barrierMsg);
  const list = r.barriers;
  // Marķieri: šī maršruta barjeras; „līdz ieejai” maršrutam — barjera, pie kuras tas beidzas
  for (const b of list.length ? list : (r.barrierAt || [])) {
    const el = document.createElement('div');
    el.className = 'barrier-pin';
    el.title = b.kind === 'private' ? 'Privāts ceļš' : 'Barjera';
    el.innerHTML = BARRIER_PIN;
    barrierMarkers.push(new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([b.lng, b.lat]).addTo(map));
  }
  box.classList.toggle('ok', !list.length);
  if (!list.length) { box.hidden = !r.barrierNote && !r.barrierMsg; return; }
  const first = list[0];
  say('rb-txt', barrierText(first) + ` (pēc ${navDist(first.along)})`);
  if (!r.barrierTried) {
    const atDest = barrierAtDestination(r, first);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn rb-btn';
    btn.textContent = atDest ? 'Maršruts līdz ieejai' : 'Apbraukt barjeru';
    btn.addEventListener('click', () => (atDest ? barrierToEntry : barrierDetour)(btn));
    box.append(btn);
  }
  box.hidden = false;
}
// Jaunu maršrutu pievieno sarakstam un izvēlas (lietotājs pats to lūdza)
function addBarrierRoute(route) {
  state.nav.routes = (state.nav.routes || []).concat(route);
  chooseRoute(state.nav.routes.length - 1, true);
}
function barrierFailed(r, text) {
  r.barrierTried = true;
  r.barrierMsg = text;
  showBarrierCard();
}
// Apbraukšana: 2–4 starppunkti ~200–300 m sāniski no barjeras; ņem pirmo maršrutu, kas šo barjeru neiet cauri
// un nepievieno jaunas (barjera pie paša galamērķa, kas bija arī sākotnējā maršrutā, var palikt).
async function barrierDetour(btn) {
  const r = state.nav.route, dest = state.nav.dest, routes = state.nav.routes;
  if (!r || !r.barriers || !r.barriers.length) return;
  btn.disabled = true; btn.textContent = 'Meklē apbraucamo ceļu…';
  const from = { lat: r.coords[0][1], lng: r.coords[0][0] };
  const target = r.barriers[0], vias = barrierDetourPoints(r, target);
  const known = state.nav.barrierEls || [];
  const okWith = (c, els) => { const cb = routeBarriers(c, els); return !cb.some(x => x.id === target.id) && cb.every(x => r.barriers.some(o => o.id === x.id)) ? cb : null; };
  let found = null;
  for (let i = 0; i < vias.length && !found; i += 2) {
    const got = (await Promise.all(vias.slice(i, i + 2).map(v =>
      osrmFetch([from, v, dest], '&continue_straight=true').then(d => d.routes && d.routes[0] && parseOsrmRoute(d.routes[0])).catch(() => null))))
      .filter(c => c && !routeBarriers(c, known).some(x => x.id === target.id))   // to pašu barjeru neapbrauc — neder
      .sort((a, b) => a.duration - b.duration);
    if (state.nav.routes !== routes || state.nav.dest !== dest || state.nav.active) return;
    if (!got.length) continue;
    let els = null;
    try { els = await barrierElements(got); } catch { /* Overpass neatbild — ņem to, kas apbrauc zināmo barjeru */ }
    if (state.nav.routes !== routes || state.nav.dest !== dest || state.nav.active) return;
    for (const c of got) {
      const cb = els ? okWith(c, els) : routeBarriers(c, known);
      if (!cb) continue;
      found = c;
      found.barriers = cb;
      if (!els) found.barrierNote = 'Apbrauc šo barjeru (pārējo ceļu pārbaudīt neizdevās).';
      break;
    }
  }
  if (!found) return barrierFailed(r, 'Maršrutu bez barjeras atrast neizdevās — pie barjeras, iespējams, būs jāapgriežas.');
  r.barrierTried = true;
  if (!found.barriers.length) found.barrierTried = true;     // atlikusī barjera pie galamērķa — vēl var „līdz ieejai”
  addBarrierRoute(found);
}
// Galamērķis aiz barjeras (slēgta teritorija): tas pats maršruts, nogriezts 15 m pirms barjeras (ja maršruts jau
// apbrauc citu barjeru — apbraukšana saglabājas; OSRM vēlreiz nav jāprasa)
function barrierToEntry() {
  const r = state.nav.route;
  if (!r || !r.barriers || !r.barriers.length || state.nav.active) return;
  const bar = r.barriers.find(b => barrierAtDestination(r, b)) || r.barriers[0];
  const route = routeTruncate(r, Math.max(0, bar.along - 15));
  if (r.jamSec != null) route.jamSec = r.jamSec;
  route.barriers = r.barriers.filter(b => b.along < bar.along - 15);
  route.barrierNote = 'Galamērķis aiz barjeras — maršruts līdz ieejai.';
  route.barrierAt = [bar];
  route.barrierTried = true;
  r.barrierTried = true;
  addBarrierRoute(route);
}

async function selectDestination(place) {
  $('results').hidden = true;
  $('searchInput').value = place.name;
  $('searchInput').blur();
  $('clearSearch').hidden = false;
  state.nav.dest = place;
  const da = $('destActs');
  if (da) { da.textContent = ''; const acts = placeActionsEl(place.ct); if (acts) da.append(...acts.childNodes); da.hidden = !acts; }
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
  const pts = (state.nav.routes && state.nav.routes.length ? state.nav.routes : [route]).flatMap(r => r.coords);
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
    const routes = await cachedRoutes(from, dest);
    if (state.nav.dest !== dest) return;           // kamēr meklēja, izvēlēts cits galamērķis
    const route = routes[0];
    state.nav.routes = routes;
    state.nav.altPicked = false;
    state.nav.barrierEls = null;
    clearBarriers();
    state.nav.route = route;
    drawRoute(route);
    signs.setRoute(route);     // rāda tikai maršruta zīmes manā virzienā
    prepareRoute(route);
    state.follow = false;
    $('routeDest').textContent = dest.name;
    $('routeSub').textContent = state.me ? (dest.sub || '')
      : ({ denied: 'Atrašanās vieta nav atļauta — maršruts no kartes centra. Ieslēdz atrašanās vietu pārlūkā.',
           unavailable: 'Neizdodas noteikt atrašanās vietu — maršruts no kartes centra.' })[getLocationState()]
        || 'Meklē tavu atrašanās vietu — pagaidām maršruts no kartes centra.';
    fillRouteCard(route);
    $('routeCard').hidden = false;
    $('bottombar').hidden = true;
    document.documentElement.classList.add('previewing');
    drawAltRoutes();
    updateRouteSummary();
    if ($('routeTraffic')) $('routeTraffic').hidden = true;
    trafficForPreview(routes);                     // sastrēgumi visos maršrutos (traffic-gl.js)
    barriersForPreview(routes, dest);              // F4: barjeras / privāti ceļi (Overpass, asinhroni)
    // Telefonā tastatūra vēl aizveras — karti pielāgo, kad ekrāns ir pilnā izmērā.
    setTimeout(fitRoute, 350);
  } catch (err) {
    console.error(err);
    czToast('Maršrutu neizdevās atrast. Pamēģini vēlreiz.', true);   // F9: statusa joslu aizsedz maršruta kartīte / meklēšana / tastatūra
  } finally {
    setBusy('route', null);
  }
}

// ---------- Ekrāns neizslēdzas navigācijas laikā (Screen Wake Lock) ----------
class ScreenAwake {
  constructor() { this.lock = null; this.want = false; this.ok = typeof navigator !== 'undefined' && 'wakeLock' in navigator; }
  async on() {
    this.want = true;
    if (!this.ok || this.lock) return;
    try {
      this.lock = await navigator.wakeLock.request('screen');
      this.lock.addEventListener('release', () => { this.lock = null; });
    } catch { this.lock = null; }
  }
  async off() {
    this.want = false;
    if (this.lock) { try { await this.lock.release(); } catch { /* */ } this.lock = null; }
  }
  // Pēc atgriešanās lietotnē pārlūks atbrīvo bloķējumu — to atjauno.
  resume() { if (this.want && !this.lock && document.visibilityState === 'visible') this.on(); }
}
const screenAwake = new ScreenAwake();
document.addEventListener('visibilitychange', () => screenAwake.resume());
// Balss funkcija noņemta: izdzēš telefonā agrāk saglabātos balss failus (līdz ~65 MB).
try { if (window.caches) for (const c of ['cz-voice-v1', 'cz-voice-rec-v1']) caches.delete(c).catch(() => {}); } catch { /* */ }

function startNav() {
  if (!state.nav.route) return;
  screenAwake.on();                  // ekrāns neizslēdzas, kamēr navigē
  state.nav.active = true;
  state.nav.offCount = 0;
  clearAltRoutes();
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
  if (typeof trafficOffer === 'function') trafficOffer();   // F15: pirmajā navigācijā — vai dalīties ar ātrumu (vienreiz)
  if (state.testMode) startSimulation();
  else if (state.me) onFix(state.me.lat, state.me.lng, state.me.speedKmh, null, 1200, state.me.accuracy);
}

function endNav() {
  screenAwake.off();
  stopSimulation();
  resetNavProgress();
  routePrepId++;
  setBusy('prep', null);
  signs.setRoute(null);
  $('nextSign').hidden = true;
  state.nav = { dest: null, route: null, active: false, offCount: 0, lastReroute: 0, along: null };
  drawRoute(null);
  clearAltRoutes();
  clearBarriers();
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
    reportWatchAhead(a);
    if (a && (!next || a.dist < d)) {
      next = null; d = a.dist;
      setNextCard(alertDataUrl(a.it.type), d, ALERT_TYPES[a.it.type].label + (a.it.source === 'user' || a.it.mine ? ' (tavs ziņojums)' : ''));
      return;
    }
  } else reportWatchAhead(undefined);
  if (!next) { card.hidden = true; return; }
  if (alertsMode) {
    const t = alertTypeForSign(next.s);
    const ti = signTimeInfo(next.s);
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

// ---------- Brīdinājumi ----------
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

// ---------- Brīdinājumu marķieri: punkti attālinātā kartē ↔ pilnas ikonas tuvinātā ----------
// Tālu: mazi, eleganti, viegli spīdoši punkti (identitātes krāsā); blīvās vietās tie saplūst vienā
// nedaudz lielākā punktā (svarīgākā veida krāsā). Tuvu: pilni marķieri. Pāreja abos virzienos animēta.
const MARKER_IN_ZOOM = 13;     // tuvinot līdz šim — punkti pārvēršas ikonās
const MARKER_OUT_ZOOM = 12.6;  // attālinot zem šī — ikonas atpakaļ punktos (histerēze: nav mirgošanas)
const ALERT_DOTS_SRC = 'alert-dots';
function alertIconSize(k) { return ['interpolate', ['linear'], ['zoom'], 12, 0.62 * k, 16, 1 * k, 18.5, 1.22 * k]; }
function installAlertLayer() {
  if (map.getSource('alerts')) return;
  map.addSource('alerts', { type: 'geojson', data: EMPTY_FC });
  installAlertDots();
  map.addLayer({
    id: 'alerts', type: 'symbol', source: 'alerts',
    minzoom: SIGNS_MIN_ZOOM,
    filter: ['!', ['in', ['get', 'icon'], ['literal', RADAR_TYPES.map(t => 'alert:' + t)]]],   // radari — savā slānī
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-size': alertIconSize(markerMorph.pos ? 1 : 0.3),
      'icon-anchor': 'bottom-left', 'icon-offset': [-5.5, 4.75],   // burbuļa astes gals — tieši notikuma vietā
      'icon-allow-overlap': true,
      'icon-pitch-alignment': 'viewport', 'icon-rotation-alignment': 'viewport',
      'symbol-sort-key': ['get', 'prio'],
      'visibility': markerMorph.pos ? 'visible' : 'none',
    },
    paint: { 'icon-opacity': markerMorph.pos },
  });
  refreshAlerts();
  applyMarkerFrame(markerFrame(markerMorph.pos), true);
}
// Punktu slāņi (atsevišķs avots ar apvienošanu). r — rādiusa reizinātājs animācijai.
function dotRadius(r) {
  // zoom drīkst būt tikai augšējā līmenī; apvienotie punkti — nedaudz lielāki pēc skaita
  const cl = ['interpolate', ['linear'], ['get', 'point_count'], 2, 4.3 * r, 12, 5.6 * r, 60, 7 * r];
  return ['interpolate', ['linear'], ['zoom'],
    9, ['case', ['has', 'point_count'], cl, 3.1 * r],
    MARKER_IN_ZOOM, ['case', ['has', 'point_count'], cl, 4.4 * r]];
}
function installAlertDots() {
  if (map.getSource(ALERT_DOTS_SRC)) return;
  map.addSource(ALERT_DOTS_SRC, { type: 'geojson', data: EMPTY_FC, cluster: true, clusterMaxZoom: 11, clusterRadius: 14,
    clusterProperties: { code: ['min', ['get', 'code']] } });
  const col = alertCodeColorExpr();
  const before = map.getLayer('signs') ? 'signs' : undefined;
  const base = { source: ALERT_DOTS_SRC, minzoom: SIGN_DOTS_MIN_ZOOM };
  map.addLayer(Object.assign({ id: 'alert-dots-glow', type: 'circle', paint: {
    'circle-color': col, 'circle-radius': dotRadius(2.5), 'circle-blur': 1, 'circle-opacity': 0.32,
    'circle-pitch-alignment': 'map' } }, base), before);
  map.addLayer(Object.assign({ id: 'alert-dots', type: 'circle', paint: {
    'circle-color': col, 'circle-radius': dotRadius(1),
    'circle-stroke-color': '#ffffff', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, 1.1, 13, 1.5],
    'circle-stroke-opacity': 0.92, 'circle-opacity': 1 } }, base), before);
  // Mazs atspīdums augšā pa kreisi — punkti izskatās kā stikla pērlītes
  map.addLayer(Object.assign({ id: 'alert-dots-shine', type: 'circle', paint: {
    'circle-color': '#ffffff', 'circle-radius': dotRadius(0.36), 'circle-translate': [-0.9, -1],
    'circle-opacity': 0.7 } }, base), before);
}
let signDots = [];
function refreshAlertDots() {
  const src = map && map.getSource && map.getSource(ALERT_DOTS_SRC);
  if (!src) return;
  const show = state.signsOn && state.mapMode === 'alerts';
  const own = show && alerts ? alerts.list().filter(it => !RADAR_TYPES.includes(it.type)).map(it => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [it.lng, it.lat] },
    properties: { code: alertCode(it.type) } })) : [];
  src.setData({ type: 'FeatureCollection', features: show ? signDots.concat(own) : [] });
}

// ----- Pāreja punkts ↔ ikona (2 varianti: "pop" — „Uzlēciens”, "morph" — „Pārveidošanās”; vērtības nemainīt — saglabātas lietotāju ierīcēs) -----
// pos: 0 — punkti, 1 — ikonas. Animē laika gaitā uz mērķi; kadra vērtības nosaka varianta līknes.
const markerMorph = { pos: 1, target: 1, raf: 0, last: 0, pending: 0, kind: store.get('markerAnim', 'pop') };
const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
const smooth = x => { x = clamp01(x); return x * x * (3 - 2 * x); };
const backOut = (x, c) => { x = clamp01(x); const u = x - 1; return 1 + (c + 1) * u * u * u + c * u * u; };
const MARKER_VARIANTS = {
  // Uzlēciens (pop): punkts nedaudz palielinās → ikona parādās ar fade + scale un nelielu atsitienu
  pop: { ms: 340, frame: t => ({
    dotR: 1 + 0.35 * smooth(t / 0.35), dotOp: 1 - smooth((t - 0.28) / 0.32),
    glow: 1 + 0.7 * smooth(t / 0.3) * (1 - smooth((t - 0.35) / 0.35)),
    iconOp: smooth((t - 0.2) / 0.32), iconS: 0.55 + 0.45 * backOut((t - 0.2) / 0.8, 1.6),
  }) },
  // Pārveidošanās (morph): punkts "ieelpo", paplašinās ar mirdzumu, no tā izaug ikona ar mazu atlēcienu
  morph: { ms: 560, frame: t => {
    const inhale = 1 - 0.24 * Math.sin(Math.PI * clamp01(t / 0.36));
    const grow = 1 + 0.95 * smooth((t - 0.16) / 0.32);
    const u = clamp01((t - 0.3) / 0.7);
    return {
      dotR: inhale * grow, dotOp: 1 - smooth((t - 0.42) / 0.26),
      glow: 1 + 1.1 * smooth((t - 0.12) / 0.3) * (1 - smooth((t - 0.5) / 0.3)),
      iconOp: smooth((t - 0.3) / 0.24),
      iconS: u <= 0 ? 0.22 : 1 - 0.78 * Math.exp(-5.2 * u) * Math.cos(9.4 * u),
    };
  } },
};
function markerFrame(pos) {
  const v = MARKER_VARIANTS[markerMorph.kind] || MARKER_VARIANTS.pop;
  if (pos <= 0) return { dotR: 1, dotOp: 1, glow: 1, iconOp: 0, iconS: 0.3 };
  if (pos >= 1) return { dotR: 1, dotOp: 0, glow: 1, iconOp: 1, iconS: 1 };
  return v.frame(pos);
}
const markerLast = {};
function applyMarkerFrame(f, force) {
  if (!map) return;
  const set = (key, val, fn) => { if (force || markerLast[key] !== val) { markerLast[key] = val; fn(val); } };
  const r2 = x => Math.round(x * 100) / 100;
  const dotsOn = f.dotOp > 0.01, iconsOn = f.iconOp > 0.01;
  for (const id of ['alert-dots-glow', 'alert-dots', 'alert-dots-shine']) {
    if (map.getLayer(id)) set('vis:' + id, dotsOn ? 'visible' : 'none', v => map.setLayoutProperty(id, 'visibility', v));
  }
  if (dotsOn && map.getLayer('alert-dots')) {
    set('dotR', r2(f.dotR), v => { map.setPaintProperty('alert-dots', 'circle-radius', dotRadius(v)); map.setPaintProperty('alert-dots-shine', 'circle-radius', dotRadius(0.36 * v)); });
    set('dotOp', r2(f.dotOp), v => { map.setPaintProperty('alert-dots', 'circle-opacity', v); map.setPaintProperty('alert-dots', 'circle-stroke-opacity', 0.92 * v); map.setPaintProperty('alert-dots-shine', 'circle-opacity', 0.7 * v); });
    set('glow', r2(f.glow) + ':' + r2(f.dotOp), () => { map.setPaintProperty('alert-dots-glow', 'circle-radius', dotRadius(2.5 * f.dotR * (0.85 + 0.15 * f.glow))); map.setPaintProperty('alert-dots-glow', 'circle-opacity', Math.min(0.75, 0.32 * f.glow) * f.dotOp); });
  }
  if (map.getLayer('alerts')) {
    set('vis:alerts', iconsOn ? 'visible' : 'none', v => map.setLayoutProperty('alerts', 'visibility', v));
    if (iconsOn) {
      set('iconS', r2(f.iconS), v => map.setLayoutProperty('alerts', 'icon-size', alertIconSize(v)));
      set('iconOp', r2(f.iconOp), v => map.setPaintProperty('alerts', 'icon-opacity', v));
    }
  }
  if (signs && map.getLayer('signs')) signs.setPinAnim(iconsOn ? r2(f.iconS) : 0.3, r2(f.iconOp));
}
function markerTargetFor(z) {
  if (z >= MARKER_IN_ZOOM) return 1;
  if (z < MARKER_OUT_ZOOM) return 0;
  return markerMorph.target;   // starp sliekšņiem — paliek kā bija
}
// Sāk pāreju uz mērķi. Tuvinot — gaida, kamēr zīmju marķieri ir aprēķināti (punkti pa to laiku paliek redzami).
function setMarkerTarget(target, now) {
  markerMorph.target = target;
  clearTimeout(markerMorph.pending); markerMorph.pending = 0;
  const waitPins = target === 1 && signs && signs.dotFor && signs.enabled && !signs._pinsShown && !now;
  if (waitPins) { markerMorph.pending = setTimeout(() => runMarkerMorph(), 1500); return; }
  runMarkerMorph();
}
function runMarkerMorph() {
  clearTimeout(markerMorph.pending); markerMorph.pending = 0;
  cancelAnimationFrame(markerMorph.raf);
  markerMorph.last = performance.now();
  const step = now => {
    const v = MARKER_VARIANTS[markerMorph.kind] || MARKER_VARIANTS.pop;
    const dir = markerMorph.target > markerMorph.pos ? 1 : -1;
    const dt = Math.min(64, now - markerMorph.last); markerMorph.last = now;
    // attālinot — nedaudz ātrāk (ikona "ievelkas" punktā)
    markerMorph.pos = clamp01(markerMorph.pos + dir * dt / (dir > 0 ? v.ms : v.ms * 0.8));
    applyMarkerFrame(markerFrame(markerMorph.pos));
    if (markerMorph.pos !== markerMorph.target) markerMorph.raf = requestAnimationFrame(step);
  };
  markerMorph.raf = requestAnimationFrame(step);
}
// Priekšskatījums iestatījumos: punkti → ikonas (ja karte ir pietiekami tuvu)
function previewMarkerMorph() {
  if (map.getZoom() < MARKER_IN_ZOOM) { map.easeTo({ zoom: 15, duration: 700 }); return; }
  cancelAnimationFrame(markerMorph.raf);
  markerMorph.pos = 0; applyMarkerFrame(markerFrame(0));
  setTimeout(() => setMarkerTarget(1, true), 450);
}
function watchMarkerMorph() {
  markerMorph.pos = markerMorph.target = map.getZoom() >= MARKER_IN_ZOOM ? 1 : 0;
  map.on('zoom', () => {
    const t = markerTargetFor(map.getZoom());
    if (t !== markerMorph.target) setMarkerTarget(t);
  });
}
// Zīmju marķieri parādījās (pēc tuvināšanas) — ja gaidām, sākam pāreju tagad.
function onSignPinsShown() { if (markerMorph.pending) runMarkerMorph(); }
// ======================= RADARU SLĀNIS ("radaru zvaigznājs") =======================
// Radari (stacionārās un mobilās ātruma kameras) ir atsevišķs, īpašs slānis:
//  • tālu — "zvaigznājs": violeti punkti ar gaišu malu, maigu oreolu un retiem, nesinhroniem
//    radiāliem impulsiem (katram radaram sava fāze), ļoti tuvi radari apvienojas punktā ar skaitu;
//  • tuvinot — nepārtraukta pāreja (pēc tuvinājuma, bez lēcieniem): punkts → mirdzošs punkts →
//    no tā izaug radara marķieris (aste paliek precīzajā vietā, impulsi turpinās zem tās);
//  • braucot pa maršrutu — radars priekšā kļūst nedaudz pamanāmāks, tuvu — vēl mazliet; garām — atpakaļ;
//  • pieskaroties — izvēlēts stāvoklis (stiprāks mirdzums, nedaudz lielāks marķieris).
// Animācija: vienots laiks T tiek nodots GPU izteiksmēm (2–3 krāsojuma īpašības ~30 kadri/s);
// katra radara fāze ir tā datos — nav DOM elementu, nav animācijas uz katru marķieri atsevišķi.
const RADAR_TYPES = ['camera-fixed', 'camera-mobile'];
const RADAR_SRC = 'radar';
const RADAR_PERIOD = 4.6;      // s — viens impulss + atpūta
const RADAR_EMIT = 0.62;       // cikla daļa, kurā gredzens izplešas (pārējā — miers)
const RADAR_ICON_FROM = 12.2, RADAR_ICON_FULL = 13.5;   // marķiera "izaugšana" pēc tuvinājuma
let radarSignDots = [];
const radar = { sel: null, raf: 0, last: 0, t0: performance.now(), on: false, dark: true, near: new Map() };

function mapIsDark() {
  const c = state.basemap;
  return c === 'dark' || (c === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}
function isRadarCode(code) { return RADAR_TYPES.includes(ALERT_ORDER[code]); }
function radarPhase(lng, lat) {           // stabila, vienmērīgi izkliedēta fāze no koordinātām
  const x = Math.sin(lng * 12.9898 + lat * 78.233) * 43758.5453;
  return Math.round((x - Math.floor(x)) * 1000) / 1000;
}
// Dati: zīmju radari (no zīmju slāņa) + lietotāju/OSM ziņotie radari
function refreshRadar() {
  const src = map && map.getSource && map.getSource(RADAR_SRC);
  if (!src) return;
  const show = state.signsOn && state.mapMode === 'alerts';
  const feats = [];
  if (show) {
    const nav = state.nav.active && state.nav.route && state.nav.along != null;
    const add = (lng, lat, type, rel, aid = null) => {
      const k = lng.toFixed(5) + ',' + lat.toFixed(5);
      let ahead = 0;
      if (nav && rel !== 'other') {
        const r = signs._matchRoute(lat, lng);
        if (r && r.d < 35) { const d = r.along - state.nav.along; if (d > -15 && d < 1600) ahead = d < 450 ? 2 : 1; }
      }
      feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] },
        properties: { k, type, icon: 'alert:' + type, ph: radarPhase(lng, lat), ahead, sel: radar.sel === k ? 1 : 0, aid: aid || '' } });
    };
    for (const f of radarSignDots) add(f.geometry.coordinates[0], f.geometry.coordinates[1], ALERT_ORDER[f.properties.code], f.properties.rel);
    if (alerts) for (const it of alerts.list()) if (RADAR_TYPES.includes(it.type)) add(it.lng, it.lat, it.type, null, it.id);
  }
  src.setData({ type: 'FeatureCollection', features: feats });
  radar.count = feats.length;
  radarAnimate();
}

// ----- Izteiksmes -----
const RZ = (...stops) => ['interpolate', ['linear'], ['zoom'], ...stops];
const easeOutX = x => ['-', 1, ['^', ['-', 1, x], 2]];
function radarU(T) { return ['%', ['+', T / RADAR_PERIOD, ['coalesce', ['get', 'ph'], 0.5]], 1]; }
const aheadCase = (a2, a1, a0) => ['case', ['==', ['coalesce', ['get', 'ahead'], 0], 2], a2, ['==', ['coalesce', ['get', 'ahead'], 0], 1], a1, a0];
// Impulsa gredzens: izplešas (ease-out) un izdziest, tad atpūta. Rādiuss atkarīgs arī no tuvinājuma.
function radarRingRadius(T) {
  const u = radarU(T), x = ['min', 1, ['/', u, RADAR_EMIT]], e = easeOutX(x);
  const r = (a, b) => ['*', ['+', a, ['*', b - a, e]], ['case', ['has', 'point_count'], 1.25, aheadCase(1.35, 1.18, 1)]];
  return RZ(9, r(3.2, 12), 12, r(4.2, 16), 14, r(7, 26), 17, r(9, 34));
}
function radarRingOpacity(T) {
  const u = radarU(T), x = ['min', 1, ['/', u, RADAR_EMIT]];
  const a = radar.dark ? aheadCase(0.78, 0.6, 0.42) : aheadCase(0.7, 0.52, 0.34);
  return ['case', ['<', u, RADAR_EMIT], ['*', a, ['^', ['-', 1, x], 1.6]], 0];
}
// Oreols "elpo" ļoti lēni un katram radaram savā ritmā (sīka intensitātes variācija)
function radarHaloOpacity(T) {
  const base = radar.dark ? aheadCase(0.42, 0.32, 0.22) : aheadCase(0.3, 0.22, 0.14);
  const breathe = ['+', 1, ['*', 0.22, ['sin', ['*', 2 * Math.PI, ['+', T / 6.3, ['coalesce', ['get', 'ph'], 0.5]]]]]];
  return ['*', ['case', ['==', ['coalesce', ['get', 'sel'], 0], 1], 1.8, 1], base, breathe];
}
function installRadarLayer() {
  if (map.getSource(RADAR_SRC)) return;
  radar.dark = mapIsDark();
  map.addSource(RADAR_SRC, { type: 'geojson', data: EMPTY_FC, cluster: true, clusterMaxZoom: 10, clusterRadius: 16,   // clusterMaxZoom — tikai vesels skaitlis
    clusterProperties: { ph: ['max', ['get', 'ph']], ahead: ['max', ['get', 'ahead']] } });
  const P = radar.dark
    ? { core: '#7d63ff', edge: '#cfc4ff', halo: '#8b6dff', ring: '#b9a8ff' }
    : { core: '#6a4df2', edge: '#ffffff', halo: '#7a5cff', ring: '#7a5cff' };
  const T = (performance.now() - radar.t0) / 1000;
  const below = map.getLayer('route-casing') ? 'route-casing' : (map.getLayer('signs') ? 'signs' : undefined);
  const above = map.getLayer('signs') ? 'signs' : undefined;
  const base = { source: RADAR_SRC, minzoom: SIGN_DOTS_MIN_ZOOM };
  const cluster = ['has', 'point_count'];
  // 1) maigs oreols (zem maršruta līnijas — nekonkurē ar maršrutu)
  map.addLayer(Object.assign({ id: 'radar-halo', type: 'circle', paint: {
    'circle-color': P.halo, 'circle-blur': 1, 'circle-pitch-alignment': 'map',
    'circle-radius': RZ(9, ['case', cluster, 13, aheadCase(12, 10, 8)], 13, ['case', cluster, 18, aheadCase(20, 16, 13)], 16, aheadCase(30, 25, 21)),
    'circle-opacity': radarHaloOpacity(T) } }, base), below);
  // 2) impulsa gredzens
  map.addLayer(Object.assign({ id: 'radar-ring', type: 'circle', paint: {
    'circle-color': P.ring, 'circle-opacity': 0, 'circle-pitch-alignment': 'map',
    'circle-stroke-color': P.ring, 'circle-stroke-width': RZ(9, 1, 14, 1.5),
    'circle-radius': radarRingRadius(T), 'circle-stroke-opacity': radarRingOpacity(T) } }, base), below);
  // 3) kodols — skaidrs violets punkts ar gaišu malu; tuvinot (12,9…13,8) maigi izzūd, jo no tā izaug marķieris
  const coreFade = v => RZ(12.9, v, 13.8, 0);
  map.addLayer(Object.assign({ id: 'radar-core', type: 'circle', maxzoom: 14, paint: {
    'circle-color': P.core, 'circle-pitch-alignment': 'map',
    'circle-radius': RZ(9, ['case', cluster, ['interpolate', ['linear'], ['get', 'point_count'], 2, 7.5, 10, 9, 40, 11], aheadCase(4.6, 4.2, 3.6)],
      12.2, ['case', cluster, 9, aheadCase(5.8, 5.4, 4.8)], 13.6, aheadCase(5, 4.6, 4)),
    'circle-stroke-color': P.edge, 'circle-stroke-width': RZ(9, 1.2, 13, 1.6), 'circle-stroke-opacity': coreFade(0.95),
    'circle-opacity': coreFade(1) } }, base), above);
  // mazs iekšējais atspīdums (tikai atsevišķiem punktiem) — "dārgakmens" sajūta
  map.addLayer(Object.assign({ id: 'radar-core-shine', type: 'circle', maxzoom: 14, filter: ['!', cluster], paint: {
    'circle-color': '#ffffff', 'circle-radius': RZ(9, 1.1, 13, 1.6), 'circle-translate': [-1, -1.1],
    'circle-opacity': coreFade(0.75) } }, base), above);
  // 4) apvienoto radaru skaits
  map.addLayer(Object.assign({ id: 'radar-count', type: 'symbol', filter: cluster, layout: {
    'text-field': ['to-string', ['get', 'point_count']], 'text-font': ['Noto Sans Bold'], 'text-size': 10.5,
    'text-allow-overlap': true, 'text-ignore-placement': true },
    paint: { 'text-color': '#ffffff' } }, base), above);
  // 5) radara marķieris: izaug no punkta (izmērs un caurspīdība — pēc tuvinājuma, nepārtraukti); aste — precīzā vieta
  const sel = v => ['case', ['==', ['coalesce', ['get', 'sel'], 0], 1], v * 1.14, aheadCase(v * 1.08, v * 1.04, v)];
  map.addLayer({ id: 'radar-icon', type: 'symbol', source: RADAR_SRC, minzoom: RADAR_ICON_FROM, filter: ['!', cluster],
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-size': RZ(RADAR_ICON_FROM, sel(0.2), RADAR_ICON_FULL, sel(0.84), 16, sel(1.08), 18.5, sel(1.3)),
      'icon-anchor': 'bottom-left', 'icon-offset': [-5.5, 4.75],
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'icon-pitch-alignment': 'viewport', 'icon-rotation-alignment': 'viewport',
      'symbol-sort-key': ['-', 10, ['coalesce', ['get', 'ahead'], 0]],
    },
    paint: { 'icon-opacity': RZ(RADAR_ICON_FROM, 0, RADAR_ICON_FROM + 0.75, 1) } }, above);
  refreshRadar();
}
// Laika animācija: tikai, kad slānis redzams un ir radari; ~30 kadri/s; cilnē fonā — apstājas.
function radarAnimate() {
  if (radar.raf || !map || !map.getLayer('radar-ring')) return;
  const step = now => {
    radar.raf = 0;
    if (!map.getLayer('radar-ring') || !radar.count || document.hidden || map.getZoom() < SIGN_DOTS_MIN_ZOOM) return;
    if (now - radar.last >= 33) {
      radar.last = now;
      const T = Math.round((now - radar.t0) / 10) / 100;
      map.setPaintProperty('radar-ring', 'circle-radius', radarRingRadius(T));
      map.setPaintProperty('radar-ring', 'circle-stroke-opacity', radarRingOpacity(T));
      if ((radar.f = (radar.f || 0) + 1) % 3 === 0) map.setPaintProperty('radar-halo', 'circle-opacity', radarHaloOpacity(T));
    }
    radar.raf = requestAnimationFrame(step);
  };
  radar.raf = requestAnimationFrame(step);
}
function wireRadar() {
  document.addEventListener('visibilitychange', () => { if (!document.hidden) radarAnimate(); });
  map.on('zoomend', radarAnimate);
  // braucot — "radars priekšā" stāvoklis tiek pārrēķināts ik pēc ~2 s
  setInterval(() => { if (state.nav.active) refreshRadar(); }, 2000);
  const onTap = e => {
    const f = e.features && e.features[0];
    if (!f) return;
    if (f.properties.point_count) {   // apvienotais punkts — pietuvina līdz tam, kur tas sadalās
      map.getSource(RADAR_SRC).getClusterExpansionZoom(f.properties.cluster_id).then(z =>
        map.easeTo({ center: f.geometry.coordinates, zoom: Math.min(z + 0.5, 14), duration: 650 })).catch(() => {});
      return;
    }
    radar.sel = f.properties.k; refreshRadar();
    if (f.properties.aid && alerts && alerts.items.get(f.properties.aid)) {   // lietotāju ziņots radars — ar „Vēl ir / Vairs nav”
      const p = showAlertPopup(f.properties.aid, f.geometry.coordinates, [6, -30]);
      if (p) p.on('close', () => { if (radar.sel === f.properties.k) { radar.sel = null; refreshRadar(); } });
      return;
    }
    const el = document.createElement('div');
    const b = document.createElement('div'); b.textContent = ALERT_TYPES[f.properties.type].label; el.appendChild(b);
    const popup = new maplibregl.Popup({ closeButton: false, offset: [6, -30], maxWidth: '240px' })
      .setLngLat(f.geometry.coordinates).setDOMContent(el).addTo(map);
    popup.on('close', () => { if (radar.sel === f.properties.k) { radar.sel = null; refreshRadar(); } });
  };
  for (const id of ['radar-icon', 'radar-core']) {
    map.on('click', id, onTap);
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
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
  refreshAlertDots();
  refreshRadar();
}

function showAlertPopup(id, coords, offset = 18) {
  const it = alerts.items.get(id);
  if (!it) return null;
  const el = document.createElement('div');
  const b = document.createElement('div'); b.textContent = ALERT_TYPES[it.type].label; el.appendChild(b);
  const i = document.createElement('div'); i.className = 'popup-time';
  i.textContent = it.source === 'shared' ? reportInfo(it) : alertInfo(it); el.appendChild(i);
  const popup = new maplibregl.Popup({ closeButton: false, offset, maxWidth: '270px' }).setLngLat(coords).setDOMContent(el).addTo(map);
  if (it.source === 'shared') reportPopupActions(el, it, popup, i);
  else if (it.source === 'user') {
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'btn ghost small popup-btn'; del.textContent = 'Vairs nav — noņemt';
    del.addEventListener('click', () => { alerts.remove(id); refreshAlerts(); popup.remove(); });
    el.appendChild(del);
  }
  return popup;
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
    if (it.source === 'shared') {                     // citu ziņojumi: tikai tuvu priekšā un tajā pašā virzienā (±45°)
      if (dist > REPORT_AHEAD_M) continue;
      if (it.heading != null && bearing != null && angleDiff(it.heading, bearing) > REPORT_HEADING_TOL) continue;
    }
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
  $('reportBtn').addEventListener('click', () => { reportSheetMsg(''); $('reportSheet').hidden = false; reportGpsRefresh(); });
  $('reportGpsBtn').addEventListener('click', () => {
    if (getLocationState() === 'denied') { openGpsHelp(); return; }
    gpsTimeouts = 0; gpsClear(); startGps(); reportGpsRefresh();             // „Mēģināt vēlreiz”
  });
  $('closeReport').addEventListener('click', () => { $('reportSheet').hidden = true; });
  setInterval(() => loadWeather(false), 60000);
}

// ---------- Kopīgi ziņojumi (F10, reports.js + supabase/reports.sql) ----------
let reportsApi = null;
const reportsState = { timer: null, seq: 0, sending: false, watch: null, asked: new Set(), warned: new Set() };

// Uznirstošs paziņojums virs visa (nevis statusa joslā aiz loga)
function czToast(text, loud) { if (typeof parkToast === 'function') parkToast(text, loud); else setStatus(text); }
// Ziņa ziņošanas logā pie pogām
function reportSheetMsg(text, kind = 'err') {
  const m = $('reportMsg');
  if (!m) return;
  m.textContent = text; m.hidden = !text; m.className = 'rep-msg ' + kind;
}

function reportsInit() {
  reportsApi = new ReportsApi(typeof czAuthGet === 'function' ? czAuthGet() : null);
  const start = () => { loadReports(true); migrateOldReports(); };
  if (typeof czWhenConsent === 'function') czWhenConsent(start); else start();
  setInterval(() => { if (!document.hidden) loadReports(true); }, REPORT_REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadReports(true); });
}
function loadReportsSoon() { clearTimeout(reportsState.timer); reportsState.timer = setTimeout(() => loadReports(false), 700); }

// Ielādē aktīvos ziņojumus redzamajam kartes apgabalam un aizstāj iepriekšējos
async function loadReports(force) {
  if (!reportsApi || !map || !alerts) return;
  if (typeof czConsentOk === 'function' && !czConsentOk()) return;
  const b = map.getBounds();
  const view = { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() };
  // Kartei pārvietojoties (arī braucot) — jauns pieprasījums tikai, ja redzamais apgabals iziet ārpus ielādētā
  const L = reportsState.box;
  if (!force && L && Date.now() - reportsState.at < REPORT_REFRESH_MS &&
      view.s >= L.min_lat && view.n <= L.max_lat && view.w >= L.min_lng && view.e <= L.max_lng) return;
  const bbox = reportBBox(view);
  if (!bbox) return;
  reportsState.box = bbox; reportsState.at = Date.now();
  const seq = ++reportsState.seq;
  let list;
  try { list = await reportsApi.list(bbox); } catch (e) { reportsState.box = null; console.warn('Ziņojumi nav ielādēti', e); return; }
  if (seq !== reportsState.seq) return;              // pa to laiku pieprasīts jaunāks
  for (const [id, it] of alerts.items) if (it.source === 'shared') alerts.items.delete(id);
  for (const it of list) if (ALERT_TYPES[it.type]) alerts.items.set(it.id, it);
  refreshAlerts();
}

// Mana vieta ziņojumam: uz ceļa, kur esmu (kartes piesaiste), citādi GPS vieta
// F20: ziņošanas logā — kāpēc nevar ziņot (pēc īstā iemesla) un pogas pelēkas, kamēr vietas nav
const REPORT_GPS = {
  denied: ['Atrašanās vieta nav atļauta — ieslēdz to, lai varētu ziņot.', 'Kā ieslēgt?'],
  searching: ['Meklē tavu atrašanās vietu…', ''],
  unavailable: ['Neizdodas noteikt atrašanās vietu. Pārbaudi, vai telefonā ir ieslēgta atrašanās vieta (GPS), un mēģini vēlreiz.', 'Mēģināt vēlreiz'],
};
function reportGpsRefresh() {
  const box = $('reportGps');
  if (!box) return;
  const st = getLocationState(), ok = st === 'ok' && !!reportPlace();
  const [text, btn] = ok ? ['', ''] : REPORT_GPS[st] || REPORT_GPS.searching;
  box.hidden = ok;
  box.className = 'rep-gps ' + (st === 'searching' ? 'info' : 'err');
  $('reportGpsText').textContent = text;
  $('reportGpsBtn').textContent = btn; $('reportGpsBtn').hidden = !btn;
  if (!reportsState.sending) for (const b of document.querySelectorAll('#reportGrid button')) b.disabled = !ok;
}
function reportPlace() {
  return signs.pos && !signs.pos.uncertain ? { lat: signs.pos.P[1], lng: signs.pos.P[0] } : state.me;
}
async function reportAlert(type) {
  if (reportsState.sending) return;
  const p = reportPlace();
  if (!p || getLocationState() !== 'ok') { reportGpsRefresh(); return; }                 // F20: iemesls un poga — loga augšā
  reportsState.sending = true;
  const btns = [...document.querySelectorAll('#reportGrid button')];
  btns.forEach(x => { x.disabled = true; });
  reportSheetMsg('Sūta…', 'info');
  try {
    const res = await reportsApi.create(type, p.lat, p.lng, state.heading);
    $('reportSheet').hidden = true;
    reportSheetMsg('');
    const label = ALERT_TYPES[type].label;
    if (res && res.merged) czToast(`Paldies! „${label}” šeit jau bija ziņots — tavs apstiprinājums pieskaitīts.`);
    else czToast(`Paldies! „${label}” nosūtīts — to redz visi tuvumā ${reportDur(ALERT_TYPES[type].ttl)}.`);
    await loadReports(true);
  } catch (e) {
    reportSheetMsg(reportErrorText(e.code));       // logs paliek atvērts — ziņa redzama pie pogām
  } finally {
    reportsState.sending = false;
    btns.forEach(x => { x.disabled = false; });
    reportGpsRefresh();
  }
}

// Popup pogas: citu ziņojumam „Vēl ir” / „Vairs nav”, savam — „Dzēst”
function reportPopupActions(el, it, popup, infoEl) {
  const row = document.createElement('div'); row.className = 'popup-actions';
  const msg = document.createElement('div'); msg.className = 'popup-msg'; msg.hidden = true;
  const say = (t, kind = 'err') => { msg.textContent = t; msg.hidden = !t; msg.className = 'popup-msg ' + kind; };
  const mk = (text, cls, fn) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small popup-btn ' + cls; b.textContent = text;
    b.addEventListener('click', async () => {
      row.querySelectorAll('button').forEach(x => { x.disabled = true; });
      say('Sūta…', 'info');
      try { await fn(); } catch (e) { say(reportErrorText(e.code)); row.querySelectorAll('button').forEach(x => { x.disabled = false; }); }
    });
    row.appendChild(b);
  };
  if (it.mine) {
    mk('Dzēst savu ziņojumu', 'ghost', async () => {
      await reportsApi.remove(it.rid);
      alerts.items.delete(it.id); refreshAlerts(); popup.remove();
      czToast('Ziņojums izdzēsts.');
    });
  } else {
    const vote = v => async () => {
      const r = await reportsApi.vote(it.rid, v);
      reportsState.asked.add(it.id);
      if (r && r.hidden) { alerts.items.delete(it.id); refreshAlerts(); popup.remove(); czToast('Paldies! Ziņojums noņemts no kartes.'); return; }
      it.myVote = v; it.still = r ? r.still : it.still;
      if (r && r.expires_at) it.expiresAt = Date.parse(r.expires_at);
      infoEl.textContent = reportInfo(it);
      say(v === 'still' ? 'Paldies! Apstiprināts.' : 'Paldies! Ja vēl kāds atzīmēs „vairs nav”, ziņojums pazudīs.', 'ok');
      row.querySelectorAll('button').forEach(x => { x.disabled = false; });
    };
    mk('Vēl ir', 'primary', vote('still'));
    mk('Vairs nav', 'ghost', vote('gone'));
  }
  el.append(row, msg);
}

// Braucot: citu ziņojums priekšā (≤ 500 m, tajā pašā virzienā) → brīdinājums; pēc garāmbraukšanas — „Vēl ir?”
// a — nextAlertAhead() rezultāts; undefined — brīdinājumi izslēgti (neko nejautā).
function reportWatchAhead(a) {
  const w = reportsState.watch;
  if (a === undefined) { reportsState.watch = null; return; }
  const isShared = a && a.it.source === 'shared' && !a.it.mine;
  if (isShared) {
    if (!reportsState.warned.has(a.it.id)) { reportsState.warned.add(a.it.id); reportAheadAlert(a.it, a.dist); }
    if (!w || w.it.id !== a.it.id || a.dist < w.dist) reportsState.watch = { it: a.it, dist: a.dist };
    if (w && w.it.id !== a.it.id) reportPassed(w);
    return;
  }
  if (w) { reportsState.watch = null; reportPassed(w); }
}
// Āķis brīdinājumam (F8: šeit pievienos balss paziņojumu). Kartīte „nākamais” to jau rāda vizuāli.
function reportAheadAlert(it, dist) { /* piem. voiceSay(`Pēc ${Math.round(dist / 50) * 50} metriem — ${it.title}`) */ }
function reportPassed(w) {
  if (!w || w.dist > 80 || !state.me) return;                       // pagriezāmies citur — nejautā
  if (distM(state.me.lat, state.me.lng, w.it.lat, w.it.lng) > 150) return;
  if (w.it.myVote || reportsState.asked.has(w.it.id) || !alerts.items.has(w.it.id)) return;
  reportsState.asked.add(w.it.id);
  reportAskStill(w.it);
}
// Neuzbāzīgs jautājums, kas pazūd pats
function reportAskStill(it) {
  let box = $('repAsk');
  if (!box) { box = document.createElement('div'); box.id = 'repAsk'; box.className = 'rep-ask'; box.setAttribute('role', 'status'); document.body.appendChild(box); }
  box.textContent = '';
  const img = document.createElement('img'); img.src = alertDataUrl(it.type); img.alt = ''; img.width = 30; img.height = 30;
  const t = document.createElement('span'); t.textContent = `${ALERT_TYPES[it.type].label} — vēl ir?`;
  const hide = () => { box.classList.remove('show'); clearTimeout(reportAskStill._t); };
  const btn = (text, cls, v) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small ' + cls; b.textContent = text;
    b.addEventListener('click', async () => {
      hide();
      try {
        const r = await reportsApi.vote(it.rid, v);
        if (r && r.hidden) { alerts.items.delete(it.id); refreshAlerts(); }
        czToast('Paldies!');
      } catch (e) { czToast(reportErrorText(e.code), true); }
    });
    return b;
  };
  const x = document.createElement('button'); x.type = 'button'; x.className = 'rep-ask-x'; x.textContent = '×'; x.setAttribute('aria-label', 'Aizvērt');
  x.addEventListener('click', hide);
  box.append(img, t, btn('Vēl ir', 'primary', 'still'), btn('Vairs nav', 'ghost', 'gone'), x);
  box.classList.add('show');
  clearTimeout(reportAskStill._t);
  reportAskStill._t = setTimeout(hide, 15000);
}

// Agrākie ierīcē saglabātie ziņojumi: aktīvos vienreiz augšupielādē serverī, tad atslēgu iztīra
async function migrateOldReports() {
  const old = store.get('reports', null);
  if (old == null) return;
  const todo = reportsToMigrate(old);
  let sent = 0;
  for (const r of todo) {
    try { await reportsApi.create(r.type, r.lat, r.lng, r.heading, r.minutes); sent++; }
    catch (e) { if (e.code === 'network' || e.code === 'consent') return; }   // vēlāk mēģinās vēlreiz
  }
  try { localStorage.removeItem(REPORT_OLD_KEY); } catch { /* */ }
  if (sent) { czToast(`Tavi agrākie ziņojumi (${sent}) tagad redzami visiem.`); loadReports(true); }
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
    signs.dotFor = s => alertCode(alertTypeForSign(s) || 'hazard');
    signs.onPinsShown = onSignPinsShown;
  } else {
    signs.setFilter(s => state.cats[s.cat] && signFitsProfile(s, state.profile));
    signs.iconFor = null;
    signs.titleFor = null;
    signs.dotFor = null;
    signs.onPinsShown = null;
  }
  signs.refresh();
  refreshAlerts();
  const btn = $('toggleSigns');
  btn.setAttribute('aria-pressed', String(state.signsOn));
  btn.classList.toggle('off', !state.signsOn);
  $('toggleSignsLabel').textContent = !state.signsOn ? 'Izslēgts' : alertsMode ? 'Brīdin.' : 'Zīmes';
  const more = $('fabMoreBtn');
  if (more) more.classList.toggle('dot', !state.signsOn);     // sarkans punkts — zīmes izslēgtas
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

// "Vairāk" poga: atver / aizver zīmju un iestatījumu pogas
function fabMore(open) {
  const items = $('fabMoreItems'), btn = $('fabMoreBtn');
  if (!items) return;
  items.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
}
function wireFabMore() {
  const btn = $('fabMoreBtn');
  if (!btn) return;
  btn.addEventListener('click', e => { e.stopPropagation(); fabMore($('fabMoreItems').hidden); });
  $('settingsBtn').addEventListener('click', () => fabMore(false));
  $('toggleSigns').addEventListener('click', () => setTimeout(() => fabMore(false), 700));   // lai redz, kas mainījās
  document.addEventListener('pointerdown', e => { if (!e.target.closest('#fabMore')) fabMore(false); });
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
  // Marķieru animācija (punkts ↔ ikona): izvēle un priekšskatījums
  $('markerAnim').value = markerMorph.kind;
  $('markerAnim').addEventListener('change', e => { markerMorph.kind = e.target.value; store.set('markerAnim', markerMorph.kind); previewMarkerMorph(); });
  $('markerAnimTest').addEventListener('click', previewMarkerMorph);
  $('warnSwitch').checked = state.warn;
  $('warnSwitch').addEventListener('change', e => { state.warn = e.target.checked; store.set('warn', state.warn); updateLimit(); });
  if ($('testSpeed')) {
    const showTs = () => { $('testSpeedVal').textContent = state.testSpeed + ' km/h'; $('testSpeedRow').hidden = !$('testSwitch').checked; };
    $('testSpeed').value = state.testSpeed;
    $('testSpeed').addEventListener('input', e => { state.testSpeed = Number(e.target.value) || 55; showTs(); });
    $('testSwitch').addEventListener('change', showTs);
    showTs();
  }
  // F6: testa režīms nekad nesākas ieslēgts (pārlūks var atjaunot slēdža stāvokli); izstrādātāja bloks — tikai izstrādātājam
  $('testSwitch').checked = state.testMode;
  if ($('testSpeedRow')) $('testSpeedRow').hidden = true;
  applyDevMode();
  wireDevTaps();
  $('devOff').addEventListener('click', () => setDevMode(false));
  $('testSwitch').addEventListener('change', e => {
    state.testMode = e.target.checked;
    if (!state.testMode) stopSimulation();
    else if (state.nav.active) startSimulation();
    czToast(state.testMode ? 'Testa režīms: noklikšķini uz ceļa kartē vai sāc maršrutu — tas tiks nobraukts automātiski.' : 'Testa režīms izslēgts.');   // F9: iestatījumu logs atvērts
  });
  $('centerBtn').addEventListener('click', () => {
    state.follow = true;
    if (gpsState === 'denied') { openGpsHelp(); return; }      // F2: liegts — instrukcijas
    if (state.me) followCamera(800);
    else { setStatus(gpsProblem || 'Meklē atrašanās vietu…'); startGps(); }
  });
  wireFabMore();
  $('gpsHelpBtn').addEventListener('click', openGpsHelp);       // F2
  $('closeGpsHelp').addEventListener('click', () => { $('gpsSheet').hidden = true; });
  $('gpsRetry').addEventListener('click', gpsRetry);
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
  tokenInput.value = store.get('mlyToken', '');
  const note = () => {
    const own = !!store.get('mlyToken', ''), pub = !!mlyPublicToken();
    $('mlyNote').textContent = own ? 'Tava atslēga saglabāta šajā ierīcē. Mapillary zīmes ir ieslēgtas.'
      : pub && state.mlyToken ? 'Izmanto lietotnes kopīgo atslēgu — Mapillary zīmes ir ieslēgtas. Savu atslēgu ievadīt nav obligāti.'
      : 'Bez atslēgas rāda tikai OpenStreetMap zīmes.';
  };
  $('mlySave').addEventListener('click', () => {
    const v = tokenInput.value.trim();
    if (v && !v.startsWith('MLY|')) { $('mlyNote').textContent = 'Atslēgai jāsākas ar MLY| — nokopē "Client Token" no Mapillary.'; return; }
    store.set('mlyToken', v); state.mlyBadShown = false; state.mlyToken = v || mlyPublicToken(); state.mlyTiles.clear(); note(); loadMapillaryForView();
  });
  note();
}

// ---------- F6: izstrādātāja režīms ----------
function applyDevMode() {
  $('devBox').hidden = !CZ_DEV;
  if (!CZ_DEV && (state.testMode || $('testSwitch').checked)) {     // paslēptā slēdzī nedrīkst „iestrēgt”
    state.testMode = false; $('testSwitch').checked = false; stopSimulation();
    if ($('testSpeedRow')) $('testSpeedRow').hidden = true;
  }
}
function setDevMode(on) {
  CZ_DEV = on;
  try { if (on) localStorage.setItem('devMode', '1'); else localStorage.removeItem('devMode'); } catch { /* tikai šai sesijai */ }
  applyDevMode();
  if (on) showCounts();
  czToast(on ? 'Izstrādātāja režīms ieslēgts' : 'Izstrādātāja režīms izslēgts');
}
// 7 ātri pieskārieni (3 s laikā) iestatījumu virsrakstam
function wireDevTaps() {
  let taps = [];
  $('settingsTitle').addEventListener('click', () => {
    const now = Date.now();
    taps = taps.filter(t => now - t < 3000).concat(now);
    if (taps.length >= 7) { taps = []; if (!CZ_DEV) setDevMode(true); }
  });
}

function cancelPreview() {
  state.nav.route = null; state.nav.dest = null; state.nav.routes = null;
  clearAltRoutes();
  clearBarriers();
  routePrepId++;
  setBusy('prep', null);
  signs.setRoute(null);
  drawRoute(null);
  if (destMarker) { destMarker.remove(); destMarker = null; }
  $('routeCard').hidden = true;
  $('bottombar').hidden = false;
  document.documentElement.classList.remove('previewing');
  // F5: lauks kā pirms meklēšanas (vērtības iestatīšana „input” notikumu neizraisa — jauna meklēšana nesākas)
  clearTimeout(searchTimer); searchSeq++; lastResults = [];
  $('searchInput').value = ''; $('clearSearch').hidden = true; $('results').hidden = true;
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
function placesKey(catId, c) { return 'c2:' + catId + ':' + Math.round(c.lat / 0.01) + ':' + Math.round(c.lng / 0.01); }
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
// ---------- Vietas darbības: Zvanīt · Mājaslapa · Lietotne ----------
const PLATFORM = /android/i.test(navigator.userAgent) ? 'android'
  : (/iphone|ipad|ipod/i.test(navigator.userAgent) || (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1)) ? 'ios' : 'desktop';
const PA_ICON = {
  call: '<path d="M6.6 3.5 9 3l1.6 4.2-2 1.5a11 11 0 0 0 6.7 6.7l1.5-2L21 15l-.5 2.4a2 2 0 0 1-2 1.6A15.5 15.5 0 0 1 5 5.5a2 2 0 0 1 1.6-2Z" fill="currentColor"/>',
  web: '<circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M3.6 12h16.8M12 3.4c2.6 2.4 3.6 5.4 3.6 8.6s-1 6.2-3.6 8.6c-2.6-2.4-3.6-5.4-3.6-8.6s1-6.2 3.6-8.6Z" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  app: '<rect x="6.5" y="2.8" width="11" height="18.4" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M12 7.4v6.4m-2.8-2.8L12 13.8l2.8-2.8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.4 18h3.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
};
function paLink(kind, href, text, title, ext) {
  const a = document.createElement('a');
  a.className = 'pa pa-' + kind; a.href = href; a.title = title;
  if (ext) { a.target = '_blank'; a.rel = 'noopener noreferrer external'; a.referrerPolicy = 'no-referrer'; }
  a.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">' + PA_ICON[kind] + '</svg><span></span>';
  a.querySelector('span').textContent = text;
  a.addEventListener('click', ev => ev.stopPropagation());
  return a;
}
// Atgriež pogu rindu vai null. Saites veidotas tikai no places.js pārbaudītām vērtībām (tel:+cipari, https://domēns).
function placeActionsEl(ct) {
  if (!ct) return null;
  const row = document.createElement('div');
  row.className = 'place-acts';
  if (ct.phone && /^tel:\+?\d{7,15}$/.test(ct.phone.tel)) row.append(paLink('call', ct.phone.tel, 'Zvanīt', 'Zvanīt ' + ct.phone.label, false));
  if (ct.web && /^https:\/\//.test(ct.web.url)) row.append(paLink('web', ct.web.url, ct.web.host, (ct.brandWeb ? 'Tīkla oficiālā mājaslapa: ' : 'Mājaslapa: ') + ct.web.host, true));
  const store = ct.app && ct.app[PLATFORM];
  if (store && /^https:\/\/(play\.google\.com|apps\.apple\.com)\//.test(store)) row.append(paLink('app', store, ct.app.name + ' lietotne', (PLATFORM === 'ios' ? 'App Store' : 'Google Play') + ': oficiālā ' + ct.app.name + ' lietotne', true));
  return row.childNodes.length ? row : null;
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
    li.appendChild(b);
    const acts = placeActionsEl(p.ct);
    if (acts) { li.classList.add('has-acts'); li.appendChild(acts); }
    ul.appendChild(li);
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
  selectDestination({ name: p.name, sub: [p.addr, PLACE_CATEGORIES.find(c => c.id === p.cat).label].filter(Boolean).join(', '), lat: p.lat, lng: p.lng, ct: p.ct || null });
}
function wirePlaces() {
  const icons = $('placesBtnIcons');
  for (const id of ['fuel', 'parking', 'food', 'coffee']) icons.insertAdjacentHTML('beforeend', placeIconSvg(id, 26));
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
  if (typeof ridesInit === 'function') ridesInit();      // kopbraucieni (rides-ui.js)
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
  // Radari — savā īpašajā slānī; pārējie brīdinājumi — kopējos punktos
  signs.onDots = feats => {
    radarSignDots = feats.filter(f => isRadarCode(f.properties.code));
    signDots = feats.filter(f => !isRadarCode(f.properties.code));
    refreshAlertDots(); refreshRadar();
  };
  watchMarkerMorph();
  wireRadar();
  // Ziņojumi tagad glabājas serverī (F10, reports.js); ierīcē nekas netiek saglabāts.
  alerts = new AlertStore(null);
  setInterval(() => { if (alerts.prune()) refreshAlerts(); }, 30000);   // novecojušos ziņojumus noņem
  reportsInit();
  setInterval(() => { signs.refresh(); updateLimit(); }, 60000); // laika ierobežojumi mainās

  map.on('style.load', () => {
    installRouteLayers();
    signs.install();
    installAlertLayer();
    installRadarLayer();
    roadIndex.ready = false; roadIndex.coverage = null;
    signs.setRoads(state.vector ? roadIndex : null);
    if (state.nav.route) drawRoute(state.nav.route);
    if (state.nav.routes && !state.nav.active) drawAltRoutes();
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
  map.on('moveend', () => { signs.refresh(); clearTimeout(init._t); init._t = setTimeout(loadAllForView, 150); loadReportsSoon(); });
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
  map.on('mouseenter', 'route-alt-hit', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'route-alt-hit', () => { map.getCanvas().style.cursor = ''; });
  map.on('click', e => {
    $('results').hidden = true;
    if (map.getLayer('signs') && map.queryRenderedFeatures(e.point, { layers: ['signs', 'alerts', 'radar-icon', 'radar-core'].filter(l => map.getLayer(l)) }).length) return;
    if (!state.nav.active && state.nav.routes && map.getLayer('route-alt-hit')) {     // uzspiests uz alternatīvā maršruta
      const f = map.queryRenderedFeatures(e.point, { layers: ['route-alt-hit'] })[0];
      if (f) { chooseRoute(f.properties.i, true); return; }
    }
    if (state.testMode && !state.nav.active) {
      // F7: testa ātrums no iestatījumiem; secīgi klikšķi pa ielu dod braukšanas virzienu
      const prev = state.testClick, la = e.lngLat.lat, lo = e.lngLat.lng;
      const d = prev ? distM(prev[0], prev[1], la, lo) : 0;
      const hd = prev && d >= 5 && d <= 500 ? bearingDeg(prev[0], prev[1], la, lo) : null;
      state.testClick = [la, lo];
      state.follow = false;
      onFix(la, lo, state.testSpeed, hd, 300);
    }
  });

  wireUi();
  buildCategoryList();
  loadVerifiedSigns();
  loadKnownRadars().then(loadSharedRadars);
  loadPlateTimes();
  wireAlerts();
  wirePlaces();
  czWhenConsent(startGps);          // atrašanās vietas atļauju prasa tikai pēc piekrišanas noteikumiem
  map.once('load', loadAllForView);
}

init();
