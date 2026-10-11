// Ceļa Zīmes — galvenā lietotnes loģika.
// Karte: Leaflet + CARTO. Zīmes: OpenStreetMap caur Overpass API.
// Meklēšana: Nominatim. Maršruts: OSRM.

// Vairāki bezmaksas serveri: jautājam visiem reizē un ņemam ātrāko atbildi,
// jo kāds no tiem bieži ir pārslogots.
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const MIN_SIGN_ZOOM = 15;       // zīmes ielādē tikai pietuvinot
const CELL = 0.01;              // ielādes režģa šūna grādos (~1 km)
const MAX_CELLS = 24;           // vairāk šūnu vienā reizē neielādē
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
  testMode: false,
  follow: true,
  me: null,            // { lat, lng, speedKmh }
  ways: new Map(),     // id -> { limit, pts: [[lat,lng],...] }
  seenNodes: new Set(),
  loadedCells: new Set(),
  loading: false,
  osmRetryMs: 0,       // pauze pirms nākamā mēģinājuma, ja serveri neatbild
  mlyToken: store.get('mlyToken', ''),
  mlyTiles: new Set(),
  counts: { osm: 0, mly: 0 },
  heading: null,       // braukšanas virziens grādos (0 = ziemeļi), ja zināms
  hideOpposite: store.get('hideOpposite', false),
};

// ---------- Karte ----------
// Pamatne (krāsaina vektoru karte vai klasiskā) nāk no basemap.js.
const map = L.map('map', { zoomControl: false, attributionControl: true, maxZoom: 19 }).setView(START, 16);
state.basemap = store.get('basemap', 'auto');
setBasemap(map, state.basemap);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (state.basemap === 'auto') setBasemap(map, 'auto');
});

// Visas zīmes vienā ātrā canvas slānī (signlayer.js).
const signLayer = new SignCanvasLayer();

function applyLayerVisibility() {
  if (state.signsOn && !map.hasLayer(signLayer)) signLayer.addTo(map);
  if (!state.signsOn && map.hasLayer(signLayer)) map.removeLayer(signLayer);
  signLayer.setFilter(cat => state.cats[cat]);
  const btn = document.getElementById('toggleSigns');
  btn.setAttribute('aria-pressed', String(state.signsOn));
  btn.classList.toggle('off', !state.signsOn);
  document.getElementById('toggleSignsLabel').textContent = state.signsOn ? 'Zīmes' : 'Izslēgtas';
  document.getElementById('masterSwitch').checked = state.signsOn;
  document.getElementById('catList').classList.toggle('disabled', !state.signsOn);
}

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

// src: attēla adrese (Mapillary zīmei); citādi izmanto mūsu SVG ikonu.
function addSignMarker(lat, lng, sign, src) {
  if (isDuplicate(lat, lng, sign.cat)) return false;
  const own = svgDataUrl(sign.kind ? sign : { kind: 'other' });
  const s = { lat, lng, cat: sign.cat, title: sign.title, src: src || own, fallback: svgDataUrl({ kind: 'other' }), face: null };
  signLayer.add(s);
  return s;
}

// ---------- Datu ielāde no OpenStreetMap ----------
function cellsForBounds(b) {
  const cells = [];
  for (let la = Math.floor(b.getSouth() / CELL); la <= Math.floor(b.getNorth() / CELL); la++) {
    for (let lo = Math.floor(b.getWest() / CELL); lo <= Math.floor(b.getEast() / CELL); lo++) {
      cells.push(la + ':' + lo);
    }
  }
  return cells;
}

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
    controllers.forEach((c, j) => { if (j !== i) c.abort(); }); // pārējos vairs nevajag
    return json;
  });
  return Promise.any(attempts);
}

