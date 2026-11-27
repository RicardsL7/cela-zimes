// Ceļa Zīmes — brīdinājumi: marķieri, radaru slānis, signāla gredzeni, MapLibre izteiksmes.
// B16 (audits 2): pārcelts no app-gl.js bez izmaiņām (tas pats globālais tvērums — klasisks skripts, ne modulis).
// Ielādējas PĒC app-gl.js un PIRMS app-start.js (kas izsauc init()): augšējā līmeņa kods šeit drīkst izmantot visu no
// app-gl.js; app-gl.js augšējā līmenī (ārpus funkcijām) šī faila nosaukumus izmantot nedrīkst. Pārbaude: tools/check-js.mjs.

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
// v143 (owner): icons turn into dots even sooner when zooming out (v142: 14.7 / 14.3, before: 13 / 12.6).
// Must stay below the fast-driving camera zoom (15.8, followCamera), so icons are still shown while driving.
const MARKER_IN_ZOOM = 15.6;   // tuvinot līdz šim — punkti pārvēršas ikonās
const MARKER_OUT_ZOOM = 15.2;  // attālinot zem šī — ikonas atpakaļ punktos (histerēze: nav mirgošanas)
const ALERT_DOTS_SRC = 'alert-dots';
// v141: traffic lights at half size here too (TRAFFIC_LIGHT_SCALE, signs-gl.js)
function alertIconSize(k) {
  const S = typeof TRAFFIC_LIGHT_SCALE === 'number' ? TRAFFIC_LIGHT_SCALE : 1;
  const v = x => ['case', ['==', ['get', 'icon'], 'alert:traffic-light'], x * S, x];
  return ['interpolate', ['linear'], ['zoom'], 12, v(0.62 * k), 16, v(1 * k), 18.5, v(1.22 * k)];
}
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
      // spraudas smailes gals — tieši notikuma vietā; v144: luksofors un pārbrauktuve — bez spraudas, centrā
      'icon-anchor': ['case', ['in', ['get', 'icon'], ['literal', ALERT_STANDALONE_ICONS]], 'center', ALERT_ICON_ANCHOR],
      'icon-offset': ['case', ['in', ['get', 'icon'], ['literal', ALERT_STANDALONE_ICONS]], ['literal', [0, 0]], ['literal', ALERT_ICON_OFFSET]],
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
  // v143: dots ~1/3 smaller (radar dots have their own layer and keep their size)
  const cl = ['interpolate', ['linear'], ['get', 'point_count'], 2, 3 * r, 12, 3.8 * r, 60, 4.8 * r];
  return ['interpolate', ['linear'], ['zoom'],
    9, ['case', ['has', 'point_count'], cl, 2.1 * r],
    MARKER_IN_ZOOM, ['case', ['has', 'point_count'], cl, 3 * r]];
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
  pop: { ms: 170, frame: t => ({
    dotR: 1 + 0.35 * smooth(t / 0.35), dotOp: 1 - smooth((t - 0.28) / 0.32),
    glow: 1 + 0.7 * smooth(t / 0.3) * (1 - smooth((t - 0.35) / 0.35)),
    iconOp: smooth((t - 0.2) / 0.32), iconS: 0.55 + 0.45 * backOut((t - 0.2) / 0.8, 1.6),
  }) },
  // Pārveidošanās (morph): punkts "ieelpo", paplašinās ar mirdzumu, no tā izaug ikona ar mazu atlēcienu
  morph: { ms: 280, frame: t => {
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
  if (map.getZoom() < MARKER_IN_ZOOM) { map.easeTo({ zoom: 16, duration: 700 }); return; }
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
const RADAR_ICON_FROM = 14.6, RADAR_ICON_FULL = 15.6;   // marķiera "izaugšana" pēc tuvinājuma (v143: kopā ar pārējiem marķieriem; pilns līdz 15,8)
let radarSignDots = [];
const radar = { sel: null, raf: 0, last: 0, t0: performance.now(), on: false, dark: true, near: new Map() };

function mapIsDark() { return state.basemap === 'dark'; }
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
  refreshPulse(feats);
}

// ---------- v121b: kustīgi signāla gredzeni ap policiju un radariem ----------
// Ap zīmes galvu periodiski izplešas un izgaist divi gredzeni (kā raidīts signāls), lai braucot to pamana laikus.
// Zīme kartē ir attēls, tāpēc gredzeni ir atsevišķi apļu slāņi: centrs pārbīdīts uz augšu līdz galvas centram
// (smaile = notikuma vieta; galvas centrs 36,5 vienības virs smailes = 18,25 px pie icon-size 1).
// Ja ierīcē ieslēgts „samazināt kustību” — gredzeni stāv uz vietas.
const PULSE_SRC = 'alert-pulse';
const PULSE_PERIOD = 2.2;                 // s — viens gredzens no galvas līdz izgaišanai
const PULSE_HEAD_PX = 18.25;              // galvas centrs virs smailes pie icon-size 1
const PULSE_COLOR = { 'police': '#2F6BFF', 'police-hidden': '#2F6BFF', 'camera-fixed': '#3D7BF0', 'camera-mobile': '#8B5CF6' };
// izmērs pēc tuvinājuma — tāds pats kā zīmei savā slānī (policija: alerts, radari: radar-icon)
const PULSE_SIZES = { police: [[12, 0.62], [16, 1], [18.5, 1.22]], camera: [[13.5, 0.84], [16, 1.08], [18.5, 1.3]] };
const pulse = { raf: 0, last: 0, count: 0, t0: performance.now() };
const pulseStill = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
function refreshPulse(radarFeats) {
  const src = map && map.getSource && map.getSource(PULSE_SRC);
  if (!src) return;
  const show = state.signsOn && state.mapMode === 'alerts';
  const feats = [];
  if (show) {
    for (const f of radarFeats || []) {
      if (f.properties.point_count) continue;
      feats.push({ type: 'Feature', geometry: f.geometry, properties: { kind: 'camera', col: PULSE_COLOR[f.properties.type] || PULSE_COLOR['camera-fixed'], ph: f.properties.ph || 0 } });
    }
    if (alerts) for (const it of alerts.list()) if (it.type === 'police' || it.type === 'police-hidden') {
      feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [it.lng, it.lat] }, properties: { kind: 'police', col: PULSE_COLOR[it.type], ph: radarPhase(it.lng, it.lat) } });
    }
  }
  src.setData({ type: 'FeatureCollection', features: feats });
  pulse.count = feats.length;
  pulseAnimate();
}
// Gredzena rādiuss un caurspīdība laikā T; off — otrā gredzena nobīde (0 vai 0,5 perioda)
function pulseU(T, off) { return ['%', ['+', T / PULSE_PERIOD + off, ['*', 0.35, ['coalesce', ['get', 'ph'], 0]]], 1]; }
function pulseRadius(kind, T, off) {
  const e = easeOutX(pulseU(T, off));
  const stops = [];
  for (const [z, k] of PULSE_SIZES[kind]) stops.push(z, ['*', k, ['+', 11, ['*', 16, e]]]);
  return RZ(...stops);
}
function pulseOpacity(T, off) {
  const u = pulseU(T, off);
  return ['*', mapIsDark() ? 0.85 : 0.75, ['^', ['-', 1, u], 1.4]];
}
function installPulseLayer() {
  if (map.getSource(PULSE_SRC)) return;
  map.addSource(PULSE_SRC, { type: 'geojson', data: EMPTY_FC });
  const order = map.getStyle().layers.map(l => l.id);
  const before = ['alerts', 'radar-icon'].filter(id => order.includes(id)).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
  const T = pulseStill() ? 0.8 : (performance.now() - pulse.t0) / 1000;
  for (const kind of ['police', 'camera']) {
    const tr = RZ(...PULSE_SIZES[kind].flatMap(([z, k]) => [z, ['literal', [0, -PULSE_HEAD_PX * k]]]));
    for (const off of [0, 0.5]) {
      map.addLayer({ id: `pulse-${kind}-${off ? 'b' : 'a'}`, type: 'circle', source: PULSE_SRC,
        minzoom: kind === 'police' ? MARKER_IN_ZOOM : RADAR_ICON_FULL, filter: ['==', ['get', 'kind'], kind],
        paint: {
          'circle-opacity': 0, 'circle-color': ['get', 'col'],
          'circle-stroke-color': ['get', 'col'], 'circle-stroke-width': RZ(13, 1.6, 17, 2.4),
          'circle-radius': pulseRadius(kind, T, off), 'circle-stroke-opacity': pulseOpacity(T, off),
          'circle-translate': tr, 'circle-translate-anchor': 'viewport', 'circle-pitch-alignment': 'viewport',
        } }, before);
    }
  }
  refreshAlerts();
}
// ~30 kadri/s, tikai kad ir ko rādīt un karte pietuvināta; cilnē fonā — apstājas
function pulseAnimate() {
  if (pulse.raf || pulseStill() || !map || !map.getLayer('pulse-police-a')) return;
  const step = now => {
    pulse.raf = 0;
    if (!map.getLayer('pulse-police-a') || !pulse.count || document.hidden || map.getZoom() < MARKER_IN_ZOOM) return;
    if (now - pulse.last >= 33) {
      pulse.last = now;
      const T = Math.round((now - pulse.t0) / 10) / 100;
      for (const kind of ['police', 'camera']) for (const off of [0, 0.5]) {
        const id = `pulse-${kind}-${off ? 'b' : 'a'}`;
        map.setPaintProperty(id, 'circle-radius', pulseRadius(kind, T, off));
        map.setPaintProperty(id, 'circle-stroke-opacity', pulseOpacity(T, off));
      }
    }
    pulse.raf = requestAnimationFrame(step);
  };
  pulse.raf = requestAnimationFrame(step);
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
  map.addLayer(Object.assign({ id: 'radar-halo', type: 'circle', maxzoom: RADAR_ICON_FULL, paint: {   // v121b: tuvāk — kustīgie gredzeni ap galvu
    'circle-color': P.halo, 'circle-blur': 1, 'circle-pitch-alignment': 'map',
    'circle-radius': RZ(9, ['case', cluster, 13, aheadCase(12, 10, 8)], 13, ['case', cluster, 18, aheadCase(20, 16, 13)], 16, aheadCase(30, 25, 21)),
    'circle-opacity': radarHaloOpacity(T) } }, base), below);
  // 2) impulsa gredzens
  map.addLayer(Object.assign({ id: 'radar-ring', type: 'circle', maxzoom: RADAR_ICON_FULL, paint: {
    'circle-color': P.ring, 'circle-opacity': 0, 'circle-pitch-alignment': 'map',
    'circle-stroke-color': P.ring, 'circle-stroke-width': RZ(9, 1, 14, 1.5),
    'circle-radius': radarRingRadius(T), 'circle-stroke-opacity': radarRingOpacity(T) } }, base), below);
  // 3) kodols — skaidrs violets punkts ar gaišu malu; tuvinot (12,9…13,8) maigi izzūd, jo no tā izaug marķieris
  const coreFade = v => RZ(RADAR_ICON_FROM + 0.7, v, RADAR_ICON_FULL + 0.3, 0);
  map.addLayer(Object.assign({ id: 'radar-core', type: 'circle', maxzoom: RADAR_ICON_FULL + 0.5, paint: {
    'circle-color': P.core, 'circle-pitch-alignment': 'map',
    'circle-radius': RZ(9, ['case', cluster, ['interpolate', ['linear'], ['get', 'point_count'], 2, 7.5, 10, 9, 40, 11], aheadCase(4.6, 4.2, 3.6)],
      RADAR_ICON_FROM, ['case', cluster, 9, aheadCase(5.8, 5.4, 4.8)], RADAR_ICON_FULL + 0.1, aheadCase(5, 4.6, 4)),
    'circle-stroke-color': P.edge, 'circle-stroke-width': RZ(9, 1.2, 13, 1.6), 'circle-stroke-opacity': coreFade(0.95),
    'circle-opacity': coreFade(1) } }, base), above);
  // mazs iekšējais atspīdums (tikai atsevišķiem punktiem) — "dārgakmens" sajūta
  map.addLayer(Object.assign({ id: 'radar-core-shine', type: 'circle', maxzoom: RADAR_ICON_FULL + 0.5, filter: ['!', cluster], paint: {
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
      'icon-anchor': ALERT_ICON_ANCHOR, 'icon-offset': ALERT_ICON_OFFSET,
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
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { radarAnimate(); pulseAnimate(); } });
  map.on('zoomend', radarAnimate);
  map.on('zoomend', pulseAnimate);
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
// list — which items to consider (default: everything on the map).
function nextAlertAhead(list) {
  if (!alerts) return null;
  let best = null;
  for (const it of list || alerts.list()) {
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
