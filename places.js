// ---------- Vietas tuvumā ----------
// Secība — pēc tā, cik bieži autovadītāji tās izmanto: vispirms ceļam vajadzīgais (degviela,
// stāvvieta, uzlāde), tad ēdiens un veikali, tad veselība un drošība (redzama bez ritināšanas),
// beigās retāk vajadzīgais.
// Kategorijas → OpenStreetMap birkas. Meklē Overpass ap mani (vai kartes centru).
// Tikai reāli OSM dati: nosaukums, adrese, darba laiks, zīmols.

const PLACE_W = '#fff';
const PLACE_CATEGORIES = [
  { id: 'fuel',     label: 'Degviela',            color: '#2f9e44', q: ['nwr["amenity"="fuel"]'],
    glyph: `<path d="M8 6.5h7v12H8Z" fill="none" stroke="${PLACE_W}" stroke-width="1.8" stroke-linejoin="round"/><path d="M9.7 8.5h3.6v3H9.7Z" fill="${PLACE_W}"/><path d="M15 10h1.4a1.3 1.3 0 0 1 1.3 1.3v4.2a1 1 0 0 0 2 0V9.8L18 8" fill="none" stroke="${PLACE_W}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>` },
  { id: 'parking',  label: 'Stāvvieta',           color: '#1c7ed6', q: ['nwr["amenity"="parking"]["access"!~"^(private|no|customers)$"]'],
    glyph: `<path d="M9.5 18V6.5h3.6a3.3 3.3 0 0 1 0 6.6H9.5" fill="none" stroke="${PLACE_W}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>` },
  { id: 'ev',       label: 'Elektroauto uzlāde',  color: '#0c8599', q: ['nwr["amenity"="charging_station"]'],
    glyph: `<path d="M13 4.5 7.5 13h4l-1 6.5L16.5 11h-4Z" fill="${PLACE_W}"/>` },
  { id: 'food',     label: 'Ēdiens',              color: '#e8590c', q: ['nwr["amenity"~"^(restaurant|fast_food|food_court)$"]'],
    glyph: `<path d="M8.5 5.5v5.2M7 5.5v3.8a1.5 1.5 0 0 0 3 0V5.5M8.5 10.7V18.5" fill="none" stroke="${PLACE_W}" stroke-width="1.6" stroke-linecap="round"/><path d="M15.5 18.5V5.5c-1.8.8-2.6 2.8-2.6 5.2 0 1.4.9 2.2 2.6 2.2" fill="none" stroke="${PLACE_W}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>` },
  { id: 'coffee',   label: 'Kafija',              color: '#9c6b3f', q: ['nwr["amenity"="cafe"]'],
    glyph: `<path d="M6.5 10h9v3.5a4 4 0 0 1-4 4h-1a4 4 0 0 1-4-4Z" fill="none" stroke="${PLACE_W}" stroke-width="1.7" stroke-linejoin="round"/><path d="M15.5 11h1.2a1.8 1.8 0 0 1 0 3.6h-1.4M9 5.5c-.6.8.6 1.4 0 2.2M12 5.5c-.6.8.6 1.4 0 2.2" fill="none" stroke="${PLACE_W}" stroke-width="1.5" stroke-linecap="round"/>` },
  { id: 'grocery',  label: 'Pārtikas veikali',    color: '#37b24d', q: ['nwr["shop"~"^(supermarket|convenience|greengrocer)$"]'],
    glyph: `<path d="M5.5 6.5h2l1.6 8h7.4l1.5-5.6H8.3" fill="none" stroke="${PLACE_W}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="17.6" r="1.2" fill="${PLACE_W}"/><circle cx="15.6" cy="17.6" r="1.2" fill="${PLACE_W}"/>` },
  { id: 'carwash',  label: 'Auto mazgātavas',     color: '#3b5bdb', q: ['nwr["amenity"="car_wash"]'],
    glyph: `<path d="M8.2 4.6c-.9 1.2-1.3 2-1.3 2.6a1.3 1.3 0 0 0 2.6 0c0-.6-.4-1.4-1.3-2.6ZM12 3.6c-.9 1.2-1.3 2-1.3 2.6a1.3 1.3 0 0 0 2.6 0c0-.6-.4-1.4-1.3-2.6ZM15.8 4.6c-.9 1.2-1.3 2-1.3 2.6a1.3 1.3 0 0 0 2.6 0c0-.6-.4-1.4-1.3-2.6Z" fill="${PLACE_W}"/>` +
      `<path d="M5.5 17.2v-2.9l1.3-3.2a1.8 1.8 0 0 1 1.7-1.1h7a1.8 1.8 0 0 1 1.7 1.1l1.3 3.2v2.9Z" fill="none" stroke="${PLACE_W}" stroke-width="1.6" stroke-linejoin="round"/>` +
      `<path d="M5.5 14.3h13" stroke="${PLACE_W}" stroke-width="1.4"/><path d="M7.2 17.2v1.6M16.8 17.2v1.6" stroke="${PLACE_W}" stroke-width="1.8" stroke-linecap="round"/>` },
  { id: 'pharmacy', label: 'Aptiekas',            color: '#12b886', q: ['nwr["amenity"="pharmacy"]'],
    glyph: `<rect x="5.6" y="9.4" width="12.8" height="5.2" rx="2.6" transform="rotate(-45 12 12)" fill="none" stroke="${PLACE_W}" stroke-width="1.7"/><path d="m10.1 10.1 3.8 3.8" stroke="${PLACE_W}" stroke-width="1.7"/>` },
  { id: 'medical',  label: 'Medicīniskā palīdzība', color: '#e03131', q: ['nwr["amenity"~"^(hospital|clinic|doctors)$"]'],
    glyph: `<path d="M10 6h4v4h4v4h-4v4h-4v-4H6v-4h4Z" fill="${PLACE_W}"/>` },
  { id: 'crisis',   label: 'Ārkārtas palīdzība',  color: '#c92a2a', q: ['nwr["amenity"~"^(police|fire_station)$"]', 'nwr["amenity"="hospital"]["emergency"="yes"]', 'nwr["social_facility"="shelter"]'],
    glyph: `<path d="M12 4.5 18.5 7v4.6c0 3.9-2.7 6.7-6.5 7.9-3.8-1.2-6.5-4-6.5-7.9V7Z" fill="none" stroke="${PLACE_W}" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 8.5v4.2" stroke="${PLACE_W}" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="15.2" r="1.1" fill="${PLACE_W}"/>` },
  { id: 'hotel',    label: 'Viesnīcas',           color: '#7048e8', q: ['nwr["tourism"~"^(hotel|motel|guest_house|hostel)$"]'],
    glyph: `<path d="M5.5 17.5V7M5.5 13.5h13v4M18.5 13.5v-1.8a2.2 2.2 0 0 0-2.2-2.2H11v4" fill="none" stroke="${PLACE_W}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8.3" cy="11" r="1.5" fill="${PLACE_W}"/>` },
  { id: 'shopping', label: 'Iepirkšanās',         color: '#d6336c', q: ['nwr["shop"~"^(mall|department_store|clothes|shoes|electronics|doityourself|hardware|furniture)$"]'],
    glyph: `<path d="M6.5 9h11l-.8 9.5H7.3Z" fill="none" stroke="${PLACE_W}" stroke-width="1.7" stroke-linejoin="round"/><path d="M9.5 10.5V8a2.5 2.5 0 0 1 5 0v2.5" fill="none" stroke="${PLACE_W}" stroke-width="1.7" stroke-linecap="round"/>` },
  { id: 'park',     label: 'Parki',               color: '#5c940d', q: ['nwr["leisure"="park"]["name"]'],
    glyph: `<path d="M12 4.5c-2.6 0-4.3 2.2-4.3 4.6 0 .5 0 .9.2 1.3A3.3 3.3 0 0 0 9.7 16h4.6a3.3 3.3 0 0 0 1.8-5.6c.2-.4.2-.8.2-1.3 0-2.4-1.7-4.6-4.3-4.6Z" fill="none" stroke="${PLACE_W}" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 11v8" stroke="${PLACE_W}" stroke-width="1.7" stroke-linecap="round"/>` },
];
// Ātrā meklēšana (Photon, ~0,4 s): OSM birkas katrai kategorijai
const PLACE_PHOTON_TAGS = {"fuel": ["amenity:fuel"], "food": ["amenity:restaurant", "amenity:fast_food", "amenity:food_court"], "parking": ["amenity:parking"], "grocery": ["shop:supermarket", "shop:convenience", "shop:greengrocer"], "coffee": ["amenity:cafe"], "shopping": ["shop:mall", "shop:department_store", "shop:clothes", "shop:shoes", "shop:electronics", "shop:doityourself", "shop:hardware", "shop:furniture"], "pharmacy": ["amenity:pharmacy"], "ev": ["amenity:charging_station"], "carwash": ["amenity:car_wash"], "medical": ["amenity:hospital", "amenity:clinic", "amenity:doctors"], "hotel": ["tourism:hotel", "tourism:motel", "tourism:guest_house", "tourism:hostel"], "park": ["leisure:park"], "crisis": ["amenity:police", "amenity:fire_station", "amenity:hospital"]};
const PLACE_BY_ID = Object.fromEntries(PLACE_CATEGORIES.map(c => [c.id, c]));
// Uzreiz no kartes (OpenMapTiles "poi" slānis jau ielādētajās kartes flīzēs) — bez interneta pieprasījuma
const PLACE_TILE_SUBCLASS = {
  fuel: ['fuel'], food: ['restaurant', 'fast_food', 'food_court'], parking: ['parking'],
  grocery: ['supermarket', 'convenience', 'greengrocer'], coffee: ['cafe'],
  shopping: ['mall', 'department_store', 'clothes', 'shoes', 'electronics', 'doityourself', 'hardware', 'furniture'],
  pharmacy: ['pharmacy'], ev: ['charging_station'], carwash: ['car_wash'], medical: ['hospital', 'clinic', 'doctors'],
  hotel: ['hotel', 'motel', 'guest_house', 'hostel'], park: ['park'], crisis: ['police', 'fire_station', 'hospital'],
};

