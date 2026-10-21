// Brīdinājumi kartē (kā Waze): tikai navigācijai un satiksmei būtiski notikumi un objekti,
// nevis visas ceļa zīmes. Katram veidam — viena vienota ikona (krāsains aplis ar gradientu,
// detalizētu simbolu un baltu malu: labi redzama gan gaišā, gan tumšā kartē).
//
// Datu avoti (NEKO neizdomā):
//   • esošās zīmes / OSM objekti: stacionārās ātruma kameras, dzelzceļa pārbrauktuves,
//     luksofori, skolas zonas (brīdinājuma zīmes), laika ierobežojumi, kas ŠOBRĪD ir spēkā;
//   • OpenStreetMap: būvējami / slēgti ceļi (highway=construction), bīstamas vietas (hazard=*);
//   • Open-Meteo: laikapstākļi tavā atrašanās vietā (migla, stiprs lietus, sniegs, apledojums, vētra);
//   • lietotāja ziņojumi (policija, negadījums, sastrēgums, bedre u.c.) — ar derīguma laiku.
//     Lietotnei nav sava servera, tāpēc ziņojumi glabājas tikai šajā ierīcē.
// Veidi, kuriem pašlaik nav datu avota (piem. citu lietotāju ziņojumi, reāllaika sastrēgumi,
// plūdi), ir aprakstīti ALERT_TYPES, bet kartē parādās tikai tad, ja tos kāds avots dod.

const ALERT_GROUP_COLORS = {
  police: '#2563eb', camera: '#334155', accident: '#dc2626', jam: '#be123c', works: '#f97316',
  closure: '#c81e1e', hazard: '#e08a00', weather: '#0284c7', infra: '#4b5a70', restriction: '#7c3aed',
};

// ttl — cik minūtes lietotāja ziņojums ir spēkā; report — var ziņot pats; source — no kurienes nāk.
const ALERT_TYPES = {
  'police':         { label: 'Policija',                    group: 'police',   ttl: 60,  report: true },
  'police-hidden':  { label: 'Slēptā policija',             group: 'police',   ttl: 60,  report: true },
  'camera-fixed':   { label: 'Ātruma kamera',               group: 'camera',   ttl: 43200, report: true },   // 30 dienas
  'camera-mobile':  { label: 'Mobilais fotoradars',         group: 'camera',   ttl: 120, report: true },
  'accident':       { label: 'Ceļu satiksmes negadījums',   group: 'accident', ttl: 90,  report: true },
  'jam':            { label: 'Sastrēgums / lēna satiksme',  group: 'jam',      ttl: 30,  report: true },
  'roadworks':      { label: 'Ceļa remontdarbi',            group: 'works',    ttl: 720, report: true },
  'closure':        { label: 'Ceļš slēgts',                 group: 'closure',  ttl: 360, report: true },
  'lane-closed':    { label: 'Slēgta josla',                group: 'closure',  ttl: 240, report: true },
  'object':         { label: 'Priekšmets uz ceļa',          group: 'hazard',   ttl: 60,  report: true },
  'pothole':        { label: 'Bedre uz ceļa',               group: 'hazard',   ttl: 4320, report: true },
  'stopped-vehicle':{ label: 'Apstājies transportlīdzeklis', group: 'hazard',  ttl: 60,  report: true },
  'signal-broken':  { label: 'Bojāts luksofors',            group: 'hazard',   ttl: 240, report: true },
  'hazard':         { label: 'Bīstama vieta',               group: 'hazard',   ttl: 120, report: true },
  'weather':        { label: 'Lietus / slikti laikapstākļi', group: 'weather', ttl: 120, report: true },
  'fog':            { label: 'Migla',                       group: 'weather',  ttl: 120, report: true },
  'flood':          { label: 'Plūdi',                       group: 'weather',  ttl: 360, report: true },
  'ice':            { label: 'Apledojums / slidens ceļš',   group: 'weather',  ttl: 240, report: true },
  'rain':           { label: 'Stiprs lietus',               group: 'weather',  ttl: 60 },   // ziņo ar „Lietus / slikti laikapstākļi”; šo dod laika prognoze
  'snow':           { label: 'Sniegs',                      group: 'weather',  ttl: 180, report: true },
  'rail':           { label: 'Dzelzceļa pārbrauktuve',      group: 'infra',    ttl: null },
  'traffic-light':  { label: 'Luksofors',                   group: 'infra',    ttl: null },
  'school':         { label: 'Skolas zona / bērni',         group: 'infra',    ttl: null },
  'restriction':    { label: 'Satiksmes ierobežojums',      group: 'restriction', ttl: null },
  'obstacle':       { label: 'Šķērslis uz ceļa',            group: 'hazard',   ttl: 120, report: true },
};