async function loadSignsForView() {
  if (state.loading) return;
  if (map.getZoom() < MIN_SIGN_ZOOM) {
    setStatus('Pietuvini karti, lai redzētu ceļa zīmes.');
    return;
  }
  const missing = cellsForBounds(map.getBounds().pad(0.2)).filter(c => !state.loadedCells.has(c));
  if (!missing.length) return;
  if (missing.length > MAX_CELLS) { setStatus('Pietuvini karti, lai redzētu ceļa zīmes.'); return; }

  // Ielādē vienu taisnstūri, kas aptver visas trūkstošās šūnas.
  const las = missing.map(c => +c.split(':')[0]), los = missing.map(c => +c.split(':')[1]);
  const s = Math.min(...las) * CELL, n = (Math.max(...las) + 1) * CELL;
  const w = Math.min(...los) * CELL, e = (Math.max(...los) + 1) * CELL;

  state.loading = true;
  if (!state.counts.osm) setStatus('Ielādē ceļa zīmes…');
  try {
    const data = await fetchOverpass(buildQuery(s.toFixed(4), w.toFixed(4), n.toFixed(4), e.toFixed(4)));
    let added = 0;
    for (const el of data.elements || []) {
      if (el.type === 'node') {
        if (state.seenNodes.has(el.id)) continue;
        state.seenNodes.add(el.id);
        const sign = classifyNode(el.tags);
        if (sign && addSignMarker(el.lat, el.lon, sign)) added++;
      } else if (el.type === 'way' && el.geometry && !state.ways.has(el.id)) {
        const limit = parseMaxspeed(el.tags.maxspeed);
        if (!limit) continue;
        const pts = el.geometry.map(p => [p.lat, p.lon]);
        state.ways.set(el.id, { limit, pts });
        indexWay(limit, pts);
        added += addWaySpeedSigns(pts, limit);
      }
    }
    missing.forEach(c => state.loadedCells.add(c));
    signLayer.redraw();
    state.osmRetryMs = 0;
    state.counts.osm += added;
    setTimeout(loadSignsForView, 100); // ja karte pa to laiku pārvietota
    showCounts();
    updateLimit();
  } catch (err) {
    console.error(err);
    // Serveri pārslogoti: mēģina vēlreiz pēc 10, 20, 40… sekundēm (maks. 2 min).
    state.osmRetryMs = Math.min(120000, (state.osmRetryMs || 5000) * 2);
    setStatus(`OpenStreetMap serveri ir pārslogoti. Mēģināšu vēlreiz pēc ${Math.round(state.osmRetryMs / 1000)} s.` +
      (state.mlyToken ? '' : ' Pievieno Mapillary atslēgu iestatījumos, lai zīmes ielādētos droši.'));
    setTimeout(loadSignsForView, state.osmRetryMs);
  } finally {
    state.loading = false;
  }
}

// Ceļiem ar ātruma ierobežojumu uzliek zīmi ceļa sākumā,
// ja tuvumā jau nav tādas pašas zīmes (citādi karte būtu pārblīvēta).
const placedSpeed = [];
function addWaySpeedSigns(pts, limit) {
  if (pts.length < 2 || pathLength(pts) < 120) return 0;
  const at = pointAlong(pts, 25); // 25 m no ceļa sākuma
  const tooClose = placedSpeed.some(p => p.limit === limit && distM(p.lat, p.lng, at[0], at[1]) < 250);
  if (tooClose) return 0;
  placedSpeed.push({ lat: at[0], lng: at[1], limit });
  return addSignMarker(at[0], at[1], { cat: 'speed', kind: 'speed', value: limit, title: `Ātruma ierobežojums ${limit} km/h` }) ? 1 : 0;
}

// ---------- Mapillary zīmes ----------
let mlyLoading = false;
async function loadMapillaryForView() {
  if (!state.mlyToken || mlyLoading || map.getZoom() < MIN_SIGN_ZOOM) return;
  const b = map.getBounds().pad(0.2);
  const tiles = tilesForBounds(b.getSouth(), b.getWest(), b.getNorth(), b.getEast())
    .filter(([x, y]) => !state.mlyTiles.has(x + ':' + y));
  if (!tiles.length || tiles.length > 16) return;
  mlyLoading = true;
  try {
    const results = await Promise.allSettled(tiles.map(([x, y]) => fetchMapillaryTile(x, y, state.mlyToken)));
    let added = 0;
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        if (r.reason && r.reason.badToken) {
          setStatus('Mapillary atslēga nav derīga. Pārbaudi to iestatījumos.');
          state.mlyToken = '';
        }
        return;
      }
      state.mlyTiles.add(tiles[i][0] + ':' + tiles[i][1]);
      for (const s of r.value) {
        const sign = classifyMapillary(s.value);
        const obj = addSignMarker(s.lat, s.lng, sign, MLY_ICON_URL + encodeURIComponent(s.value) + '.svg');
        if (obj) { added++; obj.value = s.value; }
      }
    });
    state.counts.mly += added;
    signLayer.redraw();
    showCounts();
    if (added) { dirCenter = null; loadDirectionsNearMe(); }
  } finally {
    mlyLoading = false;
  }
  setTimeout(loadMapillaryForView, 100); // ja karte pa to laiku pārvietota
}

