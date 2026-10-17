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
  'camera-mobile':  { label: 'Mobilais fotoradars',         group: 'camera',   ttl: 120, report: true },
  'camera-fixed':   { label: 'Ātruma kamera',               group: 'camera',   ttl: null },
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
  'weather':        { label: 'Slikti laikapstākļi',         group: 'weather',  ttl: 120, report: true },
  'fog':            { label: 'Migla',                       group: 'weather',  ttl: 120, report: true },
  'flood':          { label: 'Plūdi',                       group: 'weather',  ttl: 360, report: true },
  'ice':            { label: 'Apledojums / slidens ceļš',   group: 'weather',  ttl: 240, report: true },
  'rain':           { label: 'Stiprs lietus',               group: 'weather',  ttl: 60,  report: true },
  'snow':           { label: 'Sniegs',                      group: 'weather',  ttl: 180, report: true },
  'rail':           { label: 'Dzelzceļa pārbrauktuve',      group: 'infra',    ttl: null },
  'traffic-light':  { label: 'Luksofors',                   group: 'infra',    ttl: null },
  'school':         { label: 'Skolas zona / bērni',         group: 'infra',    ttl: null },
  'restriction':    { label: 'Satiksmes ierobežojums',      group: 'restriction', ttl: null },
  'obstacle':       { label: 'Šķērslis uz ceļa',            group: 'hazard',   ttl: 120, report: true },
};

// Ziņošanas grupas (kartes pogas): satiksmes notikumi un bīstamības / laikapstākļi.
const REPORT_GROUPS = {
  traffic: ['police', 'police-hidden', 'camera-mobile', 'accident', 'jam', 'roadworks', 'closure', 'lane-closed'],
  hazard: ['hazard', 'object', 'pothole', 'stopped-vehicle', 'signal-broken', 'obstacle', 'ice', 'fog', 'rain', 'snow', 'flood', 'weather'],
};

