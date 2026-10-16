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

function alertMix(hex, to, k) {
  const n = parseInt(hex.slice(1), 16), t = to === 'w' ? 255 : 0;
  const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(v + (t - v) * k));
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
}
function alertSvg(type, size = 64) {
  const t = ALERT_TYPES[type] || ALERT_TYPES.hazard;
  const color = ALERT_GROUP_COLORS[t.group] || '#475569';
  const glyph = (ALERT_GLYPHS[type] || ALERT_GLYPHS.hazard)(color);
  const hi = alertMix(color, 'w', 0.28), lo = alertMix(color, 'k', 0.22);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">` +
    `<defs><linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hi}"/><stop offset=".55" stop-color="${color}"/><stop offset="1" stop-color="${lo}"/></linearGradient>` +
    `<linearGradient id="r" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#dfe3ea"/></linearGradient>` +
    `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".42"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
    `<filter id="s" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.2"/></filter>` +
    `<filter id="d" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur in="SourceAlpha" stdDeviation=".5"/><feOffset dy=".6"/>` +
    `<feComponentTransfer><feFuncA type="linear" slope=".35"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>` +
    `<ellipse cx="32" cy="35" rx="26" ry="25" fill="#000" opacity=".38" filter="url(#s)"/>` +
    `<circle cx="32" cy="31" r="28" fill="url(#r)"/>` +
    `<circle cx="32" cy="31" r="24.2" fill="url(#f)"/>` +
    `<circle cx="32" cy="31" r="24.2" fill="none" stroke="${lo}" stroke-width=".8" opacity=".6"/>` +
    `<path d="M10.4 27.5A22 22 0 0 1 53.6 27.5C47 23 39.8 21.8 32 21.8S17 23 10.4 27.5Z" fill="url(#g)"/>` +
    `<g filter="url(#d)" transform="translate(16.4 15.4) scale(1.3)">${glyph}</g></svg>`;
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
  module.exports = { ALERT_TYPES, REPORT_GROUPS, alertSvg, alertTypeForSign, signNeedsDirection, alertTypeForOsm, weatherAlerts, AlertStore, makeReport, alertInfo };
}