// Zīmju virzienus ielādē ~300 m apgabalā ap braucēju (API ir lēns, tāpēc ne visai kartei).
// Kad pabrauc ~150 m tālāk, ielādē jaunu apgabalu.
let dirCenter = null, dirLoading = false;
async function loadDirectionsNearMe() {
  if (!state.mlyToken || !state.me || dirLoading) return;
  const { lat, lng } = state.me;
  if (dirCenter && distM(dirCenter[0], dirCenter[1], lat, lng) < 150) return;
  dirLoading = true;
  dirCenter = [lat, lng];
  try {
    const dLat = 0.003, dLng = 0.003 / Math.cos(lat * Math.PI / 180);
    // Kuri Mapillary zīmju veidi ir šajā apgabalā un cik to ir.
    const counts = new Map();
    signLayer.eachInBox(lat - dLat, lng - dLng, lat + dLat, lng + dLng, s => {
      if (s.value && s.face == null) counts.set(s.value, (counts.get(s.value) || 0) + 1);
    });
    if (!counts.size) return;
    const found = await fetchMapillaryDirectionsArea(lng - dLng, lat - dLat, lng + dLng, lat + dLat, state.mlyToken, counts);
    let matched = 0;
    for (const f of found) {
      const s = signLayer.findNear(f.lat, f.lng, 5, x => x.value === f.value);
      if (s) { s.face = MLY_DIR_IS_FACE ? f.dir : (f.dir + 180) % 360; matched++; }
    }
    if (matched) signLayer.redraw();
  } catch (err) {
    console.warn('Virzieni nav ielādēti', err);
    dirCenter = null; // mēģinās vēlreiz nākamajā GPS atjauninājumā
  } finally {
    dirLoading = false;
  }
}

function showCounts() {
  if (state.routeActive) return;
  const parts = [];
  if (state.counts.mly) parts.push(`${state.counts.mly} no Mapillary`);
  if (state.counts.osm) parts.push(`${state.counts.osm} no OpenStreetMap`);
  if (parts.length) setStatus('Zīmes: ' + parts.join(', ') + '.');
}

function loadAllForView() {
  loadSignsForView();
  loadMapillaryForView();
}

// ---------- Ģeometrija (metri) ----------
function distM(lat1, lng1, lat2, lng2) {
  const k = 111320, x = (lng2 - lng1) * k * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180), y = (lat2 - lat1) * k;
  return Math.hypot(x, y);
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
function distToSegment(p, a, b) {
  const k = 111320, c = Math.cos(p[0] * Math.PI / 180);
  const ax = (a[1] - p[1]) * k * c, ay = (a[0] - p[0]) * k;
  const bx = (b[1] - p[1]) * k * c, by = (b[0] - p[0]) * k;
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
// Ceļu posmi sadalīti nelielās šūnās, lai ātri atrastu tuvāko ceļu.
const WAY_CELL = 0.002; // ~200 m
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
function nearestLimit(lat, lng) {
  let best = null, bestD = 30; // tikai ceļi 30 m attālumā
  const la = Math.floor(lat / WAY_CELL), lo = Math.floor(lng / WAY_CELL);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    for (const [a, b, limit] of wayGrid.get((la + i) + ':' + (lo + j)) || []) {
      const d = distToSegment([lat, lng], a, b);
      if (d < bestD) { bestD = d; best = limit; }
    }
  }
  return best;
}

