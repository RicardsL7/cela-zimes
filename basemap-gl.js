// Kartes stils: skaista vektoru karte (OpenFreeMap, bez atslēgas un limitiem)
// ar mūsu krāsām, vai klasiskā OSM karte vājiem telefoniem.

const BASEMAP_STYLES = {
  auto:     { label: 'Automātiski (krāsaina / tumša)' },
  colorful: { label: 'Krāsaina', url: 'https://tiles.openfreemap.org/styles/liberty' },
  dark:     { label: 'Tumša', url: 'https://tiles.openfreemap.org/styles/dark' },
  light:    { label: 'Vienkārša gaiša', url: 'https://tiles.openfreemap.org/styles/positron' },
  classic:  { label: 'Klasiskā (vieglākā vājiem telefoniem)' },
};

const CLASSIC_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster', tileSize: 256, maxzoom: 19,
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

// Pielāgo stilu: bez 3D māju slāņa (ātrāk) un ar mūsu krāsām.
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

// Atgriež { theme, style, vector } izvēlētajam variantam.
async function loadBasemapStyle(choice) {
  const darkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = choice === 'auto' ? (darkMode ? 'dark' : 'colorful') : choice;
  if (theme === 'classic') return { theme, style: CLASSIC_STYLE, vector: false };
  try {
    const res = await fetch(BASEMAP_STYLES[theme].url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return { theme, style: tuneStyle(await res.json(), theme), vector: true };
  } catch (err) {
    console.error('Kartes stils neielādējās', err);
    return { theme: 'classic', style: CLASSIC_STYLE, vector: false };
  }
}
