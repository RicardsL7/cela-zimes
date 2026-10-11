// Ceļa zīmju klasifikācija un ikonas.
// Šis fails nezina neko par karti — tikai pārvērš OpenStreetMap datus zīmēs.

const SIGN_CATEGORIES = {
  speed:    { label: 'Ātruma ierobežojumi' },
  priority: { label: 'STOP un "Dodiet ceļu"' },
  signals:  { label: 'Luksofori' },
  crossing: { label: 'Gājēju pārejas' },
  camera:   { label: 'Ātruma kameras' },
  calming:  { label: 'Ātrumvaļņi' },
  rail:     { label: 'Dzelzceļa pārbrauktuves' },
  other:    { label: 'Citas zīmes' },
};

// Latvijas noklusētie ātrumi, ja OSM rakstīts "LV:urban" u.tml.
function parseMaxspeed(value) {
  if (!value) return null;
  const v = String(value).toLowerCase().trim();
  if (v === 'none' || v === 'signals' || v === 'variable') return null;
  const num = v.match(/^(\d{1,3})(\s*mph)?/);
  if (num) {
    const n = parseInt(num[1], 10);
    return num[2] ? Math.round(n * 1.609) : n;
  }
  if (v.includes('living_street') || v === 'walk') return 20;
  if (v.includes('urban')) return 50;
  if (v.includes('rural')) return 90;
  if (v.includes('motorway')) return 110;
  return null;
}

// Atrod skaitli zīmes kodā, piem. "LV:323[50]" vai "DE:274[30]".
function speedFromSignCode(code) {
  const m = String(code).match(/\[(\d{1,3})\]/);
  return m ? parseInt(m[1], 10) : null;
}

// Pārvērš vienu OSM punktu zīmē: { cat, kind, value, title } vai null.
function classifyNode(tags) {
  if (!tags) return null;
  const ts = (tags.traffic_sign || '').toLowerCase();
  const hw = tags.highway;

  if (hw === 'speed_camera' || tags.enforcement === 'maxspeed') {
    return { cat: 'camera', kind: 'camera', title: 'Ātruma kamera' };
  }
  if (hw === 'stop' || /(^|[;:,])stop\b|:206\b/.test(ts)) {
    return { cat: 'priority', kind: 'stop', title: 'STOP — apstāties obligāti' };
  }
  if (hw === 'give_way' || /give_way|:205\b/.test(ts)) {
    return { cat: 'priority', kind: 'giveway', title: 'Dodiet ceļu' };
  }
  if (tags.railway === 'level_crossing') {
    return { cat: 'rail', kind: 'rail', title: 'Dzelzceļa pārbrauktuve' };
  }
  if (tags.traffic_calming) {
    return { cat: 'calming', kind: 'bump', title: 'Ātrumvalnis' };
  }
  if (hw === 'traffic_signals') {
    return { cat: 'signals', kind: 'signals', title: 'Luksofors' };
  }
  if (hw === 'crossing') {
    if (tags.crossing === 'unmarked' || tags.crossing === 'no') return null;
    return { cat: 'crossing', kind: 'crossing', title: 'Gājēju pāreja' };
  }
  if (ts) {
    const n = speedFromSignCode(ts) || (/maxspeed/.test(ts) ? parseMaxspeed(tags.maxspeed) : null);
    if (n) return { cat: 'speed', kind: 'speed', value: n, title: `Ātruma ierobežojums ${n} km/h` };
    if (/city_limit|:518\b/.test(ts)) return { cat: 'other', kind: 'city', title: 'Apdzīvotas vietas sākums' };
    return { cat: 'other', kind: 'other', title: `Ceļa zīme (${tags.traffic_sign})` };
  }
  return null;
}

// ---------- Ikonas (SVG) ----------
const RED = '#d0202a', BLUE = '#1e5bb8', YEL = '#f4c430';

