// Ceļa Zīmes — galvenā lietotnes loģika (MapLibre GL).
// Karte: OpenFreeMap. Zīmes: Mapillary + OpenStreetMap (Overpass).
// Meklēšana: Photon / Nominatim. Maršruts: OSRM.

// Overpass serveri — services.js (B05: tikai ES). Ja to ir vairāki: vispirms veselākais, nākamais — tikai ja pirmais
// kavējas vai kļūdās (A13; sk. fetchOverpass).
const OVERPASS_URLS = CZ_SERVICES.overpass;
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
  basemap: normBasemap(store.get('basemap', 'auto')),   // v121: tikai 'dark' / 'light'
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
// v122: kad mainās „sekot man” (pabīda karti / Centrēt), atjauno apakšējo joslu
{ let follow = state.follow; Object.defineProperty(state, 'follow', { get: () => follow, set: v => { const ch = follow !== v; follow = v; if (ch) syncRecenter(); }, enumerable: true }); }

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
//    tāpēc viltotu radaru tur iesūtīt nevar. B08: ziņot un balsot var tikai ar kontu (supabase/radars-2-votes.sql).
const radarShared = { ids: new Set(), loaded: false, queue: new Map(), timer: null, authWait: 0 };
// B08: saraksts (radar_list) — bez konta; paziņošana (radar_report) un „nav radara” (radar_bad) — tikai ar kontu
// (serveris skaita vienu balsi no konta un limitē stundā). Ja konta vēl nav — izveido anonīmo neredzami (tikai ar
// piekrišanu noteikumiem; CAPTCHA bez loga — braucot logs netiek rādīts). Ja neizdodas — 10 min pauze, tad mēģina vēlreiz.
async function radarToken() {
  if (Date.now() < radarShared.authWait) throw Object.assign(new Error('radar_auth_wait'), { code: 'radar_auth_wait' });
  const a = typeof czAuthGet === 'function' ? czAuthGet() : null;
  if (!a) throw Object.assign(new Error('nav servera'), { code: 'no_server' });
  try {
    const t = await a.token({ create: true, interactive: false });
    if (!t) throw Object.assign(new Error('network'), { code: 'network' });
    return t;
  } catch (e) { radarShared.authWait = Date.now() + 10 * 60000; throw e; }
}
async function radarRpc(name, body, { account = false } = {}) {
  const cfg = typeof RIDES_CONFIG !== 'undefined' ? RIDES_CONFIG : null;
  if (!cfg || !cfg.url || !cfg.anonKey) throw new Error('nav servera');
  const headers = { apikey: cfg.anonKey, 'content-type': 'application/json' };
  if (account) headers.Authorization = 'Bearer ' + await radarToken();
  const r = await fetch(cfg.url.replace(/\/$/, '') + '/rest/v1/rpc/' + name, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
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
  if (bad.length && czConsentOk()) radarRpc('radar_bad', { ids: bad.slice(0, 50) }, { account: true }).catch(() => {});
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
    await radarRpc('radar_report', { items }, { account: true });
    const m = radarMemGet();
    for (const it of items) { radarShared.ids.add(it.id); if (m[it.id]) m[it.id][4] = Date.now(); }
    radarMemSave();
  } catch (e) {
    if (e && e.code === 'radar_auth_wait') { items.forEach(it => radarShared.queue.set(it.id, it)); radarShared.timer = setTimeout(radarFlush, 10 * 60000); return; }
    console.warn('Radaru paziņošana neizdevās', e && (e.code || e.message));
  }
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
      state.mlyFailed = true;                                       // A13: loadMapillaryForView mēģinās ar pauzi
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
  state.mlyFailed = false;
  try { added = await loadMlyTiles(tiles); }
  finally {
    mlyLoading = false;
    setBusy('mly', null);
  }
  if (added) { dirCenter = null; loadDirectionsNearMe(); }
  // A13: ja kāda flīze neielādējās — atkārto ar pieaugošu pauzi (5 s … 2 min), nevis ik 100 ms (agrāk — desmitiem
  // pieprasījumu sekundē, kamēr serveris nepieejams)
  state.mlyRetryMs = state.mlyFailed ? Math.min(120000, (state.mlyRetryMs || 2500) * 2) : 0;
  setTimeout(loadMapillaryForView, state.mlyRetryMs || 100);
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
  const first0 = !state.me;
  // v124: distance driven (for "max one confirmation prompt per ~1 km"); GPS jumps > 500 m are not counted
  if (state.me && (accuracy == null || accuracy < 60)) {
    const step = distM(state.me.lat, state.me.lng, lat, lng);
    if (step < 500) reportsState.odo += step;
  }
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
  // v134: arrow not snapped (weak GPS / slightly off) but still near the route → move the cut to it anyway,
  // so the bright line never sticks out behind the arrow; the driven part turns faint.
  if (!onRoute && state.nav.active && state.nav.route) {
    const loc = locateOnRoute(state.nav.route, lat, lng);
    if (loc.off <= ROUTE_CUT_M) {
      state.nav.target = smoothProgress(state.nav.target, loc.along);
      state.nav.shown = state.nav.target;
      drawRoute(state.nav.route, state.nav.target);
    }
  }
  if (first0) syncRecenter();
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
  if (typeof presenceOnFix === 'function') presenceOnFix(lat, lng, speedKmh, state.heading, accuracy);   // v124: tavs tēls citiem (presence.js)
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
  syncBottombar();
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
  syncBottombar();
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
// v146: inside the Android app (Capacitor shell, folder mobile/) the position comes from the phone itself
// (plugin BackgroundGeolocation) — it keeps working with the screen off; a notification shows while it runs.
// In a normal browser window.Capacitor does not exist and nothing here changes.
// A14: the app loads the live site (server.url), which does not bundle @capacitor/core — there window.Capacitor has no
// registerPlugin, only Capacitor.Plugins.<name> injected by the native shell. Use whichever exists.
function nativeGeo() {
  const C = typeof window !== 'undefined' ? window.Capacitor : null;
  if (!C || typeof C.isNativePlatform !== 'function' || !C.isNativePlatform()) return null;
  if (nativeGeo._p) return nativeGeo._p;
  const p = typeof C.registerPlugin === 'function' ? C.registerPlugin('BackgroundGeolocation')
    : (C.Plugins && C.Plugins.BackgroundGeolocation) || null;
  return p ? (nativeGeo._p = p) : null;
}
let nativeWatchId = null;
function nativeLocToPos(loc) {
  return { coords: { latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy, speed: loc.speed,
    heading: loc.bearing, altitude: loc.altitude }, timestamp: loc.time || Date.now() };
}
function startNativeGps(BG, onDenied) {
  if (nativeWatchId != null) { const old = nativeWatchId; nativeWatchId = null; Promise.resolve().then(() => BG.removeWatcher({ id: old })).catch(() => {}); }
  // Capacitor.Plugins.* returns the watcher id directly, registerPlugin — a Promise; Promise.resolve handles both
  Promise.resolve().then(() => BG.addWatcher({
    backgroundTitle: 'Ceļa Zīmes',
    backgroundMessage: 'Navigācija un brīdinājumi darbojas arī ar izslēgtu ekrānu.',
    requestPermissions: true, stale: false, distanceFilter: 0,
  }, (loc, err) => {
    if (err) {
      if (err.code === 'NOT_AUTHORIZED') { gpsShow('denied'); if (onDenied) onDenied(); }
      else onGpsError({ code: 2 });
      return;
    }
    if (loc) onPosition(nativeLocToPos(loc));
  })).then(id => { nativeWatchId = id; }).catch(() => onGpsError({ code: 2 }));
}
// onDenied — izsauc, ja atļauja joprojām liegta (poga „Mēģināt vēlreiz”)
function startGps(onDenied) {
  const BG = nativeGeo();
  if (BG) return startNativeGps(BG, onDenied);
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
  const url = `${CZ_SERVICES.photon}/api/?q=${encodeURIComponent(q)}&limit=7&lat=${c.lat.toFixed(2)}&lon=${c.lng.toFixed(2)}&lang=${PHOTON_LANG}`;
  // Tas pats teksts ~1 km apkārtnē — no kešatmiņas (1 diena); 'photon-lv' — vecie angliskie rezultāti netiek ņemti
  const json = await cachedJson('photon-lv', q.toLowerCase() + '@' + c.lat.toFixed(2) + ',' + c.lng.toFixed(2), 24 * 3600 * 1000,
    () => fetchJson(url, {}, 7000));
  return (json.features || []).map(photonSearchItem);
}
async function searchNominatim(q) {
  const url = CZ_SERVICES.nominatim + '/search?format=jsonv2&limit=6&accept-language=lv&q=' + encodeURIComponent(q);
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
  catch {
    // A13: Nominatim noteikumi aizliedz meklēšanu rakstīšanas laikā (autocomplete) — rezerve tikai, nospiežot „Meklēt”
    if (enter) { try { items = await searchNominatim(q); } catch { items = []; } }
  }
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
  // v134: driven part stays as a faint line that blends with the road (not bright, not gone)
  map.addSource('route-done', { type: 'geojson', data: EMPTY_FC });
  map.addLayer({ id: 'route-done-line', type: 'line', source: 'route-done',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#5a8fd6', 'line-opacity': 0.22, 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, 3, 15, 7, 18, 18] } });
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
  const done = map.getSource('route-done'), dc = route ? routeDone(route, along) : [];
  if (done) done.setData(dc.length ? { type: 'Feature', geometry: { type: 'LineString', coordinates: dc }, properties: {} } : EMPTY_FC);
}

// ---------- Bulta uz maršruta; nobrauktā daļa pazūd aiz tās ----------
// Navigācijā bultu novieto uz maršruta (kartes piesaiste maršrutam) un kopā ar to
// vienmērīgi (pa maršruta līkumiem) pārvieto līnijas sākumu. GPS svārstības atpakaļ
// neņem vērā (smoothProgress), tāpēc līnija nelēkā un nobrauktā daļa neatgriežas.
const ROUTE_CUT_M = 70;      // v134: cut the line at the arrow's projection up to this far from the route
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
    syncRecenter();
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
  $('streetName').textContent = '—';
  state.follow = true;
  syncRecenter();
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
  $('statusBox').hidden = false;
  $('etaBox').hidden = true;
  $('endNav').hidden = true;
  syncBottombar();
  $('searchInput').value = '';
  $('clearSearch').hidden = true;
  showCounts();
  map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 800 });
}