// Simboli 24×24 koordinātās. W — balts, C — grupas krāsa (detaļām), D — tumšs.
// Ikona: krāsains aplis ar gradientu un spīdumu, balta mala, maiga ēna (izskatās kā "pogas emblēma").
const ALERT_W = '#fff';
const ALERT_D = '#0f172a';
const RJ = 'stroke-linecap="round" stroke-linejoin="round"';
const ALERT_GLYPHS = {
  'police': C => `<path d="M12 2.2 19.6 5v6c0 4.9-3.2 8.8-7.6 10.8C7.6 19.8 4.4 15.9 4.4 11V5Z" fill="${ALERT_W}"/>` +
    `<path d="M12 4.6 17.4 6.6v4.5c0 3.6-2.2 6.6-5.4 8.3-3.2-1.7-5.4-4.7-5.4-8.3V6.6Z" fill="none" stroke="${C}" stroke-width=".9" opacity=".45"/>` +
    `<path d="m12 7.3 1.35 2.75 3.03.44-2.19 2.14.52 3.02L12 14.23l-2.71 1.42.52-3.02-2.19-2.14 3.03-.44Z" fill="${C}"/>`,
  'police-hidden': C => `<path d="M12 2.2 19.6 5v6c0 4.9-3.2 8.8-7.6 10.8C7.6 19.8 4.4 15.9 4.4 11V5Z" fill="${ALERT_W}"/>` +
    `<path d="M6.8 11.6c2.9-4.1 7.5-4.1 10.4 0-2.9 4.1-7.5 4.1-10.4 0Z" fill="${C}"/><circle cx="12" cy="11.6" r="2.1" fill="${ALERT_W}"/><circle cx="12" cy="11.6" r="1" fill="${C}"/>`,
  'camera-mobile': C => `<rect x="3" y="5" width="14" height="9.5" rx="2.2" fill="${ALERT_W}"/>` +
    `<circle cx="9.6" cy="9.75" r="3.3" fill="${C}"/><circle cx="9.6" cy="9.75" r="1.6" fill="#93c5fd"/><circle cx="8.9" cy="9" r=".6" fill="#fff"/>` +
    `<path d="M17 8.2 21.2 6v7.5L17 11.3Z" fill="${ALERT_W}" ${RJ}/><path d="M7 14.5 4.6 21M13 14.5l2.4 6.5M10 14.5V21" stroke="${ALERT_W}" stroke-width="1.9" ${RJ}/>`,
  'camera-fixed': C => `<rect x="10.6" y="15" width="2.8" height="7" rx="1" fill="${ALERT_W}"/>` +
    `<rect x="4" y="3.5" width="16" height="12.5" rx="2.6" fill="${ALERT_W}"/>` +
    `<circle cx="10.5" cy="9.75" r="4.1" fill="${C}"/><circle cx="10.5" cy="9.75" r="2.5" fill="#60a5fa"/><circle cx="10.5" cy="9.75" r="1.2" fill="${ALERT_D}"/><circle cx="9.4" cy="8.6" r=".7" fill="#fff"/>` +
    `<rect x="15.6" y="5.6" width="2.6" height="2" rx=".6" fill="#facc15"/><rect x="15.6" y="9" width="2.6" height="5" rx=".6" fill="${C}" opacity=".35"/>`,
  'accident': C => `<path d="M3.5 17.5v-3.2l1.7-4.3A2.2 2.2 0 0 1 7.2 8.6h5.6a2.2 2.2 0 0 1 2 1.4l1.7 4.3v3.2Z" fill="${ALERT_W}"/>` +
    `<path d="M6.6 10.4h6.8l1.1 3H5.5Z" fill="${C}" opacity=".55"/><rect x="4.2" y="17" width="2.6" height="2.6" rx=".8" fill="${ALERT_W}"/><rect x="13.2" y="17" width="2.6" height="2.6" rx=".8" fill="${ALERT_W}"/>` +
    `<circle cx="6.2" cy="15.2" r="1" fill="${C}"/><circle cx="13.8" cy="15.2" r="1" fill="${C}"/>` +
    `<path d="m18.6 2.5.9 2.6 2.5-.9-1.3 2.4 2.3 1.4-2.7.4.3 2.7-2-1.8-1.9 1.9.2-2.7-2.7-.3 2.2-1.5-1.4-2.3 2.6.8Z" fill="#facc15" stroke="${ALERT_W}" stroke-width=".8" ${RJ}/>`,
  'jam': C => `<g fill="${ALERT_W}"><path d="M2.5 14v-2.4l1.1-2.8a1.6 1.6 0 0 1 1.5-1h4a1.6 1.6 0 0 1 1.5 1l1.1 2.8V14Z"/><rect x="3" y="13.6" width="2" height="2" rx=".6"/><rect x="9.6" y="13.6" width="2" height="2" rx=".6"/>` +
    `<path d="M11.5 19v-2.4l1.1-2.8a1.6 1.6 0 0 1 1.5-1h4a1.6 1.6 0 0 1 1.5 1l1.1 2.8V19Z"/><rect x="12" y="18.6" width="2" height="2" rx=".6"/><rect x="18.6" y="18.6" width="2" height="2" rx=".6"/></g>` +
    `<circle cx="4.6" cy="12.3" r=".9" fill="#ef4444"/><circle cx="10" cy="12.3" r=".9" fill="#ef4444"/><circle cx="13.6" cy="17.3" r=".9" fill="#ef4444"/><circle cx="19" cy="17.3" r=".9" fill="#ef4444"/>` +
    `<path d="M14 4.5h6M16 7.5h4" stroke="${ALERT_W}" stroke-width="1.6" ${RJ} opacity=".8"/>`,
  'roadworks': C => `<path d="M10.6 3.4a1.5 1.5 0 0 1 2.8 0L18.3 18H5.7Z" fill="${ALERT_W}"/>` +
    `<path d="M8.9 9.2h6.2l1 3H7.9ZM7.3 14h9.4l.8 2.4H6.5Z" fill="${C}"/>` +
    `<rect x="3.2" y="18" width="17.6" height="3" rx="1.3" fill="${ALERT_W}"/>`,
  'closure': C => `<circle cx="12" cy="12" r="9" fill="${ALERT_W}"/><circle cx="12" cy="12" r="7.3" fill="${C}"/><rect x="6.3" y="10.3" width="11.4" height="3.4" rx="1.1" fill="${ALERT_W}"/>`,
  'lane-closed': C => `<path d="M5 3v18M19 3v18" stroke="${ALERT_W}" stroke-width="2" ${RJ}/><path d="M12 3v3M12 10v4M12 18v3" stroke="${ALERT_W}" stroke-width="1.6" ${RJ} opacity=".6"/>` +
    `<circle cx="15.5" cy="12" r="4.6" fill="${ALERT_W}"/><path d="m13.7 10.2 3.6 3.6m0-3.6-3.6 3.6" stroke="${C}" stroke-width="1.8" ${RJ}/>`,
  'object': C => `<path d="M12 3.2 20 7.4v9.2l-8 4.2-8-4.2V7.4Z" fill="${ALERT_W}" ${RJ}/><path d="M4 7.4 12 11.6l8-4.2M12 11.6v9.2" stroke="${C}" stroke-width="1.4" fill="none" ${RJ}/><path d="M8 5.3l8 4.2" stroke="${C}" stroke-width="1.1" opacity=".5"/>`,
  'pothole': C => `<path d="M3 14.5c0-2.6 4-4.5 9-4.5s9 1.9 9 4.5-4 4.5-9 4.5-9-1.9-9-4.5Z" fill="${ALERT_W}"/>` +
    `<path d="M6.2 14.4c0-1.4 2.6-2.5 5.8-2.5s5.8 1.1 5.8 2.5-2.6 2.6-5.8 2.6-5.8-1.2-5.8-2.6Z" fill="${C}" opacity=".85"/><path d="M8.5 14.6l2-.9 1.6 1.1 2.2-.9" stroke="${ALERT_W}" stroke-width=".9" fill="none" ${RJ} opacity=".7"/>` +
    `<path d="M12 3.5v4.2" stroke="${ALERT_W}" stroke-width="2.2" ${RJ}/><path d="m9.8 5.9 2.2 2.2 2.2-2.2" stroke="${ALERT_W}" stroke-width="2" fill="none" ${RJ}/>`,
  'stopped-vehicle': C => `<path d="M2.5 19v-3l1.4-3.7a2 2 0 0 1 1.9-1.3h5.4a2 2 0 0 1 1.9 1.3l1.4 3.7v3Z" fill="${ALERT_W}"/><rect x="3" y="18.5" width="2.4" height="2.4" rx=".7" fill="${ALERT_W}"/><rect x="11.1" y="18.5" width="2.4" height="2.4" rx=".7" fill="${ALERT_W}"/>` +
    `<path d="M5.5 12.8h5.5l.9 2.6H4.6Z" fill="${C}" opacity=".55"/>` +
    `<path d="M17.6 3.4a1 1 0 0 1 1.8 0l3.4 6.7a1 1 0 0 1-.9 1.4h-6.8a1 1 0 0 1-.9-1.4Z" fill="${ALERT_W}"/><path d="M18.5 5.6v2.6" stroke="${C}" stroke-width="1.5" ${RJ}/><circle cx="18.5" cy="9.7" r=".8" fill="${C}"/>`,
  'signal-broken': C => `<rect x="7.5" y="2.5" width="9" height="18" rx="3.2" fill="${ALERT_D}" stroke="${ALERT_W}" stroke-width="1.5"/>` +
    `<circle cx="12" cy="7" r="1.9" fill="#475569"/><circle cx="12" cy="11.5" r="1.9" fill="#facc15"/><circle cx="12" cy="16" r="1.9" fill="#475569"/>` +
    `<path d="M3.5 3.5l17 17" stroke="${ALERT_W}" stroke-width="3.2" ${RJ}/><path d="M3.5 3.5l17 17" stroke="#dc2626" stroke-width="1.6" ${RJ}/>`,
  'hazard': C => `<path d="M10.3 4a2 2 0 0 1 3.4 0l7.6 13.4a2 2 0 0 1-1.7 3H4.4a2 2 0 0 1-1.7-3Z" fill="${ALERT_W}"/>` +
    `<path d="M12 9.2v5" stroke="${C}" stroke-width="2.4" ${RJ}/><circle cx="12" cy="17.2" r="1.35" fill="${C}"/>`,
  'obstacle': C => `<path d="M6 14v6.5M18 14v6.5" stroke="${ALERT_W}" stroke-width="2.2" ${RJ}/><rect x="2.5" y="7.5" width="19" height="7" rx="1.6" fill="${ALERT_W}"/>` +
    `<path d="M6.5 7.5 3 14.5M11.5 7.5 8 14.5M16.5 7.5 13 14.5M21.5 7.8 18.2 14.5" stroke="${C}" stroke-width="2"/><circle cx="6" cy="5.2" r="1.6" fill="#facc15"/><circle cx="18" cy="5.2" r="1.6" fill="#facc15"/>`,
  'weather': C => `<path d="M6.8 16.5a4.6 4.6 0 0 1-.5-9.2 6.2 6.2 0 0 1 11.6 1.1 4.1 4.1 0 0 1-.4 8.1Z" fill="${ALERT_W}"/>` +
    `<path d="m12.6 11-2.6 5.3h3.2l-2.2 5" stroke="#facc15" stroke-width="1.9" fill="none" ${RJ}/>`,
  'fog': C => `<path d="M7 9.5a4 4 0 0 1 7.6-1.7A3.4 3.4 0 0 1 19 10" stroke="${ALERT_W}" stroke-width="2" fill="none" ${RJ}/>` +
    `<path d="M3.5 13h17M5.5 16.5h13M7.5 20h9" stroke="${ALERT_W}" stroke-width="2.2" ${RJ}/>`,
  'flood': C => `<path d="M7 9.5 12 5l5 4.5V12H7Z" fill="${ALERT_W}" ${RJ}/><path d="M3 14.5c2.2-1.6 4.3 1.6 6.5 0s4.3 1.6 6.5 0 4.3 1.6 6 0M3 19c2.2-1.6 4.3 1.6 6.5 0s4.3 1.6 6.5 0 4.3 1.6 6 0" stroke="${ALERT_W}" stroke-width="2" fill="none" ${RJ}/>`,
  'ice': C => `<path d="M12 2.5v19M3.8 7.2l16.4 9.6M3.8 16.8l16.4-9.6" stroke="${ALERT_W}" stroke-width="1.9" ${RJ}/>` +
    `<path d="M9.6 3.9 12 6l2.4-2.1M9.6 20.1 12 18l2.4 2.1M4.6 10.3l3-.7-1-2.9M19.4 13.7l-3 .7 1 2.9M4.6 13.7l3 .7-1 2.9M19.4 10.3l-3-.7 1-2.9" stroke="${ALERT_W}" stroke-width="1.4" fill="none" ${RJ}/>` +
    `<circle cx="12" cy="12" r="2.2" fill="${C}" stroke="${ALERT_W}" stroke-width="1.4"/>`,
  'rain': C => `<path d="M6.8 13.5a4.4 4.4 0 0 1-.5-8.8 6 6 0 0 1 11.2 1 4 4 0 0 1-.4 7.8Z" fill="${ALERT_W}"/>` +
    `<path d="M8 16.5l-1.2 3.2M12.2 16.5 11 19.7M16.4 16.5l-1.2 3.2" stroke="#7dd3fc" stroke-width="2.1" ${RJ}/>`,
  'snow': C => `<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" stroke="${ALERT_W}" stroke-width="2" ${RJ}/>` +
    `<path d="M9.7 4.6 12 6.6l2.3-2M9.7 19.4 12 17.4l2.3 2M5 10.9l2.9-.9-.6-3M19 13.1l-2.9.9.6 3M5 13.1l2.9.9-.6 3M19 10.9l-2.9-.9.6-3" stroke="${ALERT_W}" stroke-width="1.5" fill="none" ${RJ}/>`,
  'rail': C => `<g transform="rotate(45 12 12)"><rect x="2" y="9.6" width="20" height="4.8" rx="1" fill="${ALERT_W}"/><rect x="3.4" y="11" width="17.2" height="2" rx=".5" fill="#dc2626"/></g>` +
    `<g transform="rotate(-45 12 12)"><rect x="2" y="9.6" width="20" height="4.8" rx="1" fill="${ALERT_W}"/><rect x="3.4" y="11" width="17.2" height="2" rx=".5" fill="#dc2626"/></g>` +
    `<circle cx="12" cy="12" r="1.3" fill="${ALERT_W}"/>`,
  'traffic-light': C => `<rect x="7.2" y="1.8" width="9.6" height="20.4" rx="3.4" fill="${ALERT_D}" stroke="${ALERT_W}" stroke-width="1.6"/>` +
    `<circle cx="12" cy="6.6" r="2.3" fill="#ef4444"/><circle cx="12" cy="12" r="2.3" fill="#f59e0b"/><circle cx="12" cy="17.4" r="2.3" fill="#22c55e"/>` +
    `<circle cx="11.3" cy="5.9" r=".7" fill="#fff" opacity=".75"/><circle cx="11.3" cy="11.3" r=".7" fill="#fff" opacity=".6"/><circle cx="11.3" cy="16.7" r=".7" fill="#fff" opacity=".6"/>`,
  'school': C => `<circle cx="8" cy="4.6" r="2.1" fill="${ALERT_W}"/><circle cx="16.3" cy="7.4" r="1.8" fill="${ALERT_W}"/>` +
    `<path d="M8 7.8v6.4m0 0-2.4 6.3m2.4-6.3 2.6 6.3M4.8 11.4 8 9l3.4 2.6" stroke="${ALERT_W}" stroke-width="2.1" fill="none" ${RJ}/>` +
    `<path d="M16.3 10.3v5m0 0-1.9 5.2m1.9-5.2 2 5.2M13.7 13.4l2.6-2.1 2.8 2.1" stroke="${ALERT_W}" stroke-width="1.9" fill="none" ${RJ}/>`,
  'restriction': C => `<circle cx="12" cy="12" r="9" fill="${ALERT_W}"/><circle cx="12" cy="12" r="6.9" fill="${C}"/>` +
    `<path d="M12 7.6V12l2.9 2" stroke="${ALERT_W}" stroke-width="1.9" fill="none" ${RJ}/><path d="M5.6 5.6l12.8 12.8" stroke="${ALERT_W}" stroke-width="2.2" ${RJ}/>`,
};

