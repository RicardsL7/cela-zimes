// ---------- Vietas tuvumā (kā Waze "Categories") ----------
// Kategorijas → OpenStreetMap birkas. Meklē Overpass ap mani (vai kartes centru).
// Tikai reāli OSM dati: nosaukums, adrese, darba laiks, zīmols.

const PLACE_W = '#fff';
const PLACE_CATEGORIES = [
  { id: 'fuel',     label: 'Degviela',            color: '#2f9e44', q: ['nwr["amenity"="fuel"]'],
    glyph: `<path d="M8 6.5h7v12H8Z" fill="none" stroke="${PLACE_W}" stroke-width="1.8" stroke-linejoin="round"/><path d="M9.7 8.5h3.6v3H9.7Z" fill="${PLACE_W}"/><path d="M15 10h1.4a1.3 1.3 0 0 1 1.3 1.3v4.2a1 1 0 0 0 2 0V9.8L18 8" fill="none" stroke="${PLACE_W}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>` },
  { id: 'food',     label: 'Ēdiens',              color: '#e8590c', q: ['nwr["amenity"~"^(restaurant|fast_food|food_court)$"]'],
    glyph: `<path d="M8.5 5.5v5.2M7 5.5v3.8a1.5 1.5 0 0 0 3 0V5.5M8.5 10.7V18.5" fill="none" stroke="${PLACE_W}" stroke-width="1.6" stroke-linecap="round"/><path d="M15.5 18.5V5.5c-1.8.8-2.6 2.8-2.6 5.2 0 1.4.9 2.2 2.6 2.2" fill="none" stroke="${PLACE_W}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>` },
  { id: 'parking',  label: 'Stāvvieta',           color: '#1c7ed6', q: ['nwr["amenity"="parking"]["access"!~"^(private|no|customers)$"]'],
    glyph: `<path d="M9.5 18V6.5h3.6a3.3 3.3 0 0 1 0 6.6H9.5" fill="none" stroke="${PLACE_W}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>` },
  { id: 'grocery',  label: 'Pārtikas veikali',    color: '#37b24d', q: ['nwr["shop"~"^(supermarket|convenience|greengrocer)$"]'],
    glyph: `<path d="M5.5 6.5h2l1.6 8h7.4l1.5-5.6H8.3" fill="none" stroke="${PLACE_W}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="17.6" r="1.2" fill="${PLACE_W}"/><circle cx="15.6" cy="17.6" r="1.2" fill="${PLACE_W}"/>` },
  { id: 'coffee',   label: 'Kafija',              color: '#9c6b3f', q: ['nwr["amenity"="cafe"]'],
    glyph: `<path d="M6.5 10h9v3.5a4 4 0 0 1-4 4h-1a4 4 0 0 1-4-4Z" fill="none" stroke="${PLACE_W}" stroke-width="1.7" stroke-linejoin="round"/><path d="M15.5 11h1.2a1.8 1.8 0 0 1 0 3.6h-1.4M9 5.5c-.6.8.6 1.4 0 2.2M12 5.5c-.6.8.6 1.4 0 2.2" fill="none" stroke="${PLACE_W}" stroke-width="1.5" stroke-linecap="round"/>` },
  { id: 'shopping', label: 'Iepirkšanās',         color: '#d6336c', q: ['nwr["shop"~"^(mall|department_store|clothes|shoes|electronics|doityourself|hardware|furniture)$"]'],
    glyph: `<path d="M6.5 9h11l-.8 9.5H7.3Z" fill="none" stroke="${PLACE_W}" stroke-width="1.7" stroke-linejoin="round"/><path d="M9.5 10.5V8a2.5 2.5 0 0 1 5 0v2.5" fill="none" stroke="${PLACE_W}" stroke-width="1.7" stroke-linecap="round"/>` },
  { id: 'pharmacy', label: 'Aptiekas',            color: '#12b886', q: ['nwr["amenity"="pharmacy"]'],
    glyph: `<rect x="5.6" y="9.4" width="12.8" height="5.2" rx="2.6" transform="rotate(-45 12 12)" fill="none" stroke="${PLACE_W}" stroke-width="1.7"/><path d="m10.1 10.1 3.8 3.8" stroke="${PLACE_W}" stroke-width="1.7"/>` },
  { id: 'ev',       label: 'EV uzlāde',           color: '#0c8599', q: ['nwr["amenity"="charging_station"]'],
    glyph: `<path d="M13 4.5 7.5 13h4l-1 6.5L16.5 11h-4Z" fill="${PLACE_W}"/>` },
  { id: 'medical',  label: 'Medicīniskā palīdzība', color: '#e03131', q: ['nwr["amenity"~"^(hospital|clinic|doctors)$"]'],
    glyph: `<path d="M10 6h4v4h4v4h-4v4h-4v-4H6v-4h4Z" fill="${PLACE_W}"/>` },
  { id: 'hotel',    label: 'Viesnīcas',           color: '#7048e8', q: ['nwr["tourism"~"^(hotel|motel|guest_house|hostel)$"]'],
    glyph: `<path d="M5.5 17.5V7M5.5 13.5h13v4M18.5 13.5v-1.8a2.2 2.2 0 0 0-2.2-2.2H11v4" fill="none" stroke="${PLACE_W}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8.3" cy="11" r="1.5" fill="${PLACE_W}"/>` },
  { id: 'park',     label: 'Parki',               color: '#5c940d', q: ['nwr["leisure"="park"]["name"]'],
    glyph: `<path d="M12 4.5c-2.6 0-4.3 2.2-4.3 4.6 0 .5 0 .9.2 1.3A3.3 3.3 0 0 0 9.7 16h4.6a3.3 3.3 0 0 0 1.8-5.6c.2-.4.2-.8.2-1.3 0-2.4-1.7-4.6-4.3-4.6Z" fill="none" stroke="${PLACE_W}" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 11v8" stroke="${PLACE_W}" stroke-width="1.7" stroke-linecap="round"/>` },
  { id: 'crisis',   label: 'Ārkārtas palīdzība',  color: '#c92a2a', q: ['nwr["amenity"~"^(police|fire_station)$"]', 'nwr["amenity"="hospital"]["emergency"="yes"]', 'nwr["social_facility"="shelter"]'],
    glyph: `<path d="M12 4.5 18.5 7v4.6c0 3.9-2.7 6.7-6.5 7.9-3.8-1.2-6.5-4-6.5-7.9V7Z" fill="none" stroke="${PLACE_W}" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 8.5v4.2" stroke="${PLACE_W}" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="15.2" r="1.1" fill="${PLACE_W}"/>` },
];
const PLACE_BY_ID = Object.fromEntries(PLACE_CATEGORIES.map(c => [c.id, c]));

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