// Auto mazgātava: pašapkalpošanās / automātiskā / roku mazgāšana (ja OSM tas norādīts)
function carWashInfo(t) {
  const out = [];
  if (t.self_service === 'yes') out.push('pašapkalpošanās');
  else if (t.self_service === 'no') out.push('ar darbinieku');
  if (t.automated === 'yes') out.push('automātiskā');
  if (t.hand_wash === 'yes' || t['car_wash:hand'] === 'yes') out.push('roku mazgāšana');
  return out;
}

function placeIconSvg(id, size = 40) {
  const c = PLACE_BY_ID[id];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="7" fill="${c.color}"/>${c.glyph}</svg>`;
}
function placeIconUrl(id) { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(placeIconSvg(id, 48)); }

function buildPlacesQuery(catId, lat, lng, radiusM) {
  const c = PLACE_BY_ID[catId];
  if (!c) throw new Error('Nezināma kategorija: ' + catId);
  const around = `(around:${Math.round(radiusM)},${lat.toFixed(5)},${lng.toFixed(5)})`;
  return `[out:json][timeout:20];\n(\n${c.q.map(q => '  ' + q + around + ';').join('\n')}\n);\nout center tags 150;`;
}

function placeDistM(lat1, lng1, lat2, lng2) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Darba laiks tagad: true atvērts / false slēgts / null nav zināms.
function placeOpenNow(oh, now, parse) {
  if (!oh) return null;
  if (/^\s*24\/7\s*$/.test(oh)) return true;
  if (typeof parse !== 'function') return null;
  try { const c = parse(oh); return c.known ? !!c.test(now) : null; } catch { return null; }
}

// ---------- Darba laika statuss ar krāsainu punktu ----------
// open (zaļš) · closing (oranžs, aizveras ≤ 30 min) · opening (dzeltens, atveras ≤ 60 min)
// closed (sarkans) · unknown (pelēks — darba laiks nav zināms). Laiki pēc Rīgas laika.
const PLACE_CLOSING_MIN = 30, PLACE_OPENING_MIN = 60;
const LV_DAYS_ON = ['svētdien', 'pirmdien', 'otrdien', 'trešdien', 'ceturtdien', 'piektdien', 'sestdien'];
let placeHmFmt = null, placeDayFmt = null;
function placeRigaHm(d) {
  if (!placeHmFmt) placeHmFmt = new Intl.DateTimeFormat('lv-LV', { timeZone: 'Europe/Riga', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return placeHmFmt.format(d);
}
function placeRigaDay(d) {       // [gads-mēnesis-diena, nedēļas diena 0..6]
  if (!placeDayFmt) placeDayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Riga', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const p = {}; for (const x of placeDayFmt.formatToParts(d)) p[x.type] = x.value;
  return [p.year + p.month + p.day, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)];
}
// "08:00" šodien · "rīt 08:00" · "pirmdien 08:00"
function placeWhen(t, now) {
  const [d0] = placeRigaDay(now), [d1, dow] = placeRigaDay(t), [dTom] = placeRigaDay(new Date(now.getTime() + 864e5));
  const hm = placeRigaHm(t);
  if (d1 === d0) return hm;
  if (d1 === dTom) return hm === '00:00' ? '24:00' : 'rīt ' + hm;   // "līdz 24:00", nevis "līdz rīt 00:00"
  return LV_DAYS_ON[dow] + ' ' + hm;
}
function placeMinutes(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
}
// Nākamā statusa maiņa (līdz 8 dienām uz priekšu): ar 5 min soli, tad precīzi līdz minūtei.
function placeNextChange(test, now, isOpen) {
  const t0 = Math.floor(now.getTime() / 60000) * 60000, STEP = 5 * 60000, END = t0 + 8 * 864e5;
  for (let t = t0 + STEP; t <= END; t += STEP) {
    if (!!test(new Date(t)) !== isOpen) {
      let a = t - STEP;                                   // a — vēl vecais statuss, t — jau jaunais
      while (t - a > 60000) { const m = a + 60000; if (!!test(new Date(m)) !== isOpen) { t = m; break; } a = m; }
      return new Date(t);
    }
  }
  return null;
}
function placeStatus(oh, now, parse) {
  if (!oh) return { state: 'unknown', text: '' };
  if (/^\s*24\/7\s*$/.test(oh)) return { state: 'open', text: 'atvērts visu diennakti' };
  let c = null;
  try { c = typeof parse === 'function' ? parse(oh) : null; } catch { c = null; }
  if (!c || !c.known) return { state: 'unknown', text: '' };
  const isOpen = !!c.test(now);
  const next = placeNextChange(c.test, now, isOpen);
  if (isOpen) {
    if (!next) return { state: 'open', text: 'atvērts visu diennakti' };
    const left = next - now;
    if (left <= PLACE_CLOSING_MIN * 60000) return { state: 'closing', text: 'aizveras pēc ' + placeMinutes(left) };
    return { state: 'open', text: 'atvērts līdz ' + placeWhen(next, now) };
  }
  if (!next) return { state: 'closed', text: 'slēgts' };
  const wait = next - now;
  if (wait <= PLACE_OPENING_MIN * 60000) return { state: 'opening', text: 'atveras pēc ' + placeMinutes(wait) };
  return { state: 'closed', text: 'slēgts · atveras ' + placeWhen(next, now) };
}

// ---------- F24: rādāmais nosaukums (OSM `name` bieži ir apraksts, piem. „EV charging type 2”) ----------
// Vārdi, no kuriem sastāv TIKAI apraksts (ne īsts nosaukums). Papildināt šeit. Kategorijas nosaukuma vārdi — automātiski.
// Nosaukums ir vispārīgs, ja VISI tā vārdi ir šajā sarakstā (cipari un „kW” tiek ignorēti); „Elektrum EV charging” — nav.
const PLACE_GENERIC_WORDS = {
  _all: ['wc', 'toilet', 'toilets', 'atm', 'bankomāts', 'public', 'publiska', 'publisks', 'service', 'serviss'],
  ev: ['ev', 'e', 'charging', 'charge', 'charger', 'chargers', 'station', 'stations', 'point', 'points', 'electric', 'electrical',
    'vehicle', 'vehicles', 'car', 'cars', 'type', 'type2', 'ccs', 'ccs2', 'chademo', 'dc', 'ac', 'fast', 'rapid', 'ultra', 'hpc',
    'plug', 'socket', 'mennekes', 'uzlāde', 'uzlādes', 'stacija', 'stacijas', 'punkts', 'elektroauto', 'elektromobiļu', 'auto'],
  parking: ['parking', 'car', 'park', 'lot', 'p', 'p+r', 'stāvvieta', 'stāvvietas', 'stāvlaukums', 'autostāvvieta', 'autostāvvietas',
    'free', 'paid', 'underground', 'stavvieta', 'autostavvieta', 'stavlaukums'],
  // Latviski aprakstoši vārdi ar jēgu („Klientu stāvvieta”, „Ilgtermiņa …”, „Pazemes …”) — paliek nosaukumā
  fuel: ['fuel', 'gas', 'petrol', 'filling', 'station', 'degviela', 'degvielas', 'uzpildes', 'stacija', 'dus', 'ads',
    'lpg', 'cng', 'autogāze', 'gāze', 'gāzes', 'marine'],
  carwash: ['car', 'wash', 'carwash', 'self', 'auto', 'mazgātava', 'mazgātavas', 'mazgāšana', 'pašapkalpošanās', 'automazgātava', 'automazgātavas'],
  pharmacy: ['pharmacy', 'aptieka'],
  coffee: ['cafe', 'café', 'coffee', 'kafejnīca', 'kafija'],
  food: ['restaurant', 'restorāns', 'cafe', 'café', 'kafejnīca', 'fast', 'food', 'ēdnīca'],
  grocery: ['shop', 'store', 'market', 'supermarket', 'minimarket', 'veikals', 'pārtika'],
  shopping: ['shop', 'store', 'mall', 'veikals', 'tirdzniecības', 'centrs'],
  hotel: ['hotel', 'motel', 'hostel', 'guest', 'house', 'viesnīca', 'viesu', 'nams'],
  medical: ['clinic', 'hospital', 'doctor', 'doctors', 'klīnika', 'slimnīca', 'poliklīnika'],
};
// Vienai vietai — vienskaitlī (kategoriju sarakstā paliek daudzskaitlis): „Auto mazgātava”, nevis „Auto mazgātavas”
const PLACE_ONE = { grocery: 'Pārtikas veikals', carwash: 'Auto mazgātava', pharmacy: 'Aptieka', hotel: 'Viesnīca', park: 'Parks' };
function placeLabelOne(catId) { return PLACE_ONE[catId] || (PLACE_BY_ID[catId] ? PLACE_BY_ID[catId].label : 'Vieta'); }
const placeNorm = s => String(s == null ? '' : s).toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}+]+/gu, ' ').trim();
function isGenericName(name, catId) {
  const n = placeNorm(name);
  if (!n) return true;
  const c = PLACE_BY_ID[catId];
  if (c && (n === placeNorm(c.label) || n === placeNorm(placeLabelOne(catId)))) return true;
  const words = new Set([...(PLACE_GENERIC_WORDS._all), ...(PLACE_GENERIC_WORDS[catId] || []),
    ...(c ? placeNorm(c.label + ' ' + placeLabelOne(catId)).split(' ') : [])]);
  return n.split(' ').every(w => words.has(w) || /^\d+([.,]\d+)?(kw)?$/.test(w) || w === 'kw');
}
// Viena funkcija visiem avotiem (Overpass, Photon, kartes flīzes): name:lv → name (ja nav apraksts) →
// kategorija · zīmols / operators / tīkls → kategorija. Zīmolus netulko.
function placeDisplayName(tags, catId) {
  const t = tags || {}, label = placeLabelOne(catId);
  const lv = String(t['name:lv'] || '').trim();
  if (lv && !isGenericName(lv, catId)) return lv;
  const nm = String(t.name || '').trim();
  if (nm && !isGenericName(nm, catId)) return nm;
  const who = [t.brand, t.operator, t.network].map(x => String(x || '').trim()).find(x => x && !isGenericName(x, catId));
  return who ? label + ' · ' + who : label;
}
// Uzlādes stacijas papildinformācija latviski: kontaktu tipi, jauda, vietas (otrajā rindā, ne nosaukumā)
const PLACE_SOCKETS = { type2: 'Type 2', type2_cable: 'Type 2', type2_combo: 'CCS', chademo: 'CHAdeMO', type1: 'Type 1',
  type1_combo: 'CCS1', tesla_supercharger: 'Tesla', tesla_standard: 'Tesla', schuko: 'Schuko', nacs: 'NACS' };
function placeKw(v) {
  let max = 0;
  for (const m of String(v || '').matchAll(/(\d+(?:[.,]\d+)?)\s*(kw|w)?/gi)) {
    let n = parseFloat(m[1].replace(',', '.'));
    if (m[2] && m[2].toLowerCase() === 'w') n /= 1000;
    if (n > max && n < 2000) max = n;
  }
  return max;
}
function evInfo(t) {
  t = t || {};
  const types = [], out = [];
  let kw = placeKw(t['charging_station:output']);
  for (const [k, v] of Object.entries(t)) {
    const m = /^socket:([a-z0-9_]+)(:output)?$/.exec(k);
    if (!m) continue;
    if (m[2]) { kw = Math.max(kw, placeKw(v)); continue; }
    if (v === 'no' || v === '0') continue;
    const name = PLACE_SOCKETS[m[1]];
    if (name && !types.includes(name)) types.push(name);
  }
  if (types.length) out.push(types.join(', '));
  if (kw) out.push('līdz ' + String(Math.round(kw * 10) / 10).replace('.', ',') + ' kW');
  if (t.capacity && /^\d{1,3}$/.test(t.capacity)) out.push(t.capacity + (t.capacity === '1' ? ' vieta' : ' vietas'));
  return out;
}
// Dublikāti (tā pati vieta no blakus flīzēm / mezgls + laukums): vienāds rādāmais UN oriģinālais nosaukums, < 60 m
function placeDedupe(out) {
  out.sort((a, b) => a.d - b.d);
  const kept = [];
  for (const p of out) if (!kept.some(k => k.name === p.name && (k.osmName || '') === (p.osmName || '') && placeDistM(k.lat, k.lng, p.lat, p.lng) < 60)) kept.push(p);
  return kept;
}

// Overpass elementi → vietu saraksts (pēc attāluma, bez dublikātiem).
function parsePlaces(elements, catId, lat, lng, now = new Date(), parse = null) {
  const c = PLACE_BY_ID[catId];
  const out = [];
  for (const el of elements || []) {
    const t = el.tags || {};
    const plat = el.lat != null ? el.lat : el.center && el.center.lat;
    const plng = el.lon != null ? el.lon : el.center && el.center.lon;
    if (plat == null || plng == null) continue;
    const name = placeDisplayName(t, catId);
    const addr = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
    const extra = [];
    if (catId === 'parking') {
      if (t.fee === 'no') extra.push('bez maksas'); else if (t.fee === 'yes') extra.push('maksas');
      if (t.capacity) extra.push(t.capacity + ' vietas');
    }
    if (catId === 'ev') extra.push(...evInfo(t));
    if (catId === 'carwash') extra.push(...carWashInfo(t));
    if (catId === 'fuel' && t.brand && !name.toLowerCase().includes(t.brand.toLowerCase())) extra.push(t.brand);
    out.push({
      id: el.type + el.id, cat: catId, name, osmName: t.name || '', lat: plat, lng: plng,
      d: placeDistM(lat, lng, plat, plng),
      addr, extra, oh: t.opening_hours || '', open: placeOpenNow(t.opening_hours, now, parse),
      ct: placeContacts(t, name),
    });
  }
  return placeDedupe(out);
}

// ---------- Kontakti: Zvanīt / Mājaslapa / Lietotne ----------
// Drošība: tālrunis tikai cipari un "+"; mājaslapa tikai http(s) → vienmēr https, bez lietotājvārda/paroles,
// bez IP un dīvainām rakstzīmēm; lietotnes — TIKAI pārbaudīti oficiālie veikalu ieraksti (nekādu lejupielāžu).
const PLACE_BRANDS = [
  // [atpazīšana pēc nosaukuma/zīmola, nosaukums, oficiālā vietne, { android: Google Play id, ios: App Store id }]
  [/circle\s*k/i, 'Circle K', 'https://www.circlek.lv/', {}],
  [/\bneste\b/i, 'Neste', 'https://www.neste.lv/', { ios: '535050119' }],
  [/vir[sš]i/i, 'Virši', 'https://www.virsi.lv/', {}],
  [/\bviada\b/i, 'Viada', 'https://www.viada.lv/', {}],
  [/\brimi\b/i, 'Rimi', 'https://www.rimi.lv/', { android: 'lv.rimi.card' }],
  [/\bmaxima\b/i, 'Maxima', 'https://www.maxima.lv/', {}],
  [/\blidl\b/i, 'Lidl', 'https://www.lidl.lv/', { android: 'com.lidl.eci.lidlplus', ios: '1238611143' }],
  [/\belvi\b/i, 'Elvi', 'https://www.elvi.lv/', {}],
  [/\bmego\b/i, 'Mego', 'https://www.mego.lv/', {}],
  [/\bnarvesen\b/i, 'Narvesen', 'https://www.narvesen.lv/', {}],
  [/\bbenu\b/i, 'Benu', 'https://www.benu.lv/', {}],
  [/m[eē]ness\s*aptieka/i, 'Mēness aptieka', 'https://www.menessaptieka.lv/', {}],
  [/euroaptieka/i, 'Euroaptieka', 'https://www.euroaptieka.lv/', {}],
  [/\bdrogas\b/i, 'Drogas', 'https://www.drogas.lv/', {}],
  [/hesburger/i, 'Hesburger', 'https://www.hesburger.lv/', {}],
  [/mc\s*donald/i, "McDonald's", 'https://www.mcdonalds.lv/', {}],
  [/\bkfc\b/i, 'KFC', 'https://www.kfc.lv/', {}],
  [/\bcaffeine\b/i, 'Caffeine', 'https://www.caffeine.lv/', {}],
  [/\bdepo\b/i, 'Depo', 'https://www.depo.lv/', {}],
  [/\bikea\b/i, 'IKEA', 'https://www.ikea.com/lv/lv/', {}],
  [/\belektrum\b/i, 'Elektrum', 'https://www.elektrum.lv/', {}],
];
function placeBrand(...names) {
  for (const n of names) if (n) for (const b of PLACE_BRANDS) if (b[0].test(n)) return b;
  return null;
}
function placePhone(raw) {
  if (!raw) return null;
  for (const part of String(raw).split(/[;,]/)) {
    let d = part.trim().replace(/^00/, '+').replace(/[\s\-().\/]/g, '');
    if (!/^\+?\d{7,15}$/.test(d)) continue;
    if (/^[2-9]\d{7}$/.test(d)) d = '+371' + d;          // vietējais LV numurs
    const lv = /^\+371(\d{8})$/.exec(d);
    const label = lv ? '+371 ' + lv[1].slice(0, 4) + ' ' + lv[1].slice(4) : d;
    return { tel: 'tel:' + d, label };
  }
  return null;
}
function placeWebsite(raw) {
  if (!raw) return null;
  let s = String(raw).split(';')[0].trim();
  if (!s || s.length > 300 || /[\s<>"'`\\]/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) { if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+([\/?#]|$)/i.test(s)) return null; s = 'https://' + s; }
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;   // nekādu javascript:, data:, file: u.c.
  if (u.username || u.password || u.port) return null;
  const h = u.hostname.toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) || /^[\d.]+$/.test(h) || !/[a-z]{2,}$/.test(h)) return null;
  u.protocol = 'https:';
  return { url: u.href, host: h.replace(/^www\./, '') };
}
// { phone, web, brandWeb, app: { name, android, ios } } — tikai tas, kas zināms; null, ja nekā nav.
function placeContacts(t, name) {
  t = t || {};
  const phone = placePhone(t.phone || t['contact:phone'] || t['contact:mobile'] || t.mobile);
  let web = placeWebsite(t.website || t['contact:website'] || t.url);
  const b = placeBrand(t.brand, t.name, t.operator, name);
  let brandWeb = false;
  if (!web && b) { web = placeWebsite(b[2]); brandWeb = true; }
  const app = b && (b[3].android || b[3].ios) ? {
    name: b[1],
    android: b[3].android ? 'https://play.google.com/store/apps/details?id=' + b[3].android : null,
    ios: b[3].ios ? 'https://apps.apple.com/lv/app/id' + b[3].ios : null,
  } : null;
  return phone || web || app ? { phone, web, brandWeb, app } : null;
}