// ---------- Priekšmetu ikonas (bez burbuļa): pats objekts, 3D ēnojums, tumša kontūra + balta mala ----------
// Gaisma krīt no augšas pa kreisi. Apakšā — ēna uz zemes (objekts "stāv" uz ceļa; enkurs — apakšā).
const OL = '#1b2330';
const ALERT_OBJ_DEFS =
  `<filter id="o" x="-25%" y="-25%" width="150%" height="150%">` +
  `<feMorphology in="SourceAlpha" operator="dilate" radius="2.3" result="m"/>` +
  `<feFlood flood-color="#fff"/><feComposite in2="m" operator="in" result="w"/>` +
  `<feGaussianBlur in="m" stdDeviation="1.4" result="b"/><feOffset in="b" dy="1.2" result="bo"/>` +
  `<feFlood flood-color="#000" flood-opacity=".35"/><feComposite in2="bo" operator="in" result="sh"/>` +
  `<feMerge><feMergeNode in="sh"/><feMergeNode in="w"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` +
  `<filter id="gb" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.6"/></filter>` +
  `<linearGradient id="mt" x1="0" x2="1"><stop offset="0" stop-color="#5d6672"/><stop offset=".4" stop-color="#e9edf1"/><stop offset="1" stop-color="#4b535e"/></linearGradient>`;
