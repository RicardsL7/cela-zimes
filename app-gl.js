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
  hideOpposite: store.get('hideOpposite', false),
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
  nav: { dest: null, route: null, active: false, offCount: 0, lastReroute: 0 },
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
const busy = new Map();
function setBusy(key, text) {
  if (text) busy.set(key, text); else busy.delete(key);
  $('loader').classList.toggle('show', busy.size > 0);
  if (busy.size) $('loaderText').textContent = [...busy.values()].pop();
}

// ---------- Zīmes ----------
// Vienas un tās pašas zīmes neliek divreiz (piem. no OSM un Mapillary).
const placedGrid = new Map();
function isDuplicate(lat, lng, cat) {
  const gx = Math.round(lat / 0.0003), gy = Math.round(lng / 0.0005);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    for (const p of placedGrid.get((gx + i) + ':' + (gy + j)) || []) {
      if (p.cat === cat && distM(p.lat, p.lng, lat, lng) < 20) return true;
    }
  }
  const k = gx + ':' + gy;
  if (!placedGrid.has(k)) placedGrid.set(k, []);
  placedGrid.get(k).push({ lat, lng, cat });
  return false;
}

// sign: { cat, kind?, value?, title }; mlyValue: Mapillary zīmes kods (ja no Mapillary)
function addSign(lat, lng, sign, mlyValue) {
  if (isDuplicate(lat, lng, sign.cat)) return null;
  const own = sign.kind ? sign : { kind: 'other' };
  const s = mlyValue
    ? { icon: 'mly:' + mlyValue, src: MLY_ICON_URL + encodeURIComponent(mlyValue) + '.svg', value: mlyValue }
    : { icon: 'own:' + own.kind + ':' + (own.value || ''), src: svgDataUrl(own) };
  Object.assign(s, { lat, lng, cat: sign.cat, title: sign.title, face: null });
  signs.add(s);
  return s;
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
);
out tags geom;`;
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
  setBusy('osm', 'Ielādē ceļa zīmes…');
  try {
    const data = await fetchOverpass(buildQuery(s.toFixed(4), w.toFixed(4), n.toFixed(4), e.toFixed(4)));
    let added = 0;
    for (const el of data.elements || []) {
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
        indexWay(limit, pts);
        added += addWaySpeedSign(pts, limit);
      }
    }
    missing.forEach(c => state.loadedCells.add(c));
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
function indexWay(limit, pts) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const la0 = Math.floor(Math.min(a[0], b[0]) / WAY_CELL), la1 = Math.floor(Math.max(a[0], b[0]) / WAY_CELL);
    const lo0 = Math.floor(Math.min(a[1], b[1]) / WAY_CELL), lo1 = Math.floor(Math.max(a[1], b[1]) / WAY_CELL);
    for (let la = la0; la <= la1; la++) for (let lo = lo0; lo <= lo1; lo++) {
      const k = la + ':' + lo;
      if (!wayGrid.has(k)) wayGrid.set(k, []);
      wayGrid.get(k).push([a, b, limit]);
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
function nearestLimit(lat, lng) {
  let best = null, bestD = 30;
  const la = Math.floor(lat / WAY_CELL), lo = Math.floor(lng / WAY_CELL);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    for (const [a, b, limit] of wayGrid.get((la + i) + ':' + (lo + j)) || []) {
      const d = distToSegment([lat, lng], a, b);
      if (d < bestD) { bestD = d; best = limit; }
    }
  }
  return best;
}
function updateLimit() {
  const badge = $('limitBadge');
  if (!state.me) { badge.hidden = true; return; }
  const limit = nearestLimit(state.me.lat, state.me.lng);
  badge.hidden = limit == null;
  if (limit != null) $('limitValue').textContent = limit;
  const over = state.warn && limit != null && state.me.speedKmh != null && state.me.speedKmh > limit + 3;
  $('speedBox').classList.toggle('over', over);
  badge.classList.toggle('pulse', over);
}

// ---------- Mapillary zīmes ----------
let mlyLoading = false;
async function loadMapillaryForView() {
  if (!state.mlyToken || mlyLoading || map.getZoom() < MIN_SIGN_ZOOM) return;
  const [s, w, n, e] = viewBox(0.2);
  const tiles = tilesForBounds(s, w, n, e).filter(([x, y]) => !state.mlyTiles.has(x + ':' + y));
  if (!tiles.length || tiles.length > 16) return;
  mlyLoading = true;
  setBusy('mly', 'Ielādē zīmes…');
  let added = 0;
  try {
    const results = await Promise.allSettled(tiles.map(([x, y]) => fetchMapillaryTile(x, y, state.mlyToken)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        if (r.reason && r.reason.badToken) { setStatus('Mapillary atslēga nav derīga. Pārbaudi to iestatījumos.'); state.mlyToken = ''; }
        return;
      }
      state.mlyTiles.add(tiles[i][0] + ':' + tiles[i][1]);
      for (const z of r.value) {
        if (!isPlausibleSign(z.value, z.lat, z.lng)) continue; // acīmredzamas atpazīšanas kļūdas
        if (addSign(z.lat, z.lng, classifyMapillary(z.value), z.value)) added++;
      }
    });
    state.counts.mly += added;
    signs.refresh();
    showCounts();
  } finally {
    mlyLoading = false;
    setBusy('mly', null);
  }
  if (added) { dirCenter = null; loadDirectionsNearMe(); }
  setTimeout(loadMapillaryForView, 100);
}

// Zīmju virzieni ~300 m ap braucēju (API ir lēns, tāpēc ne visai kartei).
let dirCenter = null, dirLoading = false;
async function loadDirectionsNearMe() {
  if (!state.mlyToken || !state.me || dirLoading) return;
  const { lat, lng } = state.me;
  if (dirCenter && distM(dirCenter[0], dirCenter[1], lat, lng) < 150) return;
  dirLoading = true;
  dirCenter = [lat, lng];
  try {
    const dLat = 0.003, dLng = 0.003 / Math.cos(lat * Math.PI / 180);
    const counts = new Map();
    signs.eachInBox(lat - dLat, lng - dLng, lat + dLat, lng + dLng, s => {
      if (s.value && s.face == null) counts.set(s.value, (counts.get(s.value) || 0) + 1);
    });
    if (!counts.size) return;
    setBusy('dir', 'Nosaka zīmju virzienus…');
    const found = await fetchMapillaryDirectionsArea(lng - dLng, lat - dLat, lng + dLng, lat + dLat, state.mlyToken, counts);
    let matched = 0;
    for (const f of found) {
      const s = signs.findNear(f.lat, f.lng, 5, x => x.value === f.value);
      if (s) { s.face = MLY_DIR_IS_FACE ? f.dir : (f.dir + 180) % 360; matched++; }
    }
    if (matched) signs.refresh();
  } catch (err) {
    console.warn('Virzieni nav ielādēti', err);
    dirCenter = null;
  } finally {
    dirLoading = false;
    setBusy('dir', null);
  }
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
function onFix(lat, lng, speedKmh, gpsHeading, dur = 900) {
  state.me = { lat, lng, speedKmh };
  moveMeMarker(lng, lat, state.follow ? dur : 300);
  $('speedValue').textContent = speedKmh == null ? '–' : Math.round(speedKmh);
  updateHeading(lat, lng, gpsHeading, speedKmh);
  updateLimit();
  loadDirectionsNearMe();
  if (state.nav.active) updateNav();
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
  onFix(pos.coords.latitude, pos.coords.longitude, sp == null || sp < 0 ? null : sp * 3.6, pos.coords.heading, first ? 0 : 900);
  if (first) { map.jumpTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: Math.max(map.getZoom(), 15.5) }); loadAllForView(); }
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

async function previewRoute() {
  const dest = state.nav.dest;
  if (!dest) return;
  const from = state.me || { lat: map.getCenter().lat, lng: map.getCenter().lng };
  setBusy('route', 'Meklē maršrutu…');
  try {
    const route = await requestRoute(from, dest);
    state.nav.route = route;
    drawRoute(route);
    state.follow = false;
    const lngs = route.coords.map(c => c[0]), lats = route.coords.map(c => c[1]);
    map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: { top: 110, bottom: 280, left: 40, right: 90 }, pitch: 0, bearing: 0, duration: 900 });
    $('routeDest').textContent = dest.name;
    $('routeSub').textContent = dest.sub || '';
    $('routeTime').textContent = navTime(route.duration);
    $('routeMeta').textContent = `${navDist(route.distance)} · ieradīsies ${clockIn(route.duration)}`;
    $('routeCard').hidden = false;
    $('bottombar').hidden = true;
    if (!state.me) setStatus('Maršruts no kartes centra, jo atrašanās vieta nav zināma.');
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
  $('routeCard').hidden = true;
  $('bottombar').hidden = false;
  $('navBanner').hidden = false;
  $('statusBox').hidden = true;
  $('etaBox').hidden = false;
  $('endNav').hidden = false;
  state.follow = true;
  if (state.testMode) startSimulation();
  else if (state.me) { updateNav(); followCamera(1200); }
}

function endNav() {
  stopSimulation();
  state.nav = { dest: null, route: null, active: false, offCount: 0, lastReroute: 0 };
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
  // Nobrauci no maršruta: pēc diviem mērījumiem pārrēķina (ne biežāk kā reizi 15 s).
  if (p.loc.off > 50) state.nav.offCount++; else state.nav.offCount = 0;
  if (state.nav.offCount >= 2 && Date.now() - state.nav.lastReroute > 15000) reroute();
}

async function reroute() {
  state.nav.lastReroute = Date.now();
  state.nav.offCount = 0;
  setBusy('route', 'Pārrēķina maršrutu…');
  try {
    const route = await requestRoute(state.me, state.nav.dest);
    state.nav.route = route;
    drawRoute(route);
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
  signs.setFilter(cat => state.cats[cat]);
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
  $('warnSwitch').checked = state.warn;
  $('warnSwitch').addEventListener('change', e => { state.warn = e.target.checked; store.set('warn', state.warn); updateLimit(); });
  $('testSwitch').addEventListener('change', e => {
    state.testMode = e.target.checked;
    if (!state.testMode) stopSimulation();
    else if (state.nav.active) startSimulation();
    setStatus(state.testMode ? 'Testa režīms: noklikšķini uz ceļa kartē vai sāc maršrutu — tas tiks nobraukts automātiski.' : 'Testa režīms izslēgts.');
  });
  $('oppSwitch').checked = state.hideOpposite;
  $('oppSwitch').addEventListener('change', e => {
    state.hideOpposite = e.target.checked; store.set('hideOpposite', state.hideOpposite); signs.setHideOpposite(state.hideOpposite);
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
  drawRoute(null);
  if (destMarker) { destMarker.remove(); destMarker = null; }
  $('routeCard').hidden = true;
  $('bottombar').hidden = false;
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

  map.on('style.load', () => {
    installRouteLayers();
    signs.install();
    roadIndex.ready = false; roadIndex.coverage = null;
    signs.setRoads(state.vector ? roadIndex : null);
    if (state.nav.route) drawRoute(state.nav.route);
    applySignVisibility();
  });
  // Ceļi zīmju piesaistei: pārbūvē, kad karte ielādējusi jaunu apgabalu.
  let lastRoadKey = '';
  map.on('idle', () => {
    if (!state.vector) return;
    const b = map.getBounds(), key = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast(), map.getZoom()].map(v => v.toFixed(4)).join();
    if (key === lastRoadKey) return;
    lastRoadKey = key;
    if (roadIndex.rebuild(map)) signs.refresh();
  });
  map.on('styleimagemissing', e => { if (/^(mly|own):/.test(e.id)) signs.loadImage(e.id); });
  map.on('moveend', () => { signs.refresh(); clearTimeout(init._t); init._t = setTimeout(loadAllForView, 400); });
  for (const ev of ['dragstart', 'rotatestart', 'pitchstart']) {
    map.on(ev, e => { if (e.originalEvent) state.follow = false; });
  }
  map.on('click', 'signs', e => {
    const f = e.features && e.features[0];
    if (!f) return;
    new maplibregl.Popup({ closeButton: false, offset: 18, maxWidth: '260px' })
      .setLngLat(f.geometry.coordinates).setText(f.properties.title).addTo(map);
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
  startGps();
  map.once('load', loadAllForView);
}

init();