// Kartes flīžu POI → vietu saraksts (pēc attāluma, bez dublikātiem no blakus flīzēm).
function parseTilePlaces(features, catId, lat, lng) {
  const c = PLACE_BY_ID[catId], want = new Set(PLACE_TILE_SUBCLASS[catId] || []);
  const out = [];
  for (const f of features || []) {
    const p = f.properties || {};
    if (!want.has(p.subclass)) continue;
    if (catId === 'park' && !p.name) continue;
    const g = f.geometry && f.geometry.type === 'Point' && f.geometry.coordinates;
    if (!g) continue;
    out.push({ id: 'tile' + out.length, osmType: null, osmId: null, cat: catId, name: placeDisplayName({ name: p.name, 'name:lv': p['name:lv'] }, catId),
      osmName: p.name || '', lat: g[1], lng: g[0], d: placeDistM(lat, lng, g[1], g[0]), addr: '', extra: [], oh: '', open: null,
      ct: placeContacts({}, p.name) });
  }
  return placeDedupe(out);
}
// Saglabātam sarakstam pārrēķina attālumus no jaunās vietas un sakārto.
function resortPlaces(places, lat, lng) {
  return places.map(p => Object.assign({}, p, { d: placeDistM(lat, lng, p.lat, p.lng) })).sort((a, b) => a.d - b.d);
}