const lamp = (id, c0, c1, c2) => `<radialGradient id="${id}" cx=".38" cy=".34" r=".72"><stop offset="0" stop-color="${c0}"/><stop offset=".38" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></radialGradient>`;
const ALERT_OBJECTS = {
  // Luksofors: plakans, mīlīgs — tumšs korpuss, nojumes, trīs spīdošas lampas, stabs
  'traffic-light': `<g filter="url(#o)" stroke="#141a22" stroke-linejoin="round" stroke-linecap="round"><rect x="28.5" y="44" width="7" height="17" rx="2" fill="#8a94a3" stroke-width="2.2"/><path d="M30.6 46v13" stroke="#fff" stroke-width="1.4" opacity=".5"/><rect x="17.5" y="2.5" width="29" height="44" rx="9" fill="#2f3744" stroke-width="2.6"/><rect x="20.8" y="6" width="4.6" height="37" rx="2.3" fill="#fff" opacity=".14" stroke="none"/>` +
    [[13.6, '#ff4d4d'], [24.6, '#ffc531'], [35.6, '#34d26a']].map(([cy, c]) =>
      `<circle cx="32" cy="${cy}" r="7.6" fill="${c}" opacity=".45" stroke="none" filter="url(#gb)"/>` +
      `<circle cx="32" cy="${cy}" r="6.6" fill="#151a21" stroke="none"/><circle cx="32" cy="${cy}" r="5" fill="${c}" stroke-width="1.4"/>` +
      `<path d="M28.9 ${cy + 3}a5 5 0 0 0 7.6-1.7" fill="none" stroke="#000" stroke-width="1.6" opacity=".18"/>` +
      `<circle cx="30" cy="${cy - 2}" r="1.7" fill="#fff" stroke="none"/>` +
      '').join('') + `</g>`,
  // Stacionārais fotoradars: gaiša kaste ar dzeltenu jumtiņu uz staba; liels objektīvs, zibspuldze
  'camera-fixed': `<g filter="url(#o)" stroke="#141a22" stroke-linejoin="round" stroke-linecap="round"><rect x="28.5" y="41" width="7" height="20" rx="2" fill="#8a94a3" stroke-width="2.2"/><path d="M30.6 44v15" stroke="#fff" stroke-width="1.4" opacity=".5"/>` +
    `<rect x="21" y="37.5" width="22" height="6" rx="3" fill="#5b6574" stroke-width="2"/>` +
    `<path d="M50 15.5 57 11v23l-7 5Z" fill="#aab5c4" stroke-width="2.2"/>` +
    `<rect x="5" y="12" width="46" height="27" rx="7" fill="#eef2f7" stroke-width="2.6"/>` +
    `<path d="M8 31.5h40v2.5a3.5 3.5 0 0 1-3.5 3.5h-33A3.5 3.5 0 0 1 8 34Z" fill="#cdd6e2" stroke="none"/>` +
    `<rect x="2.5" y="6" width="52" height="8.5" rx="4.2" fill="#ffc531" stroke-width="2.4"/><path d="M6.5 8.8h44" stroke="#fff" stroke-width="1.6" opacity=".6"/>` +
    `<circle cx="21" cy="25.5" r="9.6" fill="#2a3342" stroke-width="2.4"/><circle cx="21" cy="25.5" r="6.2" fill="#3b82f6" stroke="none"/>` +
    `<circle cx="21" cy="25.5" r="2.9" fill="#0b1530" stroke="none"/><circle cx="18" cy="22.4" r="2.2" fill="#fff" stroke="none"/>` +
    `<rect x="35" y="18.5" width="11.5" height="7" rx="2" fill="#fff6c2" stroke-width="1.8"/><path d="M37 20.6h4" stroke="#fff" stroke-width="1.4"/>` +
    `<circle cx="40.8" cy="31" r="2.3" fill="#ff4d4d" stroke-width="1.5"/></g>`,
  // Mobilais radars: kamera uz trijkāja
  'camera-mobile': `<defs><linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5b6573"/><stop offset="1" stop-color="#1a202a"/></linearGradient>` +
    lamp('ln', '#c4ebff', '#3b82f6', '#0a1240') + `</defs>` +
    `<g filter="url(#o)"><path d="M31 36 17 59M33 36l14 23M32 37v21" stroke="${OL}" stroke-width="4.4" stroke-linecap="round"/>` +
    `<path d="M31 36 17 59M33 36l14 23M32 37v21" stroke="#6b7480" stroke-width="2.2" stroke-linecap="round"/>` +
    `<rect x="26" y="31" width="12" height="7" rx="2" fill="#2a313c" stroke="${OL}" stroke-width="1.3"/>` +
    `<path d="M45 15 57 9v24l-12-6Z" fill="url(#b)" stroke="${OL}" stroke-width="1.4" stroke-linejoin="round"/>` +
    `<rect x="7" y="9" width="39" height="24" rx="5" fill="url(#b)" stroke="${OL}" stroke-width="1.6"/>` +
    `<rect x="9.5" y="10.6" width="34" height="2.6" rx="1.3" fill="#fff" opacity=".22"/>` +
    `<circle cx="23" cy="21" r="9" fill="#0b0f17" stroke="#8792a2" stroke-width="1.6"/><circle cx="23" cy="21" r="6.2" fill="url(#ln)"/>` +
    `<ellipse cx="20.8" cy="18.3" rx="2.1" ry="1.4" fill="#fff" opacity=".9" transform="rotate(-30 20.8 18.3)"/>` +
    `<circle cx="40" cy="14.5" r="1.9" fill="#ff3b30"/></g>`,
  // Šķērslis: sarkanbalti svītrota barjera uz A veida kājām ar divām dzeltenām signāllampām
  'obstacle': `<defs><clipPath id="c"><rect x="5" y="20" width="54" height="14" rx="2.4"/></clipPath>` +
    lamp('y', '#fffbe0', '#ffcc1a', '#b87300') +
    `<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".5"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".22"/></linearGradient></defs>` +
    `<g transform="translate(0 1.5)"><g filter="url(#o)"><path d="M10 59 15 34 20 59M44 59l5-25 5 25" fill="none" stroke="${OL}" stroke-width="4.2" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<path d="M10 59 15 34 20 59M44 59l5-25 5 25" fill="none" stroke="#5b6573" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<path d="M5.5 34h53v2.8a2 2 0 0 1-2 2h-49a2 2 0 0 1-2-2Z" fill="#8f1d14" stroke="${OL}" stroke-width="1.3"/>` +
    `<g clip-path="url(#c)"><rect x="5" y="20" width="54" height="14" fill="#fff"/>` +
    `<path d="M1 34 11 20h7L8 34ZM15 34 25 20h7L22 34ZM29 34 39 20h7L36 34ZM43 34 53 20h7L50 34Z" fill="#ec2a1c"/><rect x="5" y="20" width="54" height="14" fill="url(#s)"/></g>` +
    `<rect x="5" y="20" width="54" height="14" rx="2.4" fill="none" stroke="${OL}" stroke-width="1.6"/>` +
    `<rect x="13" y="14.5" width="4" height="6" fill="#3b4350" stroke="${OL}" stroke-width="1"/><rect x="47" y="14.5" width="4" height="6" fill="#3b4350" stroke="${OL}" stroke-width="1"/>` +
    `<circle cx="15" cy="10.5" r="6" fill="#ffc21a" opacity=".45" filter="url(#gb)"/><circle cx="49" cy="10.5" r="6" fill="#ffc21a" opacity=".45" filter="url(#gb)"/>` +
    `<path d="M9.5 13a5.5 5.5 0 1 1 11 0Z" fill="url(#y)" stroke="${OL}" stroke-width="1.3"/><path d="M43.5 13a5.5 5.5 0 1 1 11 0Z" fill="url(#y)" stroke="${OL}" stroke-width="1.3"/>` +
    `<rect x="9" y="12.6" width="12" height="2.6" rx="1" fill="#3b4350" stroke="${OL}" stroke-width="1"/><rect x="43" y="12.6" width="12" height="2.6" rx="1" fill="#3b4350" stroke="${OL}" stroke-width="1"/>` +
    `<ellipse cx="13.4" cy="9.3" rx="1.5" ry="1" fill="#fff" opacity=".85"/><ellipse cx="47.4" cy="9.3" rx="1.5" ry="1" fill="#fff" opacity=".85"/></g></g>`,
  // Remontdarbi: plakans oranžs konuss ar baltām joslām uz pamatnes
  'roadworks': `<g filter="url(#o)" stroke="#141a22" stroke-linejoin="round" stroke-linecap="round"><rect x="7" y="50" width="50" height="9" rx="3" fill="#3a4250" stroke-width="2.4"/><path d="M11 52.6h42" stroke="#fff" stroke-width="1.4" opacity=".3"/>` +
    `<path d="M28.4 6.2Q32 1.2 35.6 6.2L49.5 51h-35Z" fill="#ff7a1f" stroke="none"/>` +
    `<path d="M33.6 4.4Q34.8 4.9 35.6 6.2L49.5 51H39.5Z" fill="#d9530b" stroke="none" opacity=".55"/>` +
    `<path d="M25.3 17.5h13.4l2.6 8.6H22.7ZM20.6 32.5h22.8l2.7 9H17.9Z" fill="#fff" stroke="none"/>` +
    `<path d="M38.7 17.5l2.6 8.6h-3.6l-2.3-8.6ZM43.4 32.5l2.7 9h-4l-2.4-9Z" fill="#cbd5e1" stroke="none"/>` +
    `<path d="M29.8 7.5 22.6 47" stroke="#fff" stroke-width="2.4" opacity=".45"/>` +
    `<path d="M28.4 6.2Q32 1.2 35.6 6.2L49.5 51h-35Z" fill="none" stroke-width="2.6"/></g>`,
  // Bērni: divi bērni sadevušies rokās (oranžs un zils krekls, mugursoma) — skolas zona
  'school': `<defs><linearGradient id="sa" x1="0" x2="1"><stop offset="0" stop-color="#ffa14d"/><stop offset="1" stop-color="#e2550c"/></linearGradient>` +
    `<linearGradient id="sb" x1="0" x2="1"><stop offset="0" stop-color="#7dd3fc"/><stop offset="1" stop-color="#0284c7"/></linearGradient>` +
    `<linearGradient id="bp" x1="0" x2="1"><stop offset="0" stop-color="#6d7cff"/><stop offset="1" stop-color="#3730a3"/></linearGradient>` +
    `<radialGradient id="sk" cx=".4" cy=".35" r=".7"><stop offset="0" stop-color="#ffe3c7"/><stop offset="1" stop-color="#f2b07e"/></radialGradient></defs>` +
    `<g filter="url(#o)" stroke="${OL}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">` +
    `<path d="M18 37v19M25 37v19" stroke-width="6.6"/><path d="M18 37v19M25 37v19" stroke="#2c3e74" stroke-width="3.8"/>` +
    `<path d="M14.5 58.5h6.8M22.5 58.5h6.8" stroke-width="3.6"/>` +
    `<path d="M39 41v14M45 41v14" stroke-width="6"/><path d="M39 41v14M45 41v14" stroke="#be185d" stroke-width="3.3"/>` +
    `<path d="M36.2 57.5h5.6M43 57.5h5.6" stroke-width="3.2"/>` +
    `<rect x="9" y="21" width="8" height="14" rx="2.6" fill="url(#bp)"/>` +
    `<path d="M28 27c4 1.5 6 4 8.5 7" fill="none" stroke-width="5"/><path d="M28 27c4 1.5 6 4 8.5 7" fill="none" stroke="#f2b07e" stroke-width="2.4"/>` +
    `<rect x="13.5" y="19.5" width="16" height="19" rx="6" fill="url(#sa)"/>` +
    `<rect x="35" y="29" width="14" height="14" rx="5" fill="url(#sb)"/>` +
    `<circle cx="21.5" cy="12" r="7" fill="url(#sk)"/><path d="M14.6 11.4a7 7 0 0 1 13.8 0c-2.6-2.4-5.6-3-6.9-3s-4.3.6-6.9 3Z" fill="#6b3a1d" stroke-width="1.1"/>` +
    `<circle cx="42" cy="22" r="5.8" fill="url(#sk)"/><path d="M36.3 21.6a5.8 5.8 0 0 1 11.4 0c-2.2-2-4.6-2.6-5.7-2.6s-3.5.6-5.7 2.6Z" fill="#f2c94c" stroke-width="1.1"/>` +
    `<g stroke="none"><ellipse cx="18.6" cy="22.5" rx="2.3" ry="1.2" fill="#fff" opacity=".45"/><ellipse cx="39" cy="31" rx="1.9" ry="1" fill="#fff" opacity=".5"/>` +
    `<circle cx="19.5" cy="12.6" r=".9" fill="${OL}"/><circle cx="24" cy="12.6" r=".9" fill="${OL}"/><circle cx="40.4" cy="22.6" r=".8" fill="${OL}"/><circle cx="44" cy="22.6" r=".8" fill="${OL}"/></g>` +
    `<path d="M20 15.6q1.8 1.4 3.6 0M40.8 25.2q1.4 1.1 2.8 0" fill="none" stroke-width="1"/></g>`,
  // Dzelzceļa pārbrauktuve: sarkanbalts krusts un signāla vairogs ar divām sarkanām lampām
  'rail': `<defs><linearGradient id="r" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#d9dee5"/></linearGradient>` +
    lamp('rl', '#fff1ef', '#ff3b30', '#8f0c06') + `</defs>` +
    `<g filter="url(#o)"><rect x="29.5" y="22" width="5" height="38" rx="1.5" fill="url(#mt)" stroke="${OL}" stroke-width="1.3"/>` +
    [35, -35].map(a => `<g transform="rotate(${a} 32 19)"><rect x="11" y="15" width="42" height="8" rx="1.6" fill="url(#r)" stroke="${OL}" stroke-width="1.4"/>` +
      `<rect x="12.8" y="16.8" width="38.4" height="4.4" rx=".8" fill="none" stroke="#e0201a" stroke-width="1.8"/></g>`).join('') +
    `<rect x="17" y="33" width="30" height="13" rx="6.5" fill="#12161c" stroke="${OL}" stroke-width="1.4"/>` +
    `<circle cx="24" cy="39.5" r="7" fill="#ff3b30" opacity=".55" filter="url(#gb)"/>` +
    `<circle cx="24" cy="39.5" r="4.4" fill="url(#rl)" stroke="#05070a" stroke-width="1"/><circle cx="40" cy="39.5" r="4.4" fill="#4a1512" stroke="#05070a" stroke-width="1"/>` +
    `<ellipse cx="22.6" cy="38" rx="1.4" ry=".9" fill="#fff" opacity=".85"/></g>`,
};
// Kuri veidi kartē ir priekšmeti (bez burbuļa)
const ALERT_OBJ_PAD = 'M3 62.5 15.5 55.2A17.5 5.6 0 0 1 37 50a17.5 5.6 0 1 1 0 11.2c-5 0-9.5-.6-12.6-1.6Z';
const ALERT_STANDALONE = new Set(['traffic-light', 'camera-fixed', 'camera-mobile', 'obstacle', 'roadworks', 'school', 'rail']);

