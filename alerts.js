// Brīdinājumi kartē (kā Waze): tikai navigācijai un satiksmei būtiski notikumi un objekti,
// nevis visas ceļa zīmes. Katram veidam — viena vienota ikona (krāsains aplis ar baltu
// simbolu un baltu malu: labi redzama gan gaišā, gan tumšā kartē).
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
  police: '#1d4ed8', camera: '#1f2937', accident: '#dc2626', jam: '#9f1239', works: '#ea580c',
  closure: '#b91c1c', hazard: '#d97706', weather: '#0369a1', infra: '#475569', restriction: '#6d28d9',
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

// Simboli 24×24 koordinātās (balti). Vienkārši, viegli atpazīstami arī mazā izmērā.
const ALERT_W = '#fff';
const ALERT_GLYPHS = {
  'police': `<path d="M12 2.5 19.5 5.5v5.2c0 4.6-3.1 8.6-7.5 10.8-4.4-2.2-7.5-6.2-7.5-10.8V5.5Z" fill="${ALERT_W}"/><path d="m12 7.2 1.4 2.9 3.1.4-2.3 2.2.6 3.1-2.8-1.5-2.8 1.5.6-3.1-2.3-2.2 3.1-.4Z" fill="#1d4ed8"/>`,
  'police-hidden': `<path d="M12 2.5 19.5 5.5v5.2c0 4.6-3.1 8.6-7.5 10.8-4.4-2.2-7.5-6.2-7.5-10.8V5.5Z" fill="none" stroke="${ALERT_W}" stroke-width="2" stroke-dasharray="3 2"/><circle cx="12" cy="11.5" r="2.6" fill="${ALERT_W}"/>`,
  'camera-mobile': `<rect x="3" y="6" width="13" height="9" rx="2" fill="${ALERT_W}"/><circle cx="9.5" cy="10.5" r="2.6" fill="#1f2937"/><path d="M16 9l5-2.5v8L16 12" fill="${ALERT_W}"/><path d="M7 15l-2.5 6M12 15l2.5 6" stroke="${ALERT_W}" stroke-width="2" stroke-linecap="round"/>`,
  'camera-fixed': `<rect x="3" y="7" width="13" height="10" rx="2" fill="${ALERT_W}"/><circle cx="9.5" cy="12" r="2.8" fill="#1f2937"/><path d="M16 10l5-2.5v9L16 14" fill="${ALERT_W}"/>`,
  'accident': `<path d="M4 14l1.6-4.5A2 2 0 0 1 7.5 8h6a2 2 0 0 1 1.9 1.5L17 14v3h-2v1.5h-2V17H8v1.5H6V17H4Z" fill="${ALERT_W}"/><path d="M18.5 3.5l.8 2.4 2.4-.6-1.5 2 1.8 1.6-2.5.2-.3 2.5-1.6-1.9-2 1.4.5-2.4-2.3-.9 2.4-.7Z" fill="${ALERT_W}"/>`,
  'jam': `<rect x="2.5" y="9" width="6" height="6" rx="1.4" fill="${ALERT_W}"/><rect x="9" y="9" width="6" height="6" rx="1.4" fill="${ALERT_W}"/><rect x="15.5" y="9" width="6" height="6" rx="1.4" fill="${ALERT_W}"/><path d="M4 18h16" stroke="${ALERT_W}" stroke-width="2" stroke-linecap="round"/>`,
  'roadworks': `<path d="M12 3l6.5 16h-13Z" fill="${ALERT_W}"/><path d="M8.6 12.5h6.8M7.4 15.8h9.2" stroke="#ea580c" stroke-width="1.8"/><path d="M4 20.5h16" stroke="${ALERT_W}" stroke-width="2.2" stroke-linecap="round"/>`,
  'closure': `<circle cx="12" cy="12" r="8.5" fill="${ALERT_W}"/><rect x="6.5" y="10.4" width="11" height="3.2" rx="1" fill="#b91c1c"/>`,
  'lane-closed': `<path d="M6 3v18M18 3v18" stroke="${ALERT_W}" stroke-width="2" stroke-linecap="round"/><path d="M9.5 8.5l5 5M14.5 8.5l-5 5" stroke="${ALERT_W}" stroke-width="2.4" stroke-linecap="round"/>`,
  'object': `<path d="M12 3.5 19.5 7.5v9L12 20.5 4.5 16.5v-9Z" fill="${ALERT_W}"/><path d="M4.5 7.5 12 11.5l7.5-4M12 11.5v9" stroke="#d97706" stroke-width="1.5" fill="none"/>`,
  'pothole': `<ellipse cx="12" cy="14" rx="8.5" ry="4.5" fill="${ALERT_W}"/><path d="M8 13.5l2.5 1.5 2-2 2.5 1.8" stroke="#d97706" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M12 4v4" stroke="${ALERT_W}" stroke-width="2.2" stroke-linecap="round"/>`,
  'stopped-vehicle': `<path d="M3 16l1.4-4.2A2 2 0 0 1 6.3 10.5h6.4a2 2 0 0 1 1.9 1.3L16 16v3h-2v-1H5v1H3Z" fill="${ALERT_W}"/><path d="M18 3.5l3.8 6.8h-7.6Z" fill="${ALERT_W}"/><path d="M18 5.8v2.2" stroke="#d97706" stroke-width="1.4" stroke-linecap="round"/>`,
  'signal-broken': `<rect x="8" y="2.5" width="8" height="17" rx="3" fill="${ALERT_W}"/><circle cx="12" cy="6.5" r="1.8" fill="#d97706"/><circle cx="12" cy="11" r="1.8" fill="#d97706"/><circle cx="12" cy="15.5" r="1.8" fill="#d97706"/><path d="M4 4l16 16" stroke="${ALERT_W}" stroke-width="2.4" stroke-linecap="round"/><path d="M4 4l16 16" stroke="#d97706" stroke-width="1" stroke-linecap="round"/>`,
  'hazard': `<path d="M12 3.5 21 19.5H3Z" fill="${ALERT_W}"/><path d="M12 9v5" stroke="#d97706" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="16.8" r="1.2" fill="#d97706"/>`,
  'obstacle': `<rect x="3" y="8" width="18" height="6" rx="1.2" fill="${ALERT_W}"/><path d="M6.5 8l-3 6M11.5 8l-3 6M16.5 8l-3 6M21 8.5l-2.7 5.5" stroke="#d97706" stroke-width="1.8"/><path d="M6 14v6M18 14v6" stroke="${ALERT_W}" stroke-width="2" stroke-linecap="round"/>`,
  'weather': `<path d="M7 17.5a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 18 9a4.3 4.3 0 0 1-.5 8.5Z" fill="${ALERT_W}"/><path d="m11.5 12-2 4h3l-2 4" stroke="#0369a1" stroke-width="1.6" fill="none" stroke-linejoin="round"/>`,
  'fog': `<path d="M4 8h16M3 12h18M5 16h14M7 20h10" stroke="${ALERT_W}" stroke-width="2.2" stroke-linecap="round"/>`,
  'flood': `<path d="M3 9c3-2 6 2 9 0s6 2 9 0M3 14c3-2 6 2 9 0s6 2 9 0M3 19c3-2 6 2 9 0s6 2 9 0" stroke="${ALERT_W}" stroke-width="2" fill="none" stroke-linecap="round"/>`,
  'ice': `<path d="M8 21c-4-6 6-8 2-14M15 21c-4-6 6-8 2-14" stroke="${ALERT_W}" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M5 4.5l1.5 1.5M8.5 3v2" stroke="${ALERT_W}" stroke-width="1.6" stroke-linecap="round"/>`,
  'rain': `<path d="M7 13.5a4.2 4.2 0 0 1-.4-8.4A5.7 5.7 0 0 1 17.5 5.6a4 4 0 0 1-.5 7.9Z" fill="${ALERT_W}"/><path d="M8 16l-1.5 4M12 16l-1.5 4M16 16l-1.5 4" stroke="${ALERT_W}" stroke-width="2" stroke-linecap="round"/>`,
  'snow': `<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" stroke="${ALERT_W}" stroke-width="2" stroke-linecap="round"/><path d="M9.8 4.5 12 6.5l2.2-2M9.8 19.5 12 17.5l2.2 2" stroke="${ALERT_W}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`,
  'rail': `<path d="M5 5l14 14M19 5 5 19" stroke="${ALERT_W}" stroke-width="3.2" stroke-linecap="round"/>`,
  'traffic-light': `<rect x="8" y="2.5" width="8" height="19" rx="3" fill="${ALERT_W}"/><circle cx="12" cy="7" r="2" fill="#dc2626"/><circle cx="12" cy="12" r="2" fill="#f59e0b"/><circle cx="12" cy="17" r="2" fill="#16a34a"/>`,
  'school': `<circle cx="8.5" cy="5.5" r="2" fill="${ALERT_W}"/><circle cx="15.5" cy="7.5" r="1.7" fill="${ALERT_W}"/><path d="M8.5 8v6.5l-2 5.5M8.5 14.5l2 5.5M15.5 10v5l-1.7 4.5M15.5 15l1.7 4.5M5.5 11h6M13 12.5h5" stroke="${ALERT_W}" stroke-width="2" stroke-linecap="round" fill="none"/>`,
  'restriction': `<circle cx="12" cy="12" r="8" fill="none" stroke="${ALERT_W}" stroke-width="2.6"/><path d="M6.5 6.5l11 11" stroke="${ALERT_W}" stroke-width="2.6"/><path d="M12 9v3.2l2 1.4" stroke="${ALERT_W}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`,
};

function alertSvg(type, size = 64) {
  const t = ALERT_TYPES[type] || ALERT_TYPES.hazard;
  const color = ALERT_GROUP_COLORS[t.group] || '#475569';
  const glyph = ALERT_GLYPHS[type] || ALERT_GLYPHS.hazard;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">` +
    `<circle cx="32" cy="33.5" r="27" fill="rgba(0,0,0,0.28)"/>` +
    `<circle cx="32" cy="32" r="27" fill="${color}" stroke="#fff" stroke-width="4"/>` +
    `<g transform="translate(16 16) scale(1.333)">${glyph}</g></svg>`;
}
const alertUrlCache = new Map();
function alertDataUrl(type) {
  if (!alertUrlCache.has(type)) alertUrlCache.set(type, 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(alertSvg(type, 64)));
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
