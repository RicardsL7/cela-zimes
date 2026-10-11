// Ceļa Zīmes — galvenā lietotnes loģika.
// Karte: Leaflet + CARTO. Zīmes: OpenStreetMap caur Overpass API.
// Meklēšana: Nominatim. Maršruts: OSRM.

// Vairāki bezmaksas serveri: jautājam visiem reizē un ņemam ātrāko atbildi,
// jo kāds no tiem bieži ir pārslogots.
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
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
};

// ---------- Karte ----------
// OpenStreetMap karte. Tumšajā režīmā to aptumšo ar CSS (style.css).
const map = L.map('map', { zoomControl: false, attributionControl: true }).setView(START, 16);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

// Katrai kategorijai savs slānis, lai tās var ieslēgt/izslēgt atsevišķi.
const layers = Object.fromEntries(Object.keys(SIGN_CATEGORIES).map(k => [k, L.layerGroup()]));

function applyLayerVisibility() {
  for (const [cat, layer] of Object.entries(layers)) {
    const show = state.signsOn && state.cats[cat];
    if (show && !map.hasLayer(layer)) layer.addTo(map);
    if (!show && map.hasLayer(layer)) map.removeLayer(layer);
  }
  const btn = document.getElementById('toggleSigns');
  btn.setAttribute('aria-pressed', String(state.signsOn));
  btn.classList.toggle('off', !state.signsOn);
  document.getElementById('toggleSignsLabel').textContent = state.signsOn ? 'Zīmes' : 'Izslēgtas';
  document.getElementById('masterSwitch').checked = state.signsOn;
  document.getElementById('catList').classList.toggle('disabled', !state.signsOn);
}

function addSignMarker(lat, lng, sign) {
  const icon = L.divIcon({
    className: 'sign-icon',
    html: signSvg(sign, 30),
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
  L.marker([lat, lng], { icon, keyboard: false, title: sign.title })
    .bindTooltip(sign.title, { direction: 'top', offset: [0, -14] })
    .addTo(layers[sign.cat]);
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
  setStatus('Ielādē ceļa zīmes… (var aizņemt līdz 20 s)');
  try {
    const data = await fetchOverpass(buildQuery(s.toFixed(4), w.toFixed(4), n.toFixed(4), e.toFixed(4)));
    let added = 0;
    for (const el of data.elements || []) {
      if (el.type === 'node') {
        if (state.seenNodes.has(el.id)) continue;
        state.seenNodes.add(el.id);
        const sign = classifyNode(el.tags);
        if (sign) { addSignMarker(el.lat, el.lon, sign); added++; }
      } else if (el.type === 'way' && el.geometry && !state.ways.has(el.id)) {
        const limit = parseMaxspeed(el.tags.maxspeed);
        if (!limit) continue;
        const pts = el.geometry.map(p => [p.lat, p.lon]);
        state.ways.set(el.id, { limit, pts });
        added += addWaySpeedSigns(pts, limit);
      }
    }
    missing.forEach(c => state.loadedCells.add(c));
    setTimeout(loadSignsForView, 100); // ja karte pa to laiku pārvietota
    setStatus(added ? `Atrastas ${added} jaunas zīmes.` : 'Šajā apkārtnē jaunu zīmju nav.');
    updateLimit();
  } catch (err) {
    console.error(err);
    setStatus('Neizdevās ielādēt zīmes. Pārbaudi internetu un pakusties pa karti, lai mēģinātu vēlreiz.');
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
  addSignMarker(at[0], at[1], { cat: 'speed', kind: 'speed', value: limit, title: `Ātruma ierobežojums ${limit} km/h` });
  return 1;
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
function nearestLimit(lat, lng) {
  let best = null, bestD = 30; // tikai ceļi 30 m attālumā
  for (const w of state.ways.values()) {
    for (let i = 1; i < w.pts.length; i++) {
      const d = distToSegment([lat, lng], w.pts[i - 1], w.pts[i]);
      if (d < bestD) { bestD = d; best = w.limit; }
    }
  }
  return best;
}

// ---------- Mana atrašanās vieta ----------
const meIcon = L.divIcon({ className: 'me-icon', html: '<div class="me-dot"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
let meMarker = null;

function setMe(lat, lng, speedKmh) {
  state.me = { lat, lng, speedKmh };
  if (!meMarker) meMarker = L.marker([lat, lng], { icon: meIcon, zIndexOffset: 1000, interactive: false }).addTo(map);
  else meMarker.setLatLng([lat, lng]);
  if (state.follow) map.panTo([lat, lng], { animate: true });
  document.getElementById('speedValue').textContent = speedKmh == null ? '–' : Math.round(speedKmh);
  updateLimit();
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

function startGps() {
  if (!('geolocation' in navigator)) {
    setStatus('Šī ierīce nerāda atrašanās vietu. Ieslēdz testa režīmu iestatījumos.');
    return;
  }
  navigator.geolocation.watchPosition(
    pos => {
      if (state.testMode) return;
      const sp = pos.coords.speed;
      setMe(pos.coords.latitude, pos.coords.longitude, sp == null || sp < 0 ? null : sp * 3.6);
      if (!state.routeActive) setStatus('GPS darbojas.');
    },
    err => {
      setStatus(err.code === 1
        ? 'Atrašanās vieta nav atļauta. Atļauj to pārlūkā vai ieslēdz testa režīmu.'
        : 'GPS signāls nav pieejams. Vari ieslēgt testa režīmu iestatījumos.');
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
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
  if (state.me) map.setView([state.me.lat, state.me.lng], Math.max(map.getZoom(), 16));
  else setStatus('Atrašanās vieta vēl nav zināma.');
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
map.on('click', e => {
  document.getElementById('results').hidden = true;
  if (state.testMode) { state.follow = false; setMe(e.latlng.lat, e.latlng.lng, 55); }
});
let moveTimer;
map.on('moveend', () => { clearTimeout(moveTimer); moveTimer = setTimeout(loadSignsForView, 500); });

// ---------- Starts ----------
buildCategoryList();
applyLayerVisibility();
startGps();
loadSignsForView();