function alertMix(hex, to, k) {
  const n = parseInt(hex.slice(1), 16), t = to === 'w' ? 255 : 0;
  const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(v + (t - v) * k));
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
}
// ---------- Ikona = burbulis ar asti (kā kartes atzīme), iekšā — priekšmets vai simbols ----------
// bg — burbuļa krāsa; dark — gaišs burbulis, tāpēc simbols tiek zīmēts tumšs; obj — kuru priekšmetu likt iekšā.
const ALERT_PIN_STYLE = {
  'police': { bg: '#3b82f6' }, 'police-hidden': { bg: '#3b82f6' },
  'camera-mobile': { bg: '#dfe8f3', obj: 'camera-mobile' }, 'camera-fixed': { bg: '#334155', obj: 'camera-fixed' },
  'accident': { bg: '#ef4444' }, 'jam': { bg: '#e11d48' },
  'roadworks': { bg: '#ffc61a', obj: 'roadworks' }, 'closure': { bg: '#ff8a3d', obj: 'obstacle' },
  'lane-closed': { bg: '#ff8a3d' }, 'obstacle': { bg: '#ff8a3d', obj: 'obstacle' },
  'object': { bg: '#ffc21a', dark: true }, 'pothole': { bg: '#ffc21a', dark: true }, 'stopped-vehicle': { bg: '#ffc21a', dark: true },
  'signal-broken': { bg: '#ffc21a', dark: true }, 'hazard': { bg: '#ffc21a', dark: true },
  'weather': { bg: '#0ea5e9' }, 'fog': { bg: '#64748b' }, 'flood': { bg: '#0284c7' }, 'ice': { bg: '#38bdf8' },
  'rain': { bg: '#0ea5e9' }, 'snow': { bg: '#38bdf8' },
  'rail': { bg: '#3b4351', obj: 'rail' }, 'traffic-light': { bg: '#e6ebf1', obj: 'traffic-light' },
  'school': { bg: '#22c55e', obj: 'school' }, 'restriction': { bg: '#8b5cf6' },
};
// Punkta krāsa attālinātā kartē (spīdīgie punkti).
function alertDotColor(type) {
  const st = ALERT_PIN_STYLE[type];
  const c = st ? st.bg : '#ffc21a';
  return { '#e6ebf1': '#94a3b8', '#dfe8f3': '#60a5fa', '#334155': '#facc15', '#3b4351': '#ef4444' }[c] || c;
}
// Priekšmetiem burbulī — bez baltās kontūras, tikai maiga ēna.
const ALERT_PIN_OBJ_DEFS = `<filter id="o" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur in="SourceAlpha" stdDeviation="1.2"/>` +
  `<feOffset dy="1.4"/><feComponentTransfer><feFuncA type="linear" slope=".35"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>` +
  `<filter id="gb" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.6"/></filter>` +
  `<linearGradient id="mt" x1="0" x2="1"><stop offset="0" stop-color="#5d6672"/><stop offset=".4" stop-color="#e9edf1"/><stop offset="1" stop-color="#4b535e"/></linearGradient>`;