// Ziņošanas grupas (kartes pogas): satiksmes notikumi un bīstamības / laikapstākļi.
const REPORT_GROUPS = {
  traffic: ['police', 'police-hidden', 'camera-fixed', 'camera-mobile', 'accident', 'jam', 'roadworks', 'closure', 'lane-closed'],
  hazard: ['hazard', 'object', 'pothole', 'stopped-vehicle', 'signal-broken', 'obstacle', 'ice', 'fog', 'snow', 'flood', 'weather'],
};

// Simboli 24×24 koordinātās. W — balts, C — grupas krāsa (detaļām), D — tumšs.
// Ikona: krāsains aplis ar gradientu un spīdumu, balta mala, maiga ēna (izskatās kā "pogas emblēma").
// ---------- Marķieri: vienota "premium" vizuālā valoda ----------
// Katram veidam — identitātes krāsa un minimālistisks balts simbols (24×24). Marķieris: aplis ar maigu
// gradientu, plānu baltu malu un smalku spīdumu; īsa smaile uz leju; zem tās — tās pašas krāsas punkts
// tieši notikuma vietā (no šī punkta ikona "izaug", tuvinot karti). Bez fotoreālisma un biezām kontūrām.

// Svarīguma secība (apvienojot punktus, rāda svarīgākā krāsu) un identitātes krāsas.
const ALERT_ORDER = ['police', 'police-hidden', 'camera-fixed', 'camera-mobile', 'accident', 'closure', 'lane-closed',
  'obstacle', 'roadworks', 'hazard', 'object', 'pothole', 'stopped-vehicle', 'signal-broken', 'ice', 'flood', 'fog',
  'snow', 'rain', 'weather', 'jam', 'rail', 'school', 'restriction', 'traffic-light'];
const ALERT_COLOR = {
  'police': '#3d6cf5', 'police-hidden': '#3d6cf5',
  'camera-fixed': '#6c5cf2', 'camera-mobile': '#6c5cf2',
  'accident': '#ef4352', 'jam': '#e2336f',
  'closure': '#f2522e', 'lane-closed': '#f2522e', 'obstacle': '#f2522e', 'roadworks': '#f7891c',
  'hazard': '#eea000', 'object': '#eea000', 'pothole': '#eea000', 'stopped-vehicle': '#eea000', 'signal-broken': '#eea000',
  'weather': '#1f9be6', 'rain': '#2a86ef', 'snow': '#38b6f0', 'ice': '#30a9e0', 'fog': '#7787a0', 'flood': '#1b70e8',
  'rail': '#d23f4a', 'school': '#15a86a', 'restriction': '#8a5cf0', 'traffic-light': '#2c3542',
};
// Punktiem attālinātā kartē — tumšajam luksoforam gaišāka krāsa (citādi uz tumšas kartes nav redzams)
const ALERT_DOT_COLOR = { 'traffic-light': '#8394ab' };
function alertDotColor(type) { return ALERT_DOT_COLOR[type] || ALERT_COLOR[type] || ALERT_COLOR.hazard; }
function alertColor(type) { return ALERT_COLOR[type] || ALERT_COLOR.hazard; }
function alertCode(type) { const i = ALERT_ORDER.indexOf(type); return i < 0 ? ALERT_ORDER.indexOf('hazard') : i; }
// MapLibre izteiksme: kods → krāsa (arī apvienotajiem punktiem, kuriem kods = mazākais/svarīgākais)
function alertCodeColorExpr() {
  const m = ['match', ['get', 'code']];
  ALERT_ORDER.forEach((t, i) => m.push(i, alertDotColor(t)));
  m.push(ALERT_COLOR.hazard);
  return m;
}