// v122: iela, pa kuru brauc (maršruta pašreizējais posms); bez nosaukuma — ceļa numurs vai „Ceļš bez nosaukuma”
function navStreetName(st) {
  const n = st && (st.name || st.ref) || (typeof roadNameAt === 'function' ? roadNameAt() : '');
  return n ? String(n).split(';')[0].trim() : 'Ceļš bez nosaukuma';
}
// Maršruta posmam nav nosaukuma (pievedceļš) — iela no kartes zem manis (OpenMapTiles transportation_name)
function roadNameAt() {
  try {
    if (!map || !state.me || !state.vector) return '';
    const p = map.project([state.me.lng, state.me.lat]);
    const fs = map.queryRenderedFeatures([[p.x - 16, p.y - 16], [p.x + 16, p.y + 16]])
      .filter(f => f.sourceLayer === 'transportation_name' && f.properties && (f.properties['name:lv'] || f.properties.name));
    return fs.length ? (fs[0].properties['name:lv'] || fs[0].properties.name) : '';
  } catch { return ''; }
}
// v122: karte pabīdīta navigācijā → apakšā „Centrēt” + atlikušais laiks un attālums (kā Waze)
function syncRecenter() {
  const btn = document.getElementById('recenterBtn');
  if (!btn) return;
  const nav = !!(state.nav && state.nav.active), moved = nav && !state.follow;
  btn.hidden = !moved;
  $('streetBox').hidden = !nav || moved;
  $('etaBox').hidden = !nav || moved;
  // v123: bez navigācijas — poga „Centrēt” apakšā, kad karte aizvilkta prom (poga „Es” vairs nav)
  const pill = document.getElementById('recenterPill');
  if (pill) pill.hidden = nav || state.follow || !state.me || document.documentElement.classList.contains('previewing');
}
// v123: apakšējā josla bez navigācijas — tikai, ja ar atrašanās vietu ir problēma (ar „Kā ieslēgt?”); ziņu par strādājošu GPS vairs nerāda
function syncBottombar() {
  const bar = document.getElementById('bottombar');
  if (!bar) return;
  const previewing = document.documentElement.classList.contains('previewing');
  bar.hidden = previewing || !(state.nav && state.nav.active) && !gpsProblem;
  syncRecenter();
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
  state.nav.toNext = p.toNext;                     // v124: no confirmation prompt right before a turn
  $('navInstr').textContent = maneuverText(p.next);
  $('etaTime').textContent = clockIn(p.timeLeft);
  $('etaMeta').textContent = `${navTime(p.timeLeft)} · ${navDist(p.remaining)}`;
  $('recenterMeta').textContent = $('etaMeta').textContent;
  $('streetName').textContent = navStreetName(p.cur);
  const goodFix = state.gpsQuality !== 'poor';    // vājš GPS — progresu un nobraukšanu nevērtē
  if (goodFix && p.loc.off < 50) {
    state.nav.along = p.loc.along;
    signs.setRouteProgress(p.loc.along);
  }
  updateNextSign();
  // Nobrauci no maršruta (v127): tālāk par GPS kļūdu vai brauc citā virzienā blakus ielā → pēc diviem
  // mērījumiem pēc kārtas maršrutu pārrēķina no tavas vietas līdz galamērķim (ne biežāk kā reizi 8 s).
  const rb = routeBearingAt(route, p.loc);
  const hd = state.heading != null && rb != null ? angleDiff(state.heading, rb) : null;
  if (isOffRoute(p.loc.off, state.me.accuracy, hd, state.me.speedKmh)) state.nav.offCount++; else state.nav.offCount = 0;
  if (state.nav.offCount >= 2 && !state.nav.rerouting && Date.now() - state.nav.lastReroute > REROUTE_GAP_MS) reroute();
}
const REROUTE_GAP_MS = 8000;

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
  state.nav.rerouting = true;
  setBusy('route', 'Pārrēķina maršrutu…');
  try {
    // v127: no tavas vietas uz priekšu (ar braukšanas virzienu), nevis atpakaļ uz pamesto ceļu; bez kešatmiņas
    const moving = state.heading != null && (state.me.speedKmh ?? 0) >= 5;
    const route = await requestRoute(state.me, state.nav.dest, { bearing: moving ? state.heading : null });
    if (!state.nav.active) return;                       // navigācija pa to laiku beigta
    state.nav.route = route;
    state.nav.along = null;
    resetNavProgress();              // jauns maršruts sākas no manis — līnija no jauna
    drawRoute(route);
    signs.setRoute(route);
    prepareRoute(route);
    czToast('Maršruts pārrēķināts no tavas vietas.');
  } catch (err) {
    console.warn('Pārrēķins neizdevās', err);
    state.nav.lastReroute = Date.now() - REROUTE_GAP_MS + 4000;   // nav interneta u.c. — mēģina vēlreiz pēc ~4 s
  } finally { state.nav.rerouting = false; setBusy('route', null); }
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