const ALERT_PIN_PATH = 'M34 3.5A24.5 24.5 0 1 1 24.8 50.7L3 62.5 11.3 37.2A24.5 24.5 0 0 1 34 3.5Z';   // aste apakšā pa kreisi — rāda precīzo vietu
function alertSvg(type, size = 64) {
  if (ALERT_STANDALONE.has(type)) {
    // Priekšmets stāv uz balta "pamatnes" ovāla; no tā — bultiņa uz precīzo vietu (apakšā pa kreisi, kā atzīmēm)
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64"><defs>${ALERT_OBJ_DEFS}` +
      `<filter id="pd" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur in="SourceAlpha" stdDeviation="1"/><feOffset dy="1"/>` +
      `<feComponentTransfer><feFuncA type="linear" slope=".45"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>` +
      `<path d="${ALERT_OBJ_PAD}" fill="#fff" filter="url(#pd)"/><ellipse cx="37" cy="55.6" rx="13.5" ry="2.8" fill="#000" opacity=".16"/>` +
      `<g transform="translate(11 -0.5) scale(.82)">${ALERT_OBJECTS[type]}</g></svg>`;
  }
  const st = ALERT_PIN_STYLE[type] || ALERT_PIN_STYLE.hazard;
  const bg = st.bg, hi = alertMix(bg, 'w', 0.3), lo = alertMix(bg, 'k', 0.14);
  let inner;
  if (st.obj && ALERT_OBJECTS[st.obj]) {
    inner = `<g transform="translate(16.7 10.7) scale(.54)">${ALERT_OBJECTS[st.obj]}</g>`;
  } else {
    let g = (ALERT_GLYPHS[type] || ALERT_GLYPHS.hazard)(st.dark ? bg : alertMix(bg, 'k', 0.1));
    if (st.dark) g = g.split(ALERT_W).join('#1f2937');
    inner = `<g filter="url(#d)" transform="translate(19.6 13.6) scale(1.2)">${g}</g>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64"><defs>${ALERT_PIN_OBJ_DEFS}` +
    `<linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hi}"/><stop offset=".6" stop-color="${bg}"/><stop offset="1" stop-color="${lo}"/></linearGradient>` +
    `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".5"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
    `<filter id="s" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="1.6"/></filter>` +
    `<filter id="d" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur in="SourceAlpha" stdDeviation=".5"/><feOffset dy=".6"/>` +
    `<feComponentTransfer><feFuncA type="linear" slope=".3"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>` +
    `<path d="${ALERT_PIN_PATH}" fill="#000" opacity=".4" filter="url(#s)" transform="translate(0 1.4)"/>` +
    `<path d="${ALERT_PIN_PATH}" fill="#fff"/>` +
    `<circle cx="34" cy="28" r="21.4" fill="url(#f)"/>` +
    `<path d="M15.6 23A19.2 19.2 0 0 1 52.4 23C47 19.6 41 18.4 34 18.4S21 19.6 15.6 23Z" fill="url(#g)"/>` +
    inner + `</svg>`;
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
  module.exports = { ALERT_TYPES, REPORT_GROUPS, alertSvg, alertDotColor, alertTypeForSign, signNeedsDirection, alertTypeForOsm, weatherAlerts, AlertStore, makeReport, alertInfo };
}