function svgWrap(inner, size = 30) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="${size}" height="${size}">${inner}</svg>`;
}
function warnTriangle(inner) {
  return `<path d="M20 3 38 35H2Z" fill="#fff" stroke="${RED}" stroke-width="4" stroke-linejoin="round"/>${inner}`;
}

function signSvg(sign, size = 30) {
  switch (sign.kind) {
    case 'speed':
      return svgWrap(`<circle cx="20" cy="20" r="17.5" fill="#fff" stroke="${RED}" stroke-width="5"/>
        <text x="20" y="21" text-anchor="middle" dominant-baseline="middle" font-family="Barlow Condensed, Arial Narrow, sans-serif" font-weight="700" font-size="${sign.value >= 100 ? 15 : 18}" fill="#111">${sign.value}</text>`, size);
    case 'stop':
      return svgWrap(`<path d="M13 2h14l11 11v14L27 38H13L2 27V13Z" fill="${RED}" stroke="#fff" stroke-width="2"/>
        <text x="20" y="21" text-anchor="middle" dominant-baseline="middle" font-family="Barlow Condensed, Arial Narrow, sans-serif" font-weight="700" font-size="12" fill="#fff">STOP</text>`, size);
    case 'giveway':
      return svgWrap(`<path d="M2 5h36L20 37Z" fill="#fff" stroke="${RED}" stroke-width="4" stroke-linejoin="round"/>`, size);
    case 'signals':
      return svgWrap(`<rect x="11" y="2" width="18" height="36" rx="5" fill="#222"/>
        <circle cx="20" cy="10" r="4" fill="#e53935"/><circle cx="20" cy="20" r="4" fill="${YEL}"/><circle cx="20" cy="30" r="4" fill="#43a047"/>`, size);
    case 'crossing':
      return svgWrap(`<rect x="2" y="2" width="36" height="36" rx="4" fill="${BLUE}"/>
        <path d="M20 6 35 33H5Z" fill="#fff"/>
        <circle cx="21" cy="14" r="2.4" fill="#111"/>
        <path d="M20.5 17.5 18 24l3 3-1 4M18 24l-3 6M19.5 19l4 3" stroke="#111" stroke-width="2" fill="none" stroke-linecap="round"/>`, size);
    case 'camera':
      return svgWrap(`<rect x="2" y="2" width="36" height="36" rx="4" fill="${BLUE}"/>
        <rect x="8" y="14" width="24" height="15" rx="2.5" fill="#fff"/>
        <rect x="14" y="10.5" width="9" height="5" rx="1.5" fill="#fff"/>
        <circle cx="20" cy="21.5" r="4.5" fill="${BLUE}"/><circle cx="20" cy="21.5" r="2" fill="#fff"/>`, size);
    case 'bump':
      return svgWrap(warnTriangle(`<path d="M9 30h4c2 0 3-6 7-6s5 6 7 6h4" fill="none" stroke="#111" stroke-width="2.6" stroke-linecap="round"/>`), size);
    case 'rail':
      return svgWrap(`<g stroke="#fff" stroke-width="8" stroke-linecap="square"><path d="M6 6 34 34M34 6 6 34"/></g>
        <g stroke="${RED}" stroke-width="5.5" stroke-dasharray="6 5"><path d="M6 6 34 34M34 6 6 34"/></g>`, size);
    case 'city':
      return svgWrap(`<rect x="2" y="8" width="36" height="24" rx="3" fill="#fff" stroke="#111" stroke-width="2.5"/>
        <path d="M9 26V18l5-4 5 4v8M21 26v-11h8v11" fill="none" stroke="#111" stroke-width="2"/>`, size);
    default:
      return svgWrap(`<rect x="3" y="3" width="34" height="34" rx="5" fill="${BLUE}" stroke="#fff" stroke-width="2"/>
        <text x="20" y="22" text-anchor="middle" dominant-baseline="middle" font-family="Barlow, Arial, sans-serif" font-weight="600" font-size="20" fill="#fff">i</text>`, size);
  }
}

if (typeof module !== 'undefined') {
  module.exports = { SIGN_CATEGORIES, parseMaxspeed, speedFromSignCode, classifyNode, signSvg };
}
