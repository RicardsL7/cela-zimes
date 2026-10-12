// Zīmju datu modelis: viens strukturēts ieraksts katrai zīmei, datu validācija,
// pārbaudītu zīmju imports (GeoJSON), dublikātu / pretrunu noteikšana un GPS
// mērījuma kvalitāte. Lietotnei nav servera datubāzes — ieraksti dzīvo atmiņā,
// pārbaudītās zīmes var ielādēt no faila data/verified-signs.geojson.
//
// SignRecord = {
//   id:          unikāls ID ("mly:<id>", "osm:<id>", "ver:<id>", "gen:<n>")
//   type:        zīmes kods (Mapillary taksonomija, piem. "regulatory--no-parking--g1")
//   title:       nosaukums latviski
//   lat, lng:    koordinātas (WGS84)
//   segmentId:   ceļa posma ID, kam zīme piesaistīta (null — nav zināms)
//   roadId:      ceļa ID (OSM)
//   direction:   braukšanas virziens grādos, uz kuru zīme attiecas (null — nav zināms)
//   directionSource: 'face' | 'oneway' | 'side' | 'verified' | null
//   side:        +1 pa labi / -1 pa kreisi no braukšanas virziena
//   relatedTurn: { type, via:[lat,lng] } — saistītais pagrieziena ierobežojums
//   restriction: { known, days, times, months, ph, text, raw, extra, timezone, source, confidence }
//   source:      'mapillary' | 'osm' | 'verified' | 'generated'
//   verifiedAt:  pēdējās pārbaudes datums (ISO) vai null
//   quality:     'verified' | 'ok' | 'uncertain' | 'conflict' | 'unmatched'
// }

const MODEL_TZ = 'Europe/Riga';
const DUP_SAME_M = 5;        // tāda pati zīme tuvāk par šo — dublikāts
const CONFLICT_M = 8;        // dažādi ātrumi tuvāk par šo vienā virzienā — pretruna

// Strukturēts ierobežojums no parseCondition() rezultāta.
function makeRestriction(cond, source, confidence) {
  if (!cond || !cond.known) {
    return { known: false, days: null, times: [], months: null, ph: false, text: 'laiks nav zināms',
      raw: cond ? cond.raw : '', extra: cond ? cond.extra : '', timezone: MODEL_TZ, source, confidence: 'low' };
  }
  const on = cond.rules.filter(r => !r.off);
  return {
    known: true,
    days: on.some(r => r.days) ? [...new Set(on.flatMap(r => r.days || []))] : null,
    times: on.flatMap(r => r.times),
    months: on.some(r => r.months) ? [...new Set(on.flatMap(r => r.months || []))] : null,
    ph: on.some(r => r.ph),
    exceptions: cond.rules.filter(r => r.off),
    text: cond.ui, raw: cond.raw, extra: cond.extra || '', timezone: MODEL_TZ, source, confidence,
  };
}

// "Stāvēt aizliegts · P–Pk · 06:00–22:00" vai "Stāvēt aizliegts · laiks nav zināms".
function describeRestriction(title, restriction) {
  const t = String(title || '').replace(/^Ceļa zīme: /, '');
  if (!restriction) return t;
  return t + ' · ' + (restriction.known ? restriction.text : 'laiks nav zināms');
}

// Lietotnes zīmes objekts → SignRecord (piem. eksportam vai pārbaudei).
function toSignRecord(s) {
  const m = s._m || null;
  return {
    id: s.uid || null, type: s.value || ('osm:' + s.cat), title: s.title,
    lat: s.lat, lng: s.lng,
    segmentId: m && m.segId || null, roadId: m && m.roadId || null,
    direction: s.verifiedDir != null ? s.verifiedDir : (m && m.travelDir != null ? Math.round(m.travelDir) : null),
    directionSource: s.verifiedDir != null ? 'verified' : (m && m.dirSource) || null,
    side: m && m.side || null,
    relatedTurn: s.timeRule && s.timeRule.kind === 'turn' ? { type: s.timeRule.value, via: s.timeRule.via } : null,
    restriction: s.restriction || null,
    source: s.source || (s.value ? 'mapillary' : 'osm'),
    verifiedAt: s.verifiedAt || null,
    quality: s.verifiedAt ? 'verified' : s.conflict ? 'conflict' : m === null ? 'unmatched' : (m && m.quality) || 'ok',
  };
}