// ---------- Laikapstākļi (Open-Meteo; adrese — services.js) ----------
const WEATHER_FIELDS = 'temperature_2m,precipitation,rain,showers,snowfall,weather_code,wind_gusts_10m,visibility';
let weatherAt = null, weatherTime = 0;
async function loadWeather(force) {
  if (!state.me) return;
  const moved = !weatherAt || distM(weatherAt[0], weatherAt[1], state.me.lat, state.me.lng) > 15000;
  if (!force && !moved && Date.now() - weatherTime < 10 * 60000) return;
  weatherAt = [state.me.lat, state.me.lng]; weatherTime = Date.now();
  try {
    const url = CZ_SERVICES.weather + '?latitude=' + state.me.lat.toFixed(3) + '&longitude=' + state.me.lng.toFixed(3) +
      '&current=' + WEATHER_FIELDS + '&wind_speed_unit=ms&timezone=auto';
    // B04: komerciāli — mūsu Supabase funkcija „weather” (Open-Meteo atslēga serverī); tai vajag publisko anon atslēgu
    const opts = czServiceIsOwn(url) ? { headers: { apikey: RIDES_CONFIG.anonKey, Authorization: 'Bearer ' + RIDES_CONFIG.anonKey } } : {};
    // ~1 km apkārtnē 10 min derīgs (arī pēc lapas pārlādes)
    const j = await cachedJson('wx', state.me.lat.toFixed(2) + ',' + state.me.lng.toFixed(2), 10 * 60000, () => fetchJson(url, opts, 8000));
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
    // v145 (owner): traffic restrictions are NOT drawn on the map — only the "next ahead" card (distance) shows them
    signs.hideOnMap = s => alertTypeForSign(s) === 'restriction';
    signs.onPinsShown = onSignPinsShown;
  } else {
    signs.setFilter(s => state.cats[s.cat] && signFitsProfile(s, state.profile));
    signs.iconFor = null;
    signs.titleFor = null;
    signs.dotFor = null;
    signs.hideOnMap = null;
    signs.onPinsShown = null;
  }
  signs.refresh();
  refreshAlerts();
  // v132: the ⋯ / „Zīmes” button is gone — the master switch lives in settings only.
  // Red dot on the settings button while warnings/signs are off.
  const setBtn = $('settingsBtn');
  if (setBtn) setBtn.classList.toggle('dot', !state.signsOn);
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

// v126: segmented control for a short <select>: one button per option, kept in sync both ways.
function segmentize(select) {
  if (!select || select.dataset.seg) return;
  select.dataset.seg = '1';
  const box = document.createElement('div');
  box.className = 'set-seg'; box.setAttribute('role', 'radiogroup');
  const lab = select.labels && select.labels[0];
  if (lab) box.setAttribute('aria-label', lab.textContent.trim());
  const sync = () => box.querySelectorAll('button').forEach(b => {
    const on = b.dataset.v === select.value;
    b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on));
  });
  for (const o of select.options) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.v = o.value; b.textContent = o.textContent; b.setAttribute('role', 'radio');
    b.addEventListener('click', () => {
      if (select.value === o.value) return;
      select.value = o.value; select.dispatchEvent(new Event('change', { bubbles: true })); sync();
    });
    box.appendChild(b);
  }
  select.addEventListener('change', sync);
  select.classList.add('seg-hidden'); select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
  select.after(box);
  sync();
}