// Simboli: balti (W), izgriezumi — marķiera krāsā (C). Tīras ģeometriskas formas, noapaļoti gali.
const ALERT_W = '#fff';
const RJ = 'stroke-linecap="round" stroke-linejoin="round"';
const ALERT_GLYPHS = {
  'police': C => `<path d="M12 2.6 19.2 5.3v5.6c0 4.6-3 8.3-7.2 10.4-4.2-2.1-7.2-5.8-7.2-10.4V5.3Z" fill="${ALERT_W}"/>` +
    `<path d="m12 7.4 1.3 2.7 3 .4-2.2 2.1.5 3-2.6-1.4-2.6 1.4.5-3-2.2-2.1 3-.4Z" fill="${C}"/>`,
  'police-hidden': C => `<path d="M12 2.6 19.2 5.3v5.6c0 4.6-3 8.3-7.2 10.4-4.2-2.1-7.2-5.8-7.2-10.4V5.3Z" fill="${ALERT_W}"/>` +
    `<path d="M7.6 11.6c2.4-3.4 6.4-3.4 8.8 0-2.4 3.4-6.4 3.4-8.8 0Z" fill="${C}"/><circle cx="12" cy="11.6" r="1.5" fill="${ALERT_W}"/>`,
  'camera-fixed': C => `<rect x="2.5" y="6.5" width="14" height="11" rx="2.6" fill="${ALERT_W}"/><circle cx="8.6" cy="12" r="3.3" fill="${C}"/>` +
    `<circle cx="8.6" cy="12" r="1.3" fill="${ALERT_W}"/><rect x="12.2" y="8.6" width="2.6" height="1.8" rx=".6" fill="${C}"/>` +
    `<path d="M19 9.2a4 4 0 0 1 0 5.6M21.4 7a7.2 7.2 0 0 1 0 10" stroke="${ALERT_W}" stroke-width="1.7" fill="none" ${RJ}/>`,
  'camera-mobile': C => `<rect x="4" y="3.5" width="13" height="9.5" rx="2.4" fill="${ALERT_W}"/><circle cx="9.5" cy="8.2" r="2.8" fill="${C}"/>` +
    `<circle cx="9.5" cy="8.2" r="1.1" fill="${ALERT_W}"/><path d="M17 6.6 20.5 5v6.4L17 9.8Z" fill="${ALERT_W}" ${RJ}/>` +
    `<path d="M10.5 13v8M10.5 15 6 21M10.5 15l4.5 6" stroke="${ALERT_W}" stroke-width="1.8" fill="none" ${RJ}/>`,
  'accident': C => `<path d="M2.5 19v-3.8l1.8-4.5a2.4 2.4 0 0 1 2.2-1.5h6a2.4 2.4 0 0 1 2.2 1.5l1.8 4.5V19Z" fill="${ALERT_W}"/>` +
    `<path d="M6.2 11.8h7.1l1.1 3H5.1Z" fill="${C}"/><circle cx="6" cy="16.9" r="1.1" fill="${C}"/><circle cx="13.5" cy="16.9" r="1.1" fill="${C}"/>` +
    `<rect x="3.4" y="18.5" width="2.6" height="2.4" rx=".8" fill="${ALERT_W}"/><rect x="13.5" y="18.5" width="2.6" height="2.4" rx=".8" fill="${ALERT_W}"/>` +
    `<path d="m18.7 2.4 1.1 2.6 2.7-.7-1.5 2.4 2.1 1.7-2.8.3-.2 2.8-1.9-2-2.1 1.8.4-2.8-2.7-.6 2.4-1.4-.9-2.7 2.5 1.1Z" fill="${ALERT_W}" ${RJ}/>`,
  'jam': C => `<path d="M2.6 12.4v-2.5l1.1-2.7a1.7 1.7 0 0 1 1.6-1.1h4.4a1.7 1.7 0 0 1 1.6 1.1l1.1 2.7v2.5Z" fill="${ALERT_W}"/>` +
    `<path d="M8.8 20.2v-3.1l1.3-3.2a1.9 1.9 0 0 1 1.8-1.3h5.5a1.9 1.9 0 0 1 1.8 1.3l1.3 3.2v3.1Z" fill="${ALERT_W}" stroke="${C}" stroke-width="1.4"/>` +
    `<path d="M11.6 14.6h7.2l.9 2.4h-9Z" fill="${C}"/><circle cx="11.5" cy="18.6" r="1" fill="${C}"/><circle cx="18.9" cy="18.6" r="1" fill="${C}"/>`,
  'roadworks': C => `<path d="M10.7 3.3a1.4 1.4 0 0 1 2.6 0L18 17.2H6Z" fill="${ALERT_W}"/>` +
    `<path d="M9.3 8.8h5.4l1 3H8.3ZM7.6 14h8.8" stroke="${C}" stroke-width="1.6" fill="${C}" ${RJ}/>` +
    `<rect x="3.5" y="17.6" width="17" height="3" rx="1.4" fill="${ALERT_W}"/>`,
  'closure': C => `<circle cx="12" cy="12" r="8.8" fill="${ALERT_W}"/><rect x="6.6" y="10.4" width="10.8" height="3.2" rx="1.6" fill="${C}"/>`,
  'lane-closed': C => `<path d="M4 3.5v17M20 3.5v17" stroke="${ALERT_W}" stroke-width="2.4" ${RJ}/>` +
    `<circle cx="12" cy="12" r="6.2" fill="${ALERT_W}"/><path d="m9.6 9.6 4.8 4.8m0-4.8-4.8 4.8" stroke="${C}" stroke-width="2" ${RJ}/>`,
  'obstacle': C => `<path d="M6.5 14.5v6M17.5 14.5v6" stroke="${ALERT_W}" stroke-width="2" ${RJ}/><rect x="2.8" y="8" width="18.4" height="6.6" rx="1.8" fill="${ALERT_W}"/>` +
    `<path d="M7.2 8.4 4.4 14.2M12.2 8.4l-2.8 5.8M17.2 8.4l-2.8 5.8" stroke="${C}" stroke-width="1.8"/><circle cx="6.5" cy="5.4" r="1.6" fill="${ALERT_W}"/><circle cx="17.5" cy="5.4" r="1.6" fill="${ALERT_W}"/>`,
  'object': C => `<path d="M12 3.4 19.6 7.4v9.2L12 20.6 4.4 16.6V7.4Z" fill="${ALERT_W}" ${RJ}/><path d="M4.6 7.5 12 11.5l7.4-4M12 11.5v8.9" stroke="${C}" stroke-width="1.3" fill="none" ${RJ}/>`,
  'pothole': C => `<path d="M3 15c0-2.4 4-4.2 9-4.2s9 1.8 9 4.2-4 4.2-9 4.2-9-1.8-9-4.2Z" fill="${ALERT_W}"/><path d="M6.6 15c0-1.3 2.4-2.3 5.4-2.3s5.4 1 5.4 2.3-2.4 2.4-5.4 2.4-5.4-1.1-5.4-2.4Z" fill="${C}"/>` +
    `<path d="M12 3.6v4.6m-2.1-2.1L12 8.2l2.1-2.1" stroke="${ALERT_W}" stroke-width="1.9" fill="none" ${RJ}/>`,
  'stopped-vehicle': C => `<path d="M2.6 19v-3l1.4-3.6a2 2 0 0 1 1.9-1.3h5.2a2 2 0 0 1 1.9 1.3l1.4 3.6v3Z" fill="${ALERT_W}"/><path d="M5.6 13.2h5.4l.8 2.3H4.8Z" fill="${C}"/>` +
    `<path d="M17.7 3.6a.9.9 0 0 1 1.6 0l3.3 6.4a.9.9 0 0 1-.8 1.3h-6.6a.9.9 0 0 1-.8-1.3Z" fill="${ALERT_W}"/><path d="M18.5 6v2.4" stroke="${C}" stroke-width="1.4" ${RJ}/><circle cx="18.5" cy="9.6" r=".7" fill="${C}"/>`,
  'signal-broken': C => `<rect x="7.8" y="2.8" width="8.4" height="17.5" rx="3.4" fill="${ALERT_W}"/><circle cx="12" cy="7" r="1.8" fill="${C}"/><circle cx="12" cy="11.5" r="1.8" fill="${C}"/><circle cx="12" cy="16" r="1.8" fill="${C}"/>` +
    `<path d="M4 4l16 16" stroke="${C}" stroke-width="4.2" ${RJ}/><path d="M4 4l16 16" stroke="${ALERT_W}" stroke-width="2" ${RJ}/>`,
  'hazard': C => `<path d="M10.4 4.2a1.9 1.9 0 0 1 3.2 0l7.4 13.1a1.9 1.9 0 0 1-1.6 2.8H4.6A1.9 1.9 0 0 1 3 17.3Z" fill="${ALERT_W}"/>` +
    `<path d="M12 9.3v4.6" stroke="${C}" stroke-width="2.2" ${RJ}/><circle cx="12" cy="16.9" r="1.25" fill="${C}"/>`,
  'weather': C => `<path d="M6.9 16.4a4.4 4.4 0 0 1-.5-8.8 6 6 0 0 1 11.3 1.1 3.9 3.9 0 0 1-.4 7.7Z" fill="${ALERT_W}"/><path d="m12.6 10.6-2.4 4.4h3.1l-2.3 4.2" stroke="${C}" stroke-width="1.7" fill="none" ${RJ}/>`,
  'fog': C => `<path d="M7 9.4a4 4 0 0 1 7.6-1.6A3.4 3.4 0 0 1 19 10" stroke="${ALERT_W}" stroke-width="1.9" fill="none" ${RJ}/><path d="M4 13h16M5.5 16.4h13M7.5 19.8h9" stroke="${ALERT_W}" stroke-width="2" ${RJ}/>`,
  'flood': C => `<path d="M7.4 9.6 12 5.4l4.6 4.2v2.4H7.4Z" fill="${ALERT_W}" ${RJ}/><path d="M3.5 14.6c2.1-1.5 4.1 1.5 6.2 0s4.1 1.5 6.2 0 4.1 1.5 5.6 0M3.5 18.8c2.1-1.5 4.1 1.5 6.2 0s4.1 1.5 6.2 0 4.1 1.5 5.6 0" stroke="${ALERT_W}" stroke-width="1.9" fill="none" ${RJ}/>`,
  'ice': C => `<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" stroke="${ALERT_W}" stroke-width="1.8" ${RJ}/><path d="M9.8 4.6 12 6.6l2.2-2M9.8 19.4l2.2-2 2.2 2" stroke="${ALERT_W}" stroke-width="1.4" fill="none" ${RJ}/><circle cx="12" cy="12" r="2.4" fill="${ALERT_W}"/>`,
  'rain': C => `<path d="M6.8 13.4a4.3 4.3 0 0 1-.5-8.6 5.9 5.9 0 0 1 11 1 3.9 3.9 0 0 1-.4 7.6Z" fill="${ALERT_W}"/><path d="M8.2 16.4 7 19.8M12.4 16.4l-1.2 3.4M16.6 16.4l-1.2 3.4" stroke="${ALERT_W}" stroke-width="2.4" ${RJ}/>`,
  'snow': C => `<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" stroke="${ALERT_W}" stroke-width="1.9" ${RJ}/><path d="M9.7 4.6 12 6.6l2.3-2M9.7 19.4 12 17.4l2.3 2M5 10.9l2.9-.9-.6-3M19 13.1l-2.9.9.6 3M5 13.1l2.9.9-.6 3M19 10.9l-2.9-.9.6-3" stroke="${ALERT_W}" stroke-width="1.4" fill="none" ${RJ}/>`,
  'rail': C => `<path d="M4.5 6 19.5 18M19.5 6 4.5 18" stroke="${ALERT_W}" stroke-width="4" ${RJ}/>`,
  'traffic-light': C => `<rect x="7.4" y="2.2" width="9.2" height="19.6" rx="3.8" fill="${ALERT_W}"/>` +
    `<circle cx="12" cy="7" r="2.15" fill="#ff5b57"/><circle cx="12" cy="12" r="2.15" fill="#ffbf2e"/><circle cx="12" cy="17" r="2.15" fill="#2fd27a"/>`,
  'school': C => `<circle cx="8.4" cy="4.8" r="2.1" fill="${ALERT_W}"/><circle cx="16" cy="7.6" r="1.8" fill="${ALERT_W}"/>` +
    `<path d="M8.4 8v6.2m0 0-2.3 6m2.3-6 2.5 6M5.4 11.4 8.4 9l3.1 2.4" stroke="${ALERT_W}" stroke-width="2" fill="none" ${RJ}/>` +
    `<path d="M16 10.5v4.8m0 0-1.8 5m1.8-5 1.9 5M13.6 13.4l2.4-2 2.6 2" stroke="${ALERT_W}" stroke-width="1.8" fill="none" ${RJ}/>`,
  'restriction': C => `<circle cx="12" cy="12" r="8.6" fill="${ALERT_W}"/><path d="M12 7.6V12l2.8 1.9" stroke="${C}" stroke-width="1.8" fill="none" ${RJ}/>` +
    `<path d="M6.2 6.2l11.6 11.6" stroke="${C}" stroke-width="3.6" ${RJ}/><path d="M6.2 6.2l11.6 11.6" stroke="${ALERT_W}" stroke-width="1.6" ${RJ}/>`,
};

