// Sastrēgumu karte — loģika bez kartes (pārbaudāma ar testiem).
//   • TrafficCollector: no GPS mērījumiem braucot veido anonīmus ātrumus pa šūnām (~55×30 m) un
//     virzieniem (8 sektori). Brauciena sākuma un beigu 400 m nekad neatdod (mājas, darbs).
//   • trLevel: cik stiprs sastrēgums (0 — nav, 1 — lēni, 2 — sastrēgums, 3 — stāv).
//   • trRouteDelay: cik minūšu sastrēgumi pieliek maršrutam.

const TR_CELL = 2000;                         // šūna = 1/2000° (~55 m pa platumu, ~30 m pa garumu)
const TR_PRIVACY_M = 400;                     // brauciena sākuma un beigu zona, ko nesūta
const TR_STOP_END_MS = 10 * 60000;            // stāv ilgāk — brauciens beidzies
const TR_CLASS = { motorway: 1, trunk: 2, primary: 3, secondary: 4, tertiary: 5, minor: 6, service: 7 };
const TR_FREE = { 1: 100, 2: 80, 3: 50, 4: 45, 5: 40, 6: 30, 7: 20, 0: 40 };   // brīvas kustības ātrums, ja vēstures nav

function trCell(lat, lng) { return Math.floor(lat * TR_CELL) + '_' + Math.floor(lng * TR_CELL); }
function trCellCenter(cell) {
  const [a, b] = cell.split('_').map(Number);
  return { lat: (a + 0.5) / TR_CELL, lng: (b + 0.5) / TR_CELL };
}
function trDir(bearing) { return Math.round((((bearing % 360) + 360) % 360) / 45) % 8; }
function trDist(a, b) {
  const k = 111320, cos = Math.cos(a.lat * Math.PI / 180);
  return Math.hypot((b.lat - a.lat) * k, (b.lng - a.lng) * k * cos);
}

class TrafficCollector {
  constructor() { this.reset(); }
  reset() { this.cur = null; this.queue = []; this.out = []; this.tripStart = null; this.stillSince = null; this.last = null; }
  // f = { lat, lng, t (ms), kmh, bearing (ceļa virziens braucot), acc, cls } — lat/lng jau piesaistīti ceļam
  add(f) {
    if (f.acc != null && f.acc > 25) return;
    const moving = f.kmh != null ? f.kmh > 3 : true;
    // Brauciena sākums / beigas
    if (!this.tripStart && f.kmh != null && f.kmh > 12) this.tripStart = { lat: f.lat, lng: f.lng };
    if (!moving) {
      if (this.stillSince == null) this.stillSince = f.t;
      else if (f.t - this.stillSince > TR_STOP_END_MS && this.tripStart) this.endTrip(f);
    } else this.stillSince = null;
    if (!this.tripStart || f.bearing == null) { this.last = f; return; }

    const cell = trCell(f.lat, f.lng), dir = trDir(f.bearing);
    const c = this.cur;
    if (c && f.t - c.lastT > 30000) this.cur = null;                 // GPS pārtraukums — šo šūnu izmet
    if (this.cur && this.cur.cell === cell && this.cur.dir === dir) {
      this.cur.d += trDist(this.cur.lastPos, f);
      this.cur.lastT = f.t; this.cur.lastPos = f;
    } else {
      if (this.cur) {
        const d = this.cur.d + trDist(this.cur.lastPos, f), dt = (f.t - this.cur.t0) / 1000;
        if (d >= 20 && dt >= 3 && d / dt < 60) {                          // < 216 km/h
          const ctr = trCellCenter(this.cur.cell);
          this.queue.push({ c: this.cur.cell, d: this.cur.dir, v: Math.round(d / dt * 36) / 10, k: this.cur.cls, lat: ctr.lat, lng: ctr.lng, t: f.t });
          if (this.queue.length > 600) this.queue.shift();
        }
      }
      this.cur = { cell, dir, t0: f.t, lastT: f.t, d: 0, lastPos: f, cls: f.cls || 0 };
    }
    this.last = f;
  }
  // Brauciens beidzies: pēdējos 400 m pirms apstāšanās izmet, pārējo (ja tālu no sākuma) liek sūtīšanai.
  endTrip(f) {
    for (const it of this.queue)
      if (trDist(it, f) > TR_PRIVACY_M && (!this.tripStart || trDist(it, this.tripStart) > TR_PRIVACY_M)) this.out.push(it);
    this.queue = []; this.tripStart = null; this.cur = null;
  }
  // Mērījumi, ko drīkst sūtīt: tālāk par 400 m no brauciena sākuma un no pašreizējās vietas, vecāki par 1 min.
  ready(pos) {
    const out = this.out, keep = [];
    this.out = [];
    for (const it of this.queue) {
      const farStart = !this.tripStart || trDist(it, this.tripStart) > TR_PRIVACY_M;
      if (farStart && trDist(it, pos) > TR_PRIVACY_M && pos.t - it.t > 60000) out.push(it);
      else if (farStart || this.tripStart) keep.push(it);
    }
    this.queue = keep;
    return out.map(({ c, d, v, k }) => ({ c, d, v, k }));
  }
}

// Sastrēguma līmenis: salīdzina ar parasto ātrumu šajā vietā (vai brīvās kustības ātrumu).
function trLevel(kmh, typical, cls) {
  const free = TR_FREE[cls] || 40;
  const ref = Math.max(typical && typical >= 12 ? typical : 0, free * 0.7);
  if ((cls || 0) >= 6 && !(typical >= 25)) return 0;                  // mazās ielas bez vēstures — nevērtē
  const r = kmh / ref;
  return r < 0.25 ? 3 : r < 0.45 ? 2 : r < 0.65 ? 1 : 0;
}

// Maršruta kavējums: ik 40 m pa maršrutu meklē sastrēguma šūnu tajā pašā virzienā.
// route.coords [[lng, lat], …]; jams: Map "cell|dir" → { kmh, typical, cls }
function trRouteDelay(coords, jams) {
  let sec = 0, worst = null, acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = { lng: coords[i - 1][0], lat: coords[i - 1][1] }, b = { lng: coords[i][0], lat: coords[i][1] };
    const len = trDist(a, b);
    if (!len) continue;
    const cos = Math.cos(a.lat * Math.PI / 180);
    const br = (Math.atan2((b.lng - a.lng) * cos, b.lat - a.lat) * 180 / Math.PI + 360) % 360;
    for (let s = acc; s < len; s += 40) {
      const f = s / len, p = { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
      const j = jams.get(trCell(p.lat, p.lng) + '|' + trDir(br));
      if (!j) continue;
      const lvl = trLevel(j.kmh, j.typical, j.cls);
      if (!lvl) continue;
      const ref = Math.max(j.typical || 0, (TR_FREE[j.cls] || 40) * 0.7);
      const extra = 40 / (Math.max(j.kmh, 3) / 3.6) - 40 / (ref / 3.6);
      if (extra > 0) sec += extra;
      if (!worst || lvl > worst.lvl) worst = { lvl, lat: p.lat, lng: p.lng };
    }
    acc = (acc + Math.ceil((len - acc) / 40) * 40) - len;
    if (acc < 0) acc = 0;
  }
  return { sec: Math.round(sec), worst };
}

if (typeof module !== 'undefined') {
  module.exports = { TR_CELL, TR_CLASS, trCell, trCellCenter, trDir, TrafficCollector, trLevel, trRouteDelay };
}