function toggleSettings(open) {
  const el = $('settings');
  el.hidden = !open;
  el.style.transform = '';
  $('settingsBtn').setAttribute('aria-expanded', String(open));
}
// v131: iestatījumu panelis kā „bottom sheet” — aizveras ar Esc vai velkot aiz roktura / virsraksta uz leju (> 90 px)
function wireSettingsSheet() {
  const el = $('settings');
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !el.hidden) toggleSettings(false); });
  let y0 = null, dy = 0;
  const start = e => {
    if (e.target.closest('button, a, input, select')) return;
    if (el.scrollTop > 0 && !e.target.closest('.set-grab')) return;     // ritinot saturu — nevelk paneli
    y0 = e.clientY; dy = 0; el.style.transition = 'none';
  };
  const move = e => {
    if (y0 == null) return;
    dy = Math.max(0, e.clientY - y0);
    el.style.transform = dy ? `translateY(${dy}px)` : '';
  };
  const end = () => {
    if (y0 == null) return;
    y0 = null; el.style.transition = '';
    if (dy > 90) toggleSettings(false); else el.style.transform = '';
  };
  for (const h of [el.querySelector('.set-grab'), el.querySelector('.sheet-head')]) if (h) h.addEventListener('pointerdown', start);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

async function applyBasemap(choice) {
  const bm = await loadBasemapStyle(choice);
  state.vector = bm.vector;
  setAlertTheme(bm.theme === 'dark' ? 'dark' : 'light');   // v121: zīmes T1 (tumšā) / G1 (gaišā); attēli pārlādējas pēc setStyle
  map.setStyle(bm.style, { diff: false });
}