function alertMix(hex, to, k) {
  const n = parseInt(hex.slice(1), 16), t = to === 'w' ? 255 : 0;
  const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(v + (t - v) * k));
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
}
// Katra simbola optiskais izmērs burbulī (mērogs, nobīde x, y): simboli ~1,5× lielāki, katrs pielāgots savai
// formai (apaļie — mazāk, iegarenie/plānie — vairāk), lai visi izskatītos vienlīdz lieli un atpazīstami mazā izmērā.
const ALERT_GLYPH_FIT = {
  'police': [1.392, 19.3, 10.37], 'police-hidden': [1.392, 19.3, 10.37], 'camera-fixed': [1.346, 18.56, 10.85],
  'camera-mobile': [1.367, 19.26, 10.26], 'accident': [1.256, 19.93, 12.37], 'jam': [1.439, 19.38, 8.08],
  'roadworks': [1.323, 20.12, 11.77], 'closure': [1.462, 18.45, 9.45], 'lane-closed': [1.406, 19.13, 10.13],
  'obstacle': [1.325, 20.1, 10.9], 'object': [1.428, 18.86, 9.86], 'pothole': [1.379, 19.45, 11.28],
  'stopped-vehicle': [1.378, 18.57, 11.77], 'signal-broken': [1.44, 18.71, 10.36], 'hazard': [1.321, 20.16, 11.54],
  'weather': [1.373, 20.18, 11.02], 'fog': [1.554, 17.35, 7.31], 'flood': [1.444, 17.95, 9.22],
  'ice': [1.6, 16.8, 7.8], 'rain': [1.339, 21.02, 12.76], 'snow': [1.6, 16.8, 7.8],
  'rail': [1.553, 17.36, 8.36], 'traffic-light': [1.432, 18.82, 9.82], 'school': [1.547, 17.44, 9.21],
  'restriction': [1.495, 18.07, 9.07],
};
// Marķiera forma: aplis ar baltu malu un īsu "runas burbuļa" asti apakšā pa kreisi.
// Astes gals (11,54.5) — tieši notikuma vieta (kartē: enkurs apakšā pa kreisi + nobīde).
const ALERT_PIN = 'M36 3A24 24 0 1 1 22.2 46.7L11 54.5 15.2 39A24 24 0 0 1 36 3Z';
const ALERT_STANDALONE = new Set(['traffic-light']);   // bez burbuļa — pats objekts uz ceļa (enkurs centrā)
function alertSvg(type, size = 64) {
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64"><defs>` +
    `<filter id="s" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur in="SourceAlpha" stdDeviation="1.5"/><feOffset dy="1.4"/>` +
    `<feComponentTransfer><feFuncA type="linear" slope=".3"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
  if (type === 'traffic-light') {
    // Luksofors: kompakts tumši zils korpuss (bez baltas malas) ar trim spilgtām lampām (bez staba)
    const lampDef = (id, c0, c1) => `<radialGradient id="${id}" cx=".4" cy=".35" r=".7"><stop offset="0" stop-color="${c0}"/><stop offset="1" stop-color="${c1}"/></radialGradient>`;
    return head + lampDef('lr', '#ff8a8a', '#f2484f') + lampDef('ly', '#ffe27a', '#f7c21c') + lampDef('lg', '#6ff0a6', '#22c46a') +
      `<linearGradient id="b" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2c3a50"/><stop offset="1" stop-color="#1a2536"/></linearGradient></defs>` +
      `<g filter="url(#s)"><rect x="16.5" y="2.5" width="31" height="59" rx="10.5" fill="url(#b)"/></g>` +
      `<rect x="20" y="6" width="4.6" height="52" rx="2.3" fill="#fff" opacity=".07"/>` +
      [[14.6, 'lr'], [32, 'ly'], [49.4, 'lg']].map(([cy, id]) =>
        `<circle cx="32" cy="${cy}" r="8.4" fill="url(#${id})"/><ellipse cx="29.6" cy="${cy - 2.9}" rx="3.1" ry="1.9" fill="#fff" opacity=".45"/>`).join('') +
      `</svg>`;
  }
  const c = alertColor(type), hi = alertMix(c, 'w', 0.22), lo = alertMix(c, 'k', 0.16);
  const glyph = (ALERT_GLYPHS[type] || ALERT_GLYPHS.hazard)(alertMix(c, 'k', 0.04));
  const fit = ALERT_GLYPH_FIT[type] || ALERT_GLYPH_FIT.hazard;
  return head +
    `<linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hi}"/><stop offset=".55" stop-color="${c}"/><stop offset="1" stop-color="${lo}"/></linearGradient>` +
    `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".34"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
    `<filter id="d" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur in="SourceAlpha" stdDeviation=".45"/><feOffset dy=".45"/>` +
    `<feComponentTransfer><feFuncA type="linear" slope=".22"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>` +
    // radariem — maigs violets mirdzums ap marķieri (svarīga brīdinājumu kategorija, nedaudz izceļas)
    (type === 'camera-fixed' || type === 'camera-mobile' ? `<filter id="rg" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="2.6"/></filter><circle cx="36" cy="27" r="24.5" fill="${hi}" opacity=".55" filter="url(#rg)"/>` : '') +
    `<g filter="url(#s)"><path d="${ALERT_PIN}" fill="#fff"/><circle cx="36" cy="27" r="20.6" fill="url(#f)"/></g>` +
    `<path d="M18.4 23A18 18 0 0 1 53.6 23C48.8 19.6 43 18.2 36 18.2S23.2 19.6 18.4 23Z" fill="url(#g)"/>` +
    `<circle cx="36" cy="27" r="19.9" fill="none" stroke="#fff" stroke-width=".7" opacity=".28"/>` +
    `<g filter="url(#d)" transform="translate(${fit[1]} ${fit[2]}) scale(${fit[0]})">${glyph}</g></svg>`;
}
const alertUrlCache = new Map();
function alertDataUrl(type) {
  if (!alertUrlCache.has(type)) alertUrlCache.set(type, 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(alertSvg(type, 128)));
  return alertUrlCache.get(type);
}

// Kura zīme / OSM objekts ir brīdinājums? (null — tas nav brīdinājums, kartē nerāda)
// now — laika ierobežojumiem: rāda tikai, ja tie ŠOBRĪD ir spēkā.
function alertTypeForSign(s, now = new Date()) {
  if (!s) return null;
  if (s.cat === 'camera') return 'camera-fixed';
  if (s.cat === 'rail') return 'rail';
  if (s.cat === 'signals') return 'traffic-light';
  const v = s.value || '';
  if (/^warning--(children|school)|school-zone/.test(v)) return 'school';
  if (s.timeRule && s.timeRule.cond && s.timeRule.cond.test(now) === true) return 'restriction';
  return null;
}

// Kurām zīmēm vajag noteikt virzienu (Mapillary ir lēns, tāpēc tikai tām, ko aplikācija
// tiešām izmanto): ātruma ierobežojumi (rāda pašreizējo atļauto ātrumu), kameras, dzelzceļa
// pārbrauktuves, luksofori, bērni/skola un zīmes ar laika nosacījumu. Pārējās (stāvvieta,
// informācija, virzieni u.c.) brīdinājumu režīmā netiek rādītas — tām virzienu nemeklē.
function signNeedsDirection(s) {
  if (!s) return false;
  if (s.cat === 'speed' || s.cat === 'camera' || s.cat === 'rail' || s.cat === 'signals') return true;
  if (/^warning--(children|school)|school-zone/.test(s.value || '')) return true;
  return !!(s.timeRule && s.timeRule.cond);
}

// OSM hazard=* → brīdinājuma veids
const OSM_HAZARD = {
  school_zone: 'school', children: 'school', ice: 'ice', icy_road: 'ice', slippery: 'ice', flooding: 'flood',
  fog: 'fog', falling_rocks: 'hazard', animal_crossing: 'hazard', curve: 'hazard', curves: 'hazard',
  dangerous_junction: 'hazard', bump: 'hazard', road_narrows: 'hazard', queues_likely: 'jam',
};
function alertTypeForOsm(tags) {
  if (!tags) return null;
  if (tags.highway === 'construction' || (tags.construction && tags.highway)) return 'roadworks';
  if (tags.hazard) return OSM_HAZARD[tags.hazard] || 'hazard';
  return null;
}

// Laikapstākļi (Open-Meteo "current"): → [{ type, text }]. Tikai tas, ko rāda dati.
// precipitation/rain/showers — mm 15 minūtēs; snowfall — cm; visibility — m; wind_gusts_10m — m/s.
function weatherAlerts(cur) {
  if (!cur) return [];
  const out = [], code = cur.weather_code;
  const rainMmH = ((cur.rain || 0) + (cur.showers || 0)) * 4;
  if ([45, 48].includes(code) || (cur.visibility != null && cur.visibility < 1000)) {
    out.push({ type: 'fog', text: cur.visibility != null && cur.visibility < 5000 ? `Migla · redzamība ${Math.round(cur.visibility / 50) * 50} m` : 'Migla' });
  }
  if ([56, 57, 66, 67].includes(code) || (cur.temperature_2m != null && cur.temperature_2m <= 0.5 && (cur.precipitation || 0) > 0)) {
    out.push({ type: 'ice', text: `Slidens ceļš · ${Math.round(cur.temperature_2m)} °C` });
  }
  if ((cur.snowfall || 0) > 0 || [71, 73, 75, 77, 85, 86].includes(code)) out.push({ type: 'snow', text: 'Snieg' });
  if (rainMmH >= 4 || [65, 82].includes(code)) out.push({ type: 'rain', text: `Stiprs lietus${rainMmH ? ' · ~' + Math.round(rainMmH) + ' mm/h' : ''}` });
  if ([95, 96, 99].includes(code) || (cur.wind_gusts_10m || 0) >= 20) {
    out.push({ type: 'weather', text: [95, 96, 99].includes(code) ? 'Pērkona negaiss' : `Stiprs vējš · brāzmas ${Math.round(cur.wind_gusts_10m)} m/s` });
  }
  return out;
}

// ---------- Notikumu krātuve (lietotāja ziņojumi, OSM objekti) ----------
// item: { id, type, lat, lng, heading, source: 'user'|'osm', title, info, createdAt, expiresAt }
class AlertStore {
  constructor(persist) {
    this.items = new Map();
    this.persist = persist || null;   // { load(): [], save(list) }
    if (this.persist) for (const it of this.persist.load() || []) this.items.set(it.id, it);
    this.prune();
  }
  add(it) {
    this.items.set(it.id, it);
    if (it.source === 'user') this._save();
    return it;
  }
  remove(id) { const it = this.items.get(id); this.items.delete(id); if (it && it.source === 'user') this._save(); }
  // Noņem novecojušos (expiresAt pagātnē). Atgriež, vai kaut kas mainījās.
  prune(now = Date.now()) {
    let changed = false;
    for (const [id, it] of this.items) if (it.expiresAt && it.expiresAt <= now) { this.items.delete(id); changed = true; }
    if (changed) this._save();
    return changed;
  }
  list(now = Date.now()) { return [...this.items.values()].filter(it => !it.expiresAt || it.expiresAt > now); }
  _save() { if (this.persist) this.persist.save([...this.items.values()].filter(it => it.source === 'user')); }
}

// Lietotāja ziņojums ar derīguma laiku pēc veida.
function makeReport(type, lat, lng, heading, now = Date.now()) {
  const t = ALERT_TYPES[type];
  if (!t || !t.report) throw new Error('Nezināms ziņojuma veids: ' + type);
  return { id: 'user:' + now.toString(36) + Math.random().toString(36).slice(2, 6), type, lat, lng,
    heading: heading == null ? null : Math.round(heading), source: 'user', title: t.label,
    createdAt: now, expiresAt: now + t.ttl * 60000 };
}

function ago(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'tikko';
  if (m < 60) return `pirms ${m} min`;
  return `pirms ${Math.floor(m / 60)} h ${m % 60} min`;
}
function alertInfo(it, now = Date.now()) {
  if (it.source === 'user') {
    const left = Math.max(0, Math.round((it.expiresAt - now) / 60000));
    return `Tavs ziņojums · ${ago(now - it.createdAt)} · pazudīs pēc ${left} min. Redzams tikai šajā ierīcē.`;
  }
  if (it.source === 'osm') return (it.info ? it.info + ' · ' : '') + 'Avots: OpenStreetMap';
  return it.info || '';
}

if (typeof module !== 'undefined') {
  module.exports = { ALERT_TYPES, REPORT_GROUPS, alertSvg, ALERT_STANDALONE, alertDotColor, alertCode, alertCodeColorExpr, ALERT_ORDER, alertTypeForSign, signNeedsDirection, alertTypeForOsm, weatherAlerts, AlertStore, makeReport, alertInfo };
}
