// Kartes pamatne: skaista vektoru karte (OpenFreeMap, bez atslēgas un limitiem)
// ar mūsu krāsām. Ja telefons neatbalsta WebGL, izmanto parasto OSM karti.

const BASEMAP_STYLES = {
  auto:     { label: 'Automātiski (krāsaina / tumša)' },
  colorful: { label: 'Krāsaina', url: 'https://tiles.openfreemap.org/styles/liberty' },
  dark:     { label: 'Tumša', url: 'https://tiles.openfreemap.org/styles/dark' },
  light:    { label: 'Vienkārša gaiša', url: 'https://tiles.openfreemap.org/styles/positron' },
  classic:  { label: 'Klasiskā (vieglākā vājiem telefoniem)' },
};

const OFM_ATTRIBUTION = '© <a href="https://openfreemap.org">OpenFreeMap</a> · © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const OSM_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

function hasWebGL() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); }
  catch { return false; }
}

// Pielāgo stilu: bez 3D (ātrāk) un ar mūsu krāsām.
function tuneStyle(style, theme) {
  style.layers = style.layers.filter(l => l.type !== 'fill-extrusion');
  // Plakanās mājas rāda arī pietuvinot (agrāk to darīja 3D slānis).
  for (const l of style.layers) {
    if (l['source-layer'] === 'building' && l.type === 'fill') delete l.maxzoom;
  }
  if (theme !== 'colorful') return style;

  const paint = (id, props) => {
    const l = style.layers.find(x => x.id === id);
    if (l) l.paint = Object.assign(l.paint || {}, props);
  };
  // Mājas: silti toņi, augstākas ēkas nedaudz tumšākas.
  const height = ['coalesce', ['get', 'render_height'], 6];
  paint('building', {
    'fill-color': ['interpolate', ['linear'], height, 0, '#f6e3c8', 10, '#efd2ae', 25, '#e6bf96', 60, '#d9a982'],
    'fill-outline-color': '#d9b892',
    'fill-opacity': 1,
  });
  paint('background', { 'background-color': '#f5f1ea' });
  paint('landuse_residential', { 'fill-color': 'hsla(36, 45%, 90%, 0.45)' });
  paint('park', { 'fill-color': '#bfe2a3', 'fill-opacity': 0.9, 'fill-outline-color': '#a9d48a' });
  paint('landcover_wood', { 'fill-color': '#9fd17f', 'fill-opacity': 0.55 });
  paint('landcover_grass', { 'fill-color': '#c4e6a9', 'fill-opacity': 0.6 });
  paint('landuse_pitch', { 'fill-color': '#c9e7b2' });
  paint('landuse_track', { 'fill-color': '#d9ead0' });
  paint('landuse_cemetery', { 'fill-color': '#cfe2bf' });
  paint('landuse_school', { 'fill-color': '#f1ecc4' });
  paint('landuse_hospital', { 'fill-color': '#fbdde3' });
  paint('water', { 'fill-color': '#93c9ef' });
  for (const id of ['waterway_river', 'waterway_other', 'waterway_tunnel']) paint(id, { 'line-color': '#93c9ef' });
  return style;
}

let baseLayer = null;
let basemapCall = 0;

async function setBasemap(map, choice) {
  const call = ++basemapCall; // ja stilu pārslēdz ātri, uzvar pēdējā izvēle
  const darkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
  let theme = choice === 'auto' ? (darkMode ? 'dark' : 'colorful') : choice;
  if (theme !== 'classic' && (!hasWebGL() || typeof L.maplibreGL !== 'function')) theme = 'classic';

  if (baseLayer) { map.removeLayer(baseLayer); baseLayer = null; }
  document.documentElement.classList.toggle('raster-dark', theme === 'classic' && darkMode);

  if (theme === 'classic') {
    baseLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: OSM_ATTRIBUTION });
    baseLayer.addTo(map);
    return theme;
  }

  let style = BASEMAP_STYLES[theme].url;
  try {
    const json = await fetch(style).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    style = tuneStyle(json, theme);
    if (call !== basemapCall) return theme;
  } catch (err) {
    console.error(err);
    return setBasemap(map, 'classic'); // ja stils neielādējas, vismaz rāda karti
  }
  baseLayer = L.maplibreGL({
    style,
    attribution: OFM_ATTRIBUTION,
    // Ātrdarbībai: bez izgaišanas, ierobežota izšķirtspēja, bez atkārtotām pasaulēm.
    fadeDuration: 0,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    antialias: false,
    renderWorldCopies: false,
    maxTileCacheSize: 120,
    refreshExpiredTiles: false,
  });
  baseLayer.addTo(map);
  return theme;
}