function wireUi() {
  wireArrowColors();
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
  $('recenterBtn').addEventListener('click', () => { state.follow = true; if (state.me) followCamera(800); });   // v122
  $('recenterPill').addEventListener('click', () => { state.follow = true; if (state.me) followCamera(800); });  // v123
  $('gpsHelpBtn').addEventListener('click', openGpsHelp);       // F2
  $('closeGpsHelp').addEventListener('click', () => { $('gpsSheet').hidden = true; });
  $('gpsRetry').addEventListener('click', gpsRetry);
  $('settingsBtn').addEventListener('click', () => { if ($('settings').hidden) closePlaces(); toggleSettings($('settings').hidden); });
  $('closeSettings').addEventListener('click', () => toggleSettings(false));
  wireSettingsSheet();

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
  store.set('basemap', state.basemap);      // agrākā izvēle (auto / krāsaina / klasiskā) saglabājas kā tumšā vai gaišā
  sel.addEventListener('change', () => { state.basemap = sel.value; store.set('basemap', state.basemap); applyBasemap(state.basemap); });
  // v126: in settings, short choices are shown as segmented buttons (the <select> stays for state and accessibility)
  segmentize(sel); segmentize($('markerAnim'));

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
  document.documentElement.classList.remove('previewing');
  syncBottombar();
  // F5: lauks kā pirms meklēšanas (vērtības iestatīšana „input” notikumu neizraisa — jauna meklēšana nesākas)
  clearTimeout(searchTimer); searchSeq++; lastResults = [];
  $('searchInput').value = ''; $('clearSearch').hidden = true; $('results').hidden = true;
}

