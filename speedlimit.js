// Ātruma ierobežojums zem manis (labojums F7) — loģika bez kartes (testējama).
//   • speedSignKind: vai zīme maina ierobežojumu (ātruma zīme / beigas / apdzīvotas vietas sākums vai beigas);
//   • decideSpeedLimit: prioritāte — garām pabraukta zīme → OSM maxspeed → Latvijas noklusējums (aptuveni);
//   • SpeedLimitHold: aizture pret mirgošanu (ja uz brīdi nav zināms — rāda pēdējo vēl ~5 s / ~100 m);
//   • isOverspeed: brīdinājums (ātrums > ierobežojums + 3; ja ātrums nav zināms — nav brīdinājuma).

// Latvijas noklusētie ātrumi (CSN): apdzīvotā vietā 50, ārpus — 90, dzīvojamā zonā 20 km/h.
const SL_DEFAULT = { urban: 50, rural: 90, living: 20 };
const SL_OVER_MARGIN = 3;                 // km/h virs ierobežojuma, no kura brīdina
const SL_HOLD_MS = 5000, SL_HOLD_M = 100;  // cik ilgi / tālu rāda pēdējo vērtību, ja uz brīdi nav zināms
// Ceļu klases (OpenMapTiles), kurās bez citas informācijas droši var pieņemt apdzīvotas vietas 50 km/h
const SL_TOWN_CLASSES = new Set(['minor', 'service', 'tertiary']);

// Zīmes nozīme ierobežojumam: { kind: 'speed', limit } | { kind: 'end' } | { kind: 'urban' } | { kind: 'rural' } | null.
// Pašas lietotnes uzliktās zīmes OSM ceļa sākumā (wayStart) neņem — tās ir tikai OSM maxspeed attēlojums.
function speedSignKind(s) {
  if (!s || s.wayStart) return null;
  const v = String(s.value || '').toLowerCase();
  if (/end-of-(maximum-speed|speed-limit)/.test(v)) return { kind: 'end' };
  if (s.cat === 'speed') {
    const limit = s.limit || Number((v.match(/maximum-speed-limit-(\d{1,3})(?!\d)/) || [])[1]) || null;
    return limit ? { kind: 'speed', limit } : null;
  }
  if (/end-of-(built-up-area|city-limit|town|settlement)|built-up-area-end|city-limit-end/.test(v)) return { kind: 'rural' };
  if (/built-up-area|city-limit|town-limit|settlement|entering-town/.test(v) || s.kind === 'city' || /^Apdzīvotas vietas sākums/.test(s.title || '')) return { kind: 'urban' };
  return null;
}

// Galīgais ierobežojums. sign — garām pabrauktās zīmes skaitlis; osm — { limit, implicit } no OSM ceļa;
// urban — true / false / null (nav zināms); cls — ceļa klase; living — dzīvojamā zona.
// Atgriež { limit, source: 'sign' | 'osm' | 'default', approx } vai null (nerāda neko).
function decideSpeedLimit({ sign = null, osm = null, urban = null, cls = null, living = false } = {}) {
  if (sign) return { limit: sign, source: 'sign', approx: false };
  if (osm && osm.limit && !osm.implicit) return { limit: osm.limit, source: 'osm', approx: false };
  if (osm && osm.limit) return { limit: osm.limit, source: 'default', approx: true };   // LV:urban / LV:rural u.c.
  if (living) return { limit: SL_DEFAULT.living, source: 'default', approx: true };
  if (urban === true) return { limit: SL_DEFAULT.urban, source: 'default', approx: true };
  if (urban === false) return { limit: SL_DEFAULT.rural, source: 'default', approx: true };
  if (cls && SL_TOWN_CLASSES.has(cls)) return { limit: SL_DEFAULT.urban, source: 'default', approx: true };
  return null;
}

function isOverspeed(speedKmh, res, warn = true) {
  return !!(warn && res && res.limit != null && speedKmh != null && !isNaN(speedKmh) && speedKmh > res.limit + SL_OVER_MARGIN);
}

// Aizture: jauns null nenomaina rādīto vērtību uzreiz — tikai pēc ~5 s vai ~100 m.
class SpeedLimitHold {
  constructor() { this.last = null; this.at = 0; this.pos = null; }
  reset() { this.last = null; this.at = 0; this.pos = null; }
  // res — šī brīža rezultāts (vai null); now — ms; lat/lng — mana vieta
  update(res, now, lat, lng) {
    if (res) { this.last = res; this.at = now; this.pos = { lat, lng }; return res; }
    if (!this.last) return null;
    const moved = this.pos && lat != null ? slDist(this.pos.lat, this.pos.lng, lat, lng) : 0;
    if (now - this.at > SL_HOLD_MS || moved > SL_HOLD_M) { this.reset(); return null; }
    return Object.assign({}, this.last, { held: true });
  }
}
function slDist(lat1, lng1, lat2, lng2) {
  const k = 111320, x = (lng2 - lng1) * k * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180), y = (lat2 - lat1) * k;
  return Math.hypot(x, y);
}
// Vai rezultāts mainījies (notikumam 'speedlimitchange')
function speedLimitKey(res) { return res ? res.limit + '|' + res.source + '|' + (res.approx ? 1 : 0) : ''; }

if (typeof module !== 'undefined') module.exports = { SL_DEFAULT, speedSignKind, decideSpeedLimit, isOverspeed, SpeedLimitHold, speedLimitKey };