// Validē ierakstu. Atgriež kļūdu sarakstu (tukšs — derīgs).
function validateRecord(r) {
  const err = [];
  if (!r || typeof r !== 'object') return ['ieraksts nav objekts'];
  if (!r.id || typeof r.id !== 'string') err.push('nav ID');
  if (!r.type || typeof r.type !== 'string') err.push('nav zīmes veida');
  if (!(typeof r.lat === 'number' && r.lat >= -90 && r.lat <= 90)) err.push('nederīgs platums');
  if (!(typeof r.lng === 'number' && r.lng >= -180 && r.lng <= 180)) err.push('nederīgs garums');
  if (r.direction != null && !(typeof r.direction === 'number' && r.direction >= 0 && r.direction < 360)) err.push('nederīgs virziens (0–359)');
  if (r.side != null && r.side !== 1 && r.side !== -1) err.push('puse jābūt 1 vai -1');
  if (r.verifiedAt != null && isNaN(Date.parse(r.verifiedAt))) err.push('nederīgs pārbaudes datums');
  if (r.restriction && r.restriction.known) {
    for (const t of r.restriction.times || []) {
      if (!/^\d{2}:\d{2}$/.test(t.start) || !/^\d{2}:\d{2}$/.test(t.end)) err.push('nederīgs laiks ' + JSON.stringify(t));
    }
  }
  return err;
}

// Pārbaudītu zīmju imports no GeoJSON FeatureCollection. Katram punktam properties:
//   id, type, direction (grādi, braukšanas virziens), opening_hours (piem. "Mo-Fr 06:00-22:00"),
//   plate_text, verified_at, source.
// Atgriež { records, errors: [{ index, id, errors }] }. Nederīgus ierakstus neimportē.
function parseVerifiedGeoJSON(json, parse) {
  const out = { records: [], errors: [] };
  const feats = json && json.type === 'FeatureCollection' && Array.isArray(json.features) ? json.features : null;
  if (!feats) { out.errors.push({ index: -1, errors: ['nav GeoJSON FeatureCollection'] }); return out; }
  feats.forEach((f, i) => {
    const p = (f && f.properties) || {};
    const g = f && f.geometry;
    const coords = g && g.type === 'Point' && Array.isArray(g.coordinates) ? g.coordinates : [];
    const cond = p.opening_hours ? parse(p.opening_hours) : null;
    const rec = {
      id: p.id != null ? 'ver:' + p.id : null, type: p.type, title: p.title || null,
      lat: coords[1], lng: coords[0],
      direction: p.direction != null ? Number(p.direction) : null, directionSource: p.direction != null ? 'verified' : null,
      side: p.side != null ? Number(p.side) : null,
      restriction: p.opening_hours ? makeRestriction(cond, p.source || 'verified', 'high') : null,
      plateText: p.plate_text || null,
      source: 'verified', verifiedAt: p.verified_at || null, quality: 'verified',
    };
    if (p.opening_hours && !(cond && cond.known)) {
      out.errors.push({ index: i, id: rec.id, errors: ['opening_hours nav saprotams: ' + p.opening_hours] });
      return;
    }
    const e = validateRecord(rec);
    if (e.length) out.errors.push({ index: i, id: rec.id, errors: e });
    else out.records.push(rec);
  });
  return out;
}