// ---------- Starts ----------
async function init() {
  setTimeout(() => cachePrune(), 20000);   // izmet > 7 dienas vecus kešatmiņas ierakstus
  const bm = await loadBasemapStyle(state.basemap);
  state.vector = bm.vector;
  setAlertTheme(bm.theme === 'dark' ? 'dark' : 'light');
  // A07: MapLibre 6 — ES modulis (A10: no vendor/, maplibre-load.js); WebGL2 obligāts. Ja karti nevar izveidot, skaidra ziņa, nevis tukšs ekrāns.
  if (typeof maplibregl === 'undefined' || !maplibregl.Map) {
    setStatus('Neizdevās ielādēt karti — pārbaudi internetu un atjauno lapu.', true);
    return;
  }
  try {
    map = new maplibregl.Map({
      container: 'map', style: bm.style,
      center: [START[1], START[0]], zoom: 15,
      maxPitch: 65, fadeDuration: 250, renderWorldCopies: false,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      attributionControl: { compact: true },
      // A07: MapLibre 6 noklusējums (4) zoomā virs flīžu maxzoom sadala flīzes, un querySourceFeatures dod citādus ceļu
      // gabalus (roads-gl.js ceļu indekss). undefined — kā MapLibre 4: virs maxzoom tikai palielina.
      zoomLevelsToOverscale: undefined,
    });
  } catch (e) {
    console.error(e);
    map = null;
    setStatus(/webgl/i.test(String(e && e.message))
      ? 'Šajā pārlūkā karte nevar parādīties (vajag WebGL2). Atjauno pārlūku vai ieslēdz aparatūras paātrinājumu.'
      : 'Neizdevās atvērt karti — atjauno lapu.', true);
    return;
  }
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
  if (typeof garageInit === 'function') garageInit();        // v124: Garāža (garage.js)
  if (typeof presenceInit === 'function') presenceInit();    // v124: citi braucēji ar tēliem (presence.js)
  setInterval(() => { signs.refresh(); updateLimit(); }, 60000); // laika ierobežojumi mainās

  map.on('style.load', () => {
    installRouteLayers();
    signs.install();
    installAlertLayer();
    installRadarLayer();
    installPulseLayer();
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
  // Trūkstošs zīmes / brīdinājuma attēls → uzzīmē to. A07: MapLibre 6 — setMissingStyleImageResolver (karte sagaida
  // attēlu, pirms to uzskata par trūkstošu); vecākā versijā — styleimagemissing notikums (tā pati funkcija).
  const resolveImage = id => {
    if (/^alert:/.test(id)) { signs.iconUrl.set(id, alertDataUrl(id.slice(6))); return signs.loadImage(id); }
    if (/^(mly|own):/.test(id)) return signs.loadImage(id);
  };
  if (typeof map.setMissingStyleImageResolver === 'function') map.setMissingStyleImageResolver(resolveImage);
  else map.on('styleimagemissing', e => { resolveImage(e.id); });
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
  if (typeof czLazyStart === 'function') czLazyStart();   // B15: „Kopā”, stāvēšana, Garāža — tagad (lazy.js)
}

// B16: init() izsauc app-start.js (pēc app-osm-gl.js, app-alerts-gl.js, app-reports-gl.js, app-places-gl.js).