// Overpass elementi → vietu saraksts (pēc attāluma, bez dublikātiem).
function parsePlaces(elements, catId, lat, lng, now = new Date(), parse = null) {
  const c = PLACE_BY_ID[catId];
  const out = [];
  for (const el of elements || []) {
    const t = el.tags || {};
    const plat = el.lat != null ? el.lat : el.center && el.center.lat;
    const plng = el.lon != null ? el.lon : el.center && el.center.lon;
    if (plat == null || plng == null) continue;
    const name = t.name || t.brand || t.operator || c.label;
    const addr = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
    const extra = [];
    if (catId === 'parking') {
      if (t.fee === 'no') extra.push('bez maksas'); else if (t.fee === 'yes') extra.push('maksas');
      if (t.capacity) extra.push(t.capacity + ' vietas');
    }
    if (catId === 'ev' && t.capacity) extra.push(t.capacity + ' uzlādes vietas');
    if (catId === 'fuel' && t.brand && t.brand !== name) extra.push(t.brand);
    out.push({
      id: el.type + el.id, cat: catId, name, lat: plat, lng: plng,
      d: placeDistM(lat, lng, plat, plng),
      addr, extra, oh: t.opening_hours || '', open: placeOpenNow(t.opening_hours, now, parse),
    });
  }
  out.sort((a, b) => a.d - b.d);
  const kept = [];
  for (const p of out) if (!kept.some(k => k.name === p.name && placeDistM(k.lat, k.lng, p.lat, p.lng) < 60)) kept.push(p);
  return kept;
}

if (typeof module !== 'undefined') {
  module.exports = { PLACE_CATEGORIES, buildPlacesQuery, parsePlaces, placeOpenNow, placeIconSvg };
}