// No foto nolasītie plāksnīšu laiki (data/plate-times.json):
//   { entries: [{ id, type, lat, lng, opening_hours, plate_text, source, read_at, confidence, image }] }
// Ieraksts attiecas uz TĀDA PAŠA veida zīmēm PLATE_MATCH_M rādiusā (Mapillary vienu fizisku
// zīmi bieži saglabā vairākkārt). Nesaprotamu laiku neimportē — zīmei paliek "laiks nav zināms".
const PLATE_MATCH_M = 8;
function parsePlateTimes(json, parse) {
  const out = { records: [], errors: [] };
  const list = json && Array.isArray(json.entries) ? json.entries : null;
  if (!list) { out.errors.push({ index: -1, errors: ['nav "entries" saraksta'] }); return out; }
  list.forEach((e, i) => {
    const err = [];
    if (!e || typeof e.type !== 'string' || !e.type) err.push('nav zīmes veida');
    if (!(e && typeof e.lat === 'number' && Math.abs(e.lat) <= 90 && typeof e.lng === 'number' && Math.abs(e.lng) <= 180)) err.push('nederīgas koordinātas');
    const cond = e && e.opening_hours ? parse(e.opening_hours) : null;
    if (!(cond && cond.known)) err.push('laiks nav saprotams: ' + (e && e.opening_hours));
    if (err.length) { out.errors.push({ index: i, id: e && e.id, errors: err }); return; }
    out.records.push({
      id: e.id || null, type: e.type, lat: e.lat, lng: e.lng, cond,
      restriction: makeRestriction(cond, e.source || 'mapillary-foto', e.confidence || 'medium'),
      plateText: e.plate_text || null, readAt: e.read_at || null, image: e.image || null,
    });
  });
  return out;
}

// Dublikātu un pretrunu noteikšana (režģis ~30 m šūnās).
class SignDeduper {
  constructor() { this.grid = new Map(); }
  _near(lat, lng, fn) {
    const gx = Math.round(lat / 0.0003), gy = Math.round(lng / 0.0005);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const p of this.grid.get((gx + i) + ':' + (gy + j)) || []) {
        const d = Math.hypot((p.lat - lat) * 111320, (p.lng - lng) * 111320 * Math.cos(lat * Math.PI / 180));
        const r = fn(p, d);
        if (r) return r;
      }
    }
    return null;
  }
  // Pārbauda jaunu zīmi. Atgriež { status: 'ok' | 'duplicate' | 'conflict', other }.
  //   • Mapillary/pārbaudīta: tāda pati zīme ≤ 5 m — dublikāts.
  //   • OSM (bez koda): tāda paša veida zīme ≤ 20 m — dublikāts (OSM bieži dublē Mapillary).
  //   • Ātrums: cits ierobežojums ≤ 8 m — pretruna (abas atzīmē; neviena netiek izmesta).
  check(lat, lng, cat, value, limit) {
    const dup = this._near(lat, lng, (p, d) =>
      (value ? (p.value === value && d < DUP_SAME_M) : (p.cat === cat && d < 20)) ? p : null);
    if (dup) return { status: dup.verified ? 'duplicate-of-verified' : 'duplicate', other: dup };
    if (cat === 'speed' && limit) {
      const c = this._near(lat, lng, (p, d) => (p.cat === 'speed' && p.limit && p.limit !== limit && d < CONFLICT_M) ? p : null);
      if (c) return { status: 'conflict', other: c };
    }
    return { status: 'ok', other: null };
  }
  add(lat, lng, cat, value, limit, ref, verified) {
    const gx = Math.round(lat / 0.0003), gy = Math.round(lng / 0.0005), k = gx + ':' + gy;
    if (!this.grid.has(k)) this.grid.set(k, []);
    const e = { lat, lng, cat, value, limit, ref, verified: !!verified };
    this.grid.get(k).push(e);
    return e;
  }
}

// GPS mērījuma kvalitāte: 'good' (≤ 20 m), 'fair' (≤ 40 m), 'poor' (> 40 m).
// Ar 'poor' nemaina braukšanas virzienu un nevērtē nobraukšanu no maršruta.
function gpsFixQuality(accuracy) {
  if (accuracy == null || isNaN(accuracy)) return 'good';   // simulācija / testa klikšķis
  if (accuracy <= 20) return 'good';
  if (accuracy <= 40) return 'fair';
  return 'poor';
}

if (typeof module !== 'undefined') {
  module.exports = { makeRestriction, describeRestriction, toSignRecord, validateRecord, parseVerifiedGeoJSON, parsePlateTimes, SignDeduper, gpsFixQuality };
}