// ---------- Mana atrašanās vieta ----------
// "Tu esi šeit": zils aplis ar baltu bultu, kas griežas braukšanas virzienā.
const meIcon = L.divIcon({
  className: 'me-icon',
  html: `<div class="me-halo"></div>
    <svg class="me-puck" viewBox="0 0 48 48" aria-hidden="true">
      <defs><linearGradient id="meGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#5aa0ff"/><stop offset="1" stop-color="#1a5ad8"/>
      </linearGradient></defs>
      <circle cx="24" cy="24" r="20" fill="#fff"/>
      <circle cx="24" cy="24" r="16.5" fill="url(#meGrad)"/>
      <path class="me-chevron" d="M24 11.5 33 33 24 28.2 15 33Z" fill="#fff" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>
      <circle class="me-center" cx="24" cy="24" r="5.5" fill="#fff"/>
    </svg>`,
  iconSize: [48, 48],
  iconAnchor: [24, 24],
});
let meMarker = null;

// Braukšanas virziens: no GPS, vai aprēķināts no pārvietošanās.
let lastFix = null;
let shownHeading = null;
function updateHeading(lat, lng, gpsHeading, speedKmh) {
  if (gpsHeading != null && !isNaN(gpsHeading) && (speedKmh == null || speedKmh > 4)) {
    state.heading = gpsHeading;
  } else if (lastFix && distM(lastFix[0], lastFix[1], lat, lng) > 8) {
    state.heading = bearingDeg(lastFix[0], lastFix[1], lat, lng);
  } else if (lastFix) {
    return; // pārāk mazs pārvietojums, lai noteiktu virzienu
  }
  lastFix = [lat, lng];
  signLayer.setHeading(state.heading);
  if (state.heading != null) {
    // Griež bultu pa īsāko ceļu (piem. 350° → 10° = +20°, nevis −340°).
    shownHeading = shownHeading == null ? state.heading
      : shownHeading + ((((state.heading - shownHeading) % 360) + 540) % 360 - 180);
  }
  if (meMarker) meMarker.getElement()?.style.setProperty('--heading', (shownHeading ?? 0) + 'deg');
  document.documentElement.classList.toggle('has-heading', state.heading != null);
}
function bearingDeg(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180, y = Math.sin((lng2 - lng1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lng2 - lng1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

function setMe(lat, lng, speedKmh, gpsHeading) {
  state.me = { lat, lng, speedKmh };
  if (!meMarker) meMarker = L.marker([lat, lng], { icon: meIcon, zIndexOffset: 1000, interactive: false }).addTo(map);
  else meMarker.setLatLng([lat, lng]);
  if (state.follow) map.panTo([lat, lng], { animate: true });
  document.getElementById('speedValue').textContent = speedKmh == null ? '–' : Math.round(speedKmh);
  updateHeading(lat, lng, gpsHeading, speedKmh);
  updateLimit();
  loadDirectionsNearMe();
}

function updateLimit() {
  const badge = document.getElementById('limitBadge');
  if (!state.me) { badge.hidden = true; return; }
  const limit = nearestLimit(state.me.lat, state.me.lng);
  badge.hidden = limit == null;
  if (limit != null) document.getElementById('limitValue').textContent = limit;
  const over = state.warn && limit != null && state.me.speedKmh != null && state.me.speedKmh > limit + 3;
  document.getElementById('speedBox').classList.toggle('over', over);
  badge.classList.toggle('pulse', over);
}

// Iemesls, kāpēc atrašanās vieta nav zināma (rāda, nospiežot "Es").
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
  setMe(pos.coords.latitude, pos.coords.longitude, sp == null || sp < 0 ? null : sp * 3.6, pos.coords.heading);
  if (first) map.setView([pos.coords.latitude, pos.coords.longitude], Math.max(map.getZoom(), 16));
  gpsProblem = null;
  if (!state.routeActive) setStatus('GPS darbojas.');
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
  // Ātra, aptuvena vieta (no WiFi/tīkla), kamēr GPS vēl meklē precīzu.
  navigator.geolocation.getCurrentPosition(onPosition, () => {}, { enableHighAccuracy: false, maximumAge: 60000, timeout: 10000 });
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(onPosition, onGpsError,
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
}

// ---------- Meklēšana un maršruts ----------
let routeLine = null, destMarker = null;

async function search(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=lv&accept-language=lv&q=' + encodeURIComponent(q);
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function showResults(items) {
  const ul = document.getElementById('results');
  ul.innerHTML = '';
  if (!items.length) {
    ul.innerHTML = '<li class="empty">Nekas netika atrasts. Pamēģini citu adresi.</li>';
  }
  for (const it of items) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    const [name, ...rest] = it.display_name.split(', ');
    btn.innerHTML = `<strong></strong><span></span>`;
    btn.querySelector('strong').textContent = name;
    btn.querySelector('span').textContent = rest.slice(0, 3).join(', ');
    btn.addEventListener('click', () => { ul.hidden = true; routeTo(+it.lat, +it.lon, name); });
    li.appendChild(btn);
    ul.appendChild(li);
  }
  ul.hidden = false;
}

async function routeTo(lat, lng, name) {
  const from = state.me || { lat: map.getCenter().lat, lng: map.getCenter().lng };
  setStatus('Meklē maršrutu…');
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${lng},${lat}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.routes || !data.routes.length) throw new Error('nav maršruta');
    const r = data.routes[0];
    clearRoute();
    routeLine = L.geoJSON(r.geometry, { style: { color: '#2f7cf6', weight: 7, opacity: 0.9, className: 'route-line' } }).addTo(map);
    destMarker = L.marker([lat, lng]).addTo(map).bindTooltip(name);
    state.follow = false;
    map.fitBounds(routeLine.getBounds(), { padding: [70, 70] });
    const km = (r.distance / 1000).toLocaleString('lv-LV', { maximumFractionDigits: 1 });
    const min = Math.round(r.duration / 60);
    document.getElementById('routeText').textContent = `${name}: ${km} km · ${min} min`;
    document.getElementById('routeInfo').hidden = false;
    state.routeActive = true;
    setStatus(state.me ? 'Maršruts gatavs. Spied “Es”, lai sekotu sev.' : 'Maršruts no kartes centra (GPS nav).');
  } catch (err) {
    console.error(err);
    setStatus('Maršrutu neizdevās atrast. Pamēģini vēlreiz.');
  }
}

function clearRoute() {
  if (routeLine) map.removeLayer(routeLine);
  if (destMarker) map.removeLayer(destMarker);
  routeLine = destMarker = null;
  state.routeActive = false;
  document.getElementById('routeInfo').hidden = true;
}

// ---------- Saskarne ----------
function setStatus(text) { document.getElementById('statusText').textContent = text; }

function buildCategoryList() {
  const list = document.getElementById('catList');
  for (const [key, cat] of Object.entries(SIGN_CATEGORIES)) {
    const kindFor = { speed: { kind: 'speed', value: 50 }, priority: { kind: 'stop' }, signals: { kind: 'signals' },
      crossing: { kind: 'crossing' }, camera: { kind: 'camera' }, calming: { kind: 'bump' }, rail: { kind: 'rail' }, other: { kind: 'other' } }[key];
    const row = document.createElement('label');
    row.className = 'row cat';
    row.innerHTML = `<span class="cat-icon">${signSvg(kindFor, 26)}</span><span class="cat-name"></span>
      <input type="checkbox" class="switch" id="cat-${key}">`;
    row.querySelector('.cat-name').textContent = cat.label;
    const input = row.querySelector('input');
    input.checked = state.cats[key];
    input.addEventListener('change', () => {
      state.cats[key] = input.checked;
      store.set('cats', state.cats);
      applyLayerVisibility();
    });
    list.appendChild(row);
  }
}

function toggleSettings(open) {
  const sheet = document.getElementById('settings');
  sheet.hidden = !open;
  document.getElementById('settingsBtn').setAttribute('aria-expanded', String(open));
}

document.getElementById('toggleSigns').addEventListener('click', () => {
  state.signsOn = !state.signsOn;
  store.set('signsOn', state.signsOn);
  applyLayerVisibility();
});
document.getElementById('masterSwitch').addEventListener('change', e => {
  state.signsOn = e.target.checked;
  store.set('signsOn', state.signsOn);
  applyLayerVisibility();
});
document.getElementById('warnSwitch').checked = state.warn;
document.getElementById('warnSwitch').addEventListener('change', e => {
  state.warn = e.target.checked; store.set('warn', state.warn); updateLimit();
});
document.getElementById('testSwitch').addEventListener('change', e => {
  state.testMode = e.target.checked;
  setStatus(state.testMode ? 'Testa režīms: noklikšķini uz ceļa kartē, lai “nostātos” tur.' : 'Testa režīms izslēgts.');
});
document.getElementById('centerBtn').addEventListener('click', () => {
  state.follow = true;
  if (state.me) { map.setView([state.me.lat, state.me.lng], Math.max(map.getZoom(), 16)); return; }
  // Vēlreiz paprasa atļauju (iPhone to prasa tikai pēc pogas nospiešanas).
  setStatus(gpsProblem || 'Meklē atrašanās vietu…');
  startGps();
});
document.getElementById('settingsBtn').addEventListener('click', () => toggleSettings(document.getElementById('settings').hidden));
document.getElementById('closeSettings').addEventListener('click', () => toggleSettings(false));
document.getElementById('clearRoute').addEventListener('click', () => { clearRoute(); setStatus('Maršruts atcelts.'); });

document.getElementById('searchForm').addEventListener('submit', async e => {
  e.preventDefault();
  const q = document.getElementById('searchInput').value.trim();
  if (q.length < 2) return;
  try { showResults(await search(q)); }
  catch { setStatus('Meklēšana neizdevās. Pārbaudi internetu.'); }
});
document.getElementById('searchInput').addEventListener('input', e => {
  if (!e.target.value) document.getElementById('results').hidden = true;
});

map.on('dragstart', () => { state.follow = false; });
let signTip = null;
map.on('click', e => {
  document.getElementById('results').hidden = true;
  const hit = state.signsOn && map.hasLayer(signLayer) ? signLayer.hitTest(e.containerPoint) : null;
  if (hit) {
    if (signTip) map.removeLayer(signTip);
    signTip = L.tooltip({ direction: 'top', offset: [0, -16] }).setLatLng([hit.lat, hit.lng]).setContent(hit.title).addTo(map);
    return;
  }
  if (signTip) { map.removeLayer(signTip); signTip = null; }
  if (state.testMode) { state.follow = false; setMe(e.latlng.lat, e.latlng.lng, 55); }
});
let moveTimer;
map.on('moveend', () => { clearTimeout(moveTimer); moveTimer = setTimeout(loadAllForView, 500); });

// Pretējā virziena zīmes: blāvas vai paslēptas
const oppSwitch = document.getElementById('oppSwitch');
oppSwitch.checked = state.hideOpposite;
signLayer.setHideOpposite(state.hideOpposite);
oppSwitch.addEventListener('change', () => {
  state.hideOpposite = oppSwitch.checked;
  store.set('hideOpposite', state.hideOpposite);
  signLayer.setHideOpposite(state.hideOpposite);
});

// Kartes stila izvēle
const basemapSelect = document.getElementById('basemapSelect');
for (const [key, b] of Object.entries(BASEMAP_STYLES)) basemapSelect.add(new Option(b.label, key));
basemapSelect.value = state.basemap;
basemapSelect.addEventListener('change', () => {
  state.basemap = basemapSelect.value;
  store.set('basemap', state.basemap);
  setBasemap(map, state.basemap);
});

// Mapillary atslēga (glabājas tikai šajā telefonā/pārlūkā)
const tokenInput = document.getElementById('mlyToken');
tokenInput.value = state.mlyToken;
function updateTokenNote() {
  document.getElementById('mlyNote').textContent = state.mlyToken
    ? 'Atslēga saglabāta šajā ierīcē. Mapillary zīmes ir ieslēgtas.'
    : 'Bez atslēgas rāda tikai OpenStreetMap zīmes.';
}
document.getElementById('mlySave').addEventListener('click', () => {
  const v = tokenInput.value.trim();
  if (v && !v.startsWith('MLY|')) {
    document.getElementById('mlyNote').textContent = 'Atslēgai jāsākas ar MLY| — nokopē "Client Token" no Mapillary.';
    return;
  }
  state.mlyToken = v;
  store.set('mlyToken', v);
  state.mlyTiles.clear();
  updateTokenNote();
  loadMapillaryForView();
});
updateTokenNote();

// ---------- Starts ----------
buildCategoryList();
applyLayerVisibility();
startGps();
loadAllForView();