// ---------- F3: Photon nosaukumi latviski / vietējā valodā ----------
// Bez `lang` Photon izvēlas valodu pēc pārlūka Accept-Language (piem. en-US → „Riga, Latvia”).
// `lang=lv` publiskais serveris neatbalsta (HTTP 400); `lang=default` atdod OSM `name` — Latvijā tas ir latviski.
const PHOTON_LANG = 'default';
// Drošības tabula: ja kāds lauks tomēr atnāk angliski (vai valsts vietējā valodā ārpus Latvijas)
const PHOTON_LV_NAMES = { Riga: 'Rīga', Latvia: 'Latvija', Jelgava: 'Jelgava', Liepaja: 'Liepāja', Jurmala: 'Jūrmala', Daugavpils: 'Daugavpils' };
const PHOTON_LV_COUNTRY = { LV: 'Latvija', EE: 'Igaunija', LT: 'Lietuva', RU: 'Krievija', BY: 'Baltkrievija', PL: 'Polija',
  FI: 'Somija', SE: 'Zviedrija', DE: 'Vācija', NO: 'Norvēģija', DK: 'Dānija', UA: 'Ukraina', GB: 'Lielbritānija', US: 'ASV' };
function photonLv(s) { return s && Object.prototype.hasOwnProperty.call(PHOTON_LV_NAMES, s) ? PHOTON_LV_NAMES[s] : s; }
// Meklēšanas rezultāts: nosaukums + adreses rinda (Latvijā valsti nerāda; ārzemēs — valsts latviski, ja zināma)
function photonSearchItem(f) {
  const p = f.properties || {};
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const place = photonLv(p.city || p.town || p.village || p.district);
  const name = photonLv(p.name) || street || place || 'Vieta';
  const cc = String(p.countrycode || '').toUpperCase();
  const country = cc === 'LV' ? '' : (PHOTON_LV_COUNTRY[cc] || p.country || '');
  const sub = [p.name && street ? street : '', place !== name ? place : '', country].filter(Boolean).join(', ');
  return { name, sub, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
}

// ---------- Ātrais ceļš: Photon (tuvākās vietas uzreiz) ----------
function buildPhotonPlacesUrl(catId, lat, lng, radiusKm, limit = 25) {
  const tags = PLACE_PHOTON_TAGS[catId];
  if (!tags) throw new Error('Nezināma kategorija: ' + catId);
  return `https://photon.komoot.io/reverse?lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}&radius=${radiusKm}&limit=${limit}&lang=${PHOTON_LANG}` +
    tags.map(t => '&osm_tag=' + encodeURIComponent(t)).join('');
}
const PHOTON_OSM_TYPE = { N: 'node', W: 'way', R: 'relation' };
function parsePhotonPlaces(features, catId, lat, lng) {
  const c = PLACE_BY_ID[catId];
  const out = [];
  for (const f of features || []) {
    const p = f.properties || {}, g = f.geometry && f.geometry.coordinates;
    if (!g) continue;
    const type = PHOTON_OSM_TYPE[p.osm_type];
    out.push({
      id: type ? type + p.osm_id : 'ph' + out.length, osmType: type || null, osmId: p.osm_id || null,
      cat: catId, name: placeDisplayName({ name: p.name }, catId), osmName: p.name || '', lat: g[1], lng: g[0], d: placeDistM(lat, lng, g[1], g[0]),
      addr: [p.street, p.housenumber].filter(Boolean).join(' '), extra: [], oh: '', open: null,
      ct: placeContacts({}, p.name),
    });
  }
  return placeDedupe(out);
}

// ---------- Papildinājums fonā: darba laiks u.c. pēc OSM id (ātrs Overpass vaicājums bez telpiskas meklēšanas) ----------
function buildPlaceDetailsQuery(places) {
  const ids = { node: [], way: [], relation: [] };
  for (const p of places) if (p.osmType && p.osmId) ids[p.osmType].push(p.osmId);
  const parts = Object.entries(ids).filter(([, v]) => v.length).map(([t, v]) => `  ${t}(id:${v.join(',')});`);
  return parts.length ? `[out:json][timeout:15];\n(\n${parts.join('\n')}\n);\nout tags;` : null;
}
// Pievieno darba laiku, maksu u.c.; privātās stāvvietas izmet. Atgriež jaunu sarakstu.
function mergePlaceDetails(places, elements, now = new Date(), parse = null) {
  const byId = new Map((elements || []).map(el => [el.type + el.id, el.tags || {}]));
  const out = [];
  for (const p of places) {
    const t = byId.get(p.id);
    if (!t) { out.push(p); continue; }
    if (p.cat === 'parking' && /^(private|no|customers)$/.test(t.access || '')) continue;
    const q = Object.assign({}, p, { extra: [] });
    q.name = placeDisplayName(t, p.cat); q.osmName = t.name || p.osmName || '';    // F24: pilnie OSM dati — tas pats nosaukums visur
    if (!q.addr) q.addr = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
    if (p.cat === 'parking') {
      if (t.fee === 'no') q.extra.push('bez maksas'); else if (t.fee === 'yes') q.extra.push('maksas');
      if (t.capacity) q.extra.push(t.capacity + ' vietas');
    }
    if (p.cat === 'ev') q.extra.push(...evInfo(t));
    if (p.cat === 'carwash') q.extra.push(...carWashInfo(t));
    if (p.cat === 'fuel' && t.brand && !q.name.toLowerCase().includes(t.brand.toLowerCase())) q.extra.push(t.brand);
    q.oh = t.opening_hours || '';
    q.open = placeOpenNow(q.oh, now, parse);
    q.ct = placeContacts(t, q.name);
    out.push(q);
  }
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = { PLACE_CATEGORIES, PLACE_PHOTON_TAGS, buildPlacesQuery, parsePlaces, placeOpenNow, placeIconSvg,
    buildPhotonPlacesUrl, parsePhotonPlaces, buildPlaceDetailsQuery, mergePlaceDetails, parseTilePlaces, resortPlaces, PLACE_TILE_SUBCLASS, placeStatus,
    placeContacts, placePhone, placeWebsite, placeBrand, PLACE_BRANDS, PHOTON_LANG, photonLv, photonSearchItem,
    PLACE_GENERIC_WORDS, isGenericName, placeDisplayName, placeLabelOne, evInfo, placeDedupe };
}
