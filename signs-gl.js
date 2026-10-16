// Zīmju slānis MapLibre kartē. Zīmes glabājas telpiskā indeksā, bet kartei
// tiek dotas tikai tās, kas ir redzamajā apgabalā. Pārklāšanos nokārto pati
// karte (svarīgākās zīmes paliek, pārējās paslēpjas), un zīmes griežas un
// sasveras kopā ar karti.
//
// Katra zīme tiek piesaistīta konkrētam ceļa posmam (roads-gl.js → snapSign):
// zināms posms, braukšanas virziens, uz kuru tā attiecas, puse un piesaistes
// kvalitāte.
//
// Kuras zīmes attiecas uz MANI, nosaka viena funkcija — getApplicableSigns():
//   1. mans ceļa posms (RoadTracker — kartes piesaiste ar vēsturi),
//   2. braukšanas virziens,
//   3. trajektorija: maršruta posmi vai (bez maršruta) mans ceļš uz priekšu,
//   4. krustojumi un manevri uz tās,
//   5. zīmes, kuru CEĻA POSMS ir šajā trajektorijā (nevis "tuvumā"),
//   6. zīmes virziens; pagriezienu zīmēm — krustojums priekšā, joslu neskaidrība, manevrs,
//   7. statuss: 'confirmed' (attiecas), 'probable' (virziens tikai minēts pēc ceļa puses),
//      'unconfirmed' / 'lane-unknown' / 'contradicts-route' (NErāda kā saistošu).
// Attālums ir tikai papildu kritērijs, nevis pierādījums.

const SIGN_PRIORITY = { speed: 0, priority: 1, camera: 2, rail: 3, signals: 4, calming: 5, crossing: 6, other: 7 };
const SIGN_GRID = 0.01;      // telpiskā indeksa šūna grādos
const SIGN_IMG_PX = 64;      // zīmju attēlu izmērs (pikseļi), rāda kā 32 px
const ROUTE_CELL = 0.002;    // maršruta posmu indeksa šūna (~200 m)
const ROUTE_NEAR_M = 28;     // ātrā atlase: zīme ne tālāk par šo no maršruta ass
const ROUTE_ANGLE = 50;      // cik grādu zīmes virziens drīkst atšķirties no maršruta
const PATH_TOL_M = 1.5;      // kartes posms "iet pa" manu ceļu (dublikāti flīžu malās ir tajā pašā vietā)
const ROUTE_SEG_TOL_M = 4;   // maršruta (OSRM) līnija pret kartes ceļa asi — vienkāršošanas kļūda
const OWN_SIGN_TOL_M = 4;    // OSM zīme (mezgls uz ceļa) pret trajektoriju
const TURN_APPROACH_M = 80;  // pagrieziena zīme — ne tālāk par šo pirms krustojuma
const BOTH_WAYS_CATS = new Set(['signals', 'crossing', 'rail', 'calming']);   // OSM objekti, kas attiecas uz abiem virzieniem
const ENTRY_SIGN = /--no-entry--/;   // iebraukt aizliegts — attiecas uz iebrauktuvi krustojumā
const ENTRY_JUNCTION_M = 40;         // ... tāpēc krustojumam jābūt ne tālāk par šo
// Ceļi, kuros var būt vairākas joslas vienā virzienā. Joslu dati nav pieejami, tāpēc
// obligātā virziena zīmes tajos NEattiecina uz visām joslām.
const MULTI_LANE_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);

// Pagriezienu zīmes: { kind: 'only' | 'no', dirs: ['left'|'right'|'straight'|'uturn'] } vai null.
function turnRule(value) {
  const v = String(value || '');
  if (!/^regulatory--/.test(v)) return null;
  if (/no-left-turn/.test(v)) return { kind: 'no', dirs: ['left'] };
  if (/no-right-turn/.test(v)) return { kind: 'no', dirs: ['right'] };
  if (/no-u-turn/.test(v)) return { kind: 'no', dirs: ['uturn'] };
  if (/no-straight-through/.test(v)) return { kind: 'no', dirs: ['straight'] };
  if (/go-straight-or-turn-right/.test(v)) return { kind: 'only', dirs: ['straight', 'right'] };
  if (/go-straight-or-turn-left/.test(v)) return { kind: 'only', dirs: ['straight', 'left'] };
  if (/turn-left-or-(turn-)?right/.test(v)) return { kind: 'only', dirs: ['left', 'right'] };
  if (/--go-straight--/.test(v)) return { kind: 'only', dirs: ['straight'] };
  if (/--turn-right(-ahead)?--/.test(v)) return { kind: 'only', dirs: ['right'] };
  if (/--turn-left(-ahead)?--/.test(v)) return { kind: 'only', dirs: ['left'] };
  return null;
}
// OSRM manevra virziens: 'left' | 'right' | 'straight' | 'uturn'.
function maneuverDir(modifier) {
  const m = String(modifier || 'straight');
  if (/uturn/.test(m)) return 'uturn';
  if (/left/.test(m)) return 'left';
  if (/right/.test(m)) return 'right';
  return 'straight';
}
const REL_BY_STATUS = { confirmed: 'mine', probable: 'unknown', unconfirmed: 'other', 'lane-unknown': 'other', 'contradicts-route': 'other' };

function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

class SignStore {
  constructor(map) {
    this.map = map;
    this.grid = new Map();
    this.count = 0;
    this.filter = () => true;
    this.heading = null;
    this.roads = null;       // roadIndex vai null
    this.enabled = true;
    this.decorate = null;    // s → { time, off, unk, info } (laika ierobežojumi)
    this.iconFor = null;     // s → attēla id (brīdinājumu režīmā — vienotas ikonas)
    this.titleFor = null;    // s → nosaukums
    this.iconUrl = new Map(); // attēla id -> adrese
    this.loading = new Set();
    this._timer = null;
    // Maršruts
    this.route = null;
    this.routeGrid = null;
    this.routeAlong = null;  // cik metru no maršruta jau nobraukts (navigācijā)
    this.routeList = [];     // [{ s, along, status, reason }] maršruta zīmes pēc kārtas
    this._routeDirty = false;
    this._routePath = null;
    // Brīvā braukšana: kur esmu (RoadTracker) un kuras zīmes uz mana ceļa priekšā
    this.tracker = null;
    this.pos = null;
    this._free = null;       // { list, status: Map s → it, opposite: Set }
    this._freeDirty = true;
  }

  // ---------- Dati ----------
  add(s) {
    const k = Math.floor(s.lat / SIGN_GRID) + ':' + Math.floor(s.lng / SIGN_GRID);
    if (!this.grid.has(k)) this.grid.set(k, []);
    this.grid.get(k).push(s);
    this.count++;
    if (!this.iconUrl.has(s.icon)) this.iconUrl.set(s.icon, s.src);
    if (this.route) this._routeDirty = true;
  }

  eachInBox(s, w, n, e, fn) {
    for (let la = Math.floor(s / SIGN_GRID); la <= Math.floor(n / SIGN_GRID); la++)
      for (let lo = Math.floor(w / SIGN_GRID); lo <= Math.floor(e / SIGN_GRID); lo++)
        for (const x of this.grid.get(la + ':' + lo) || [])
          if (x.lat >= s && x.lat <= n && x.lng >= w && x.lng <= e) fn(x);
  }

  findNear(lat, lng, maxM, test) {
    let best = null, bestD = maxM;
    const la = Math.floor(lat / SIGN_GRID), lo = Math.floor(lng / SIGN_GRID);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const s of this.grid.get((la + i) + ':' + (lo + j)) || []) {
        if (test && !test(s)) continue;
        const d = Math.hypot((s.lat - lat) * 111320, (s.lng - lng) * 111320 * Math.cos(lat * Math.PI / 180));
        if (d < bestD) { bestD = d; best = s; }
      }
    }
    return best;
  }

  setFilter(fn) { this.filter = fn; this.refresh(); }
  setHeading(deg) { this.heading = deg; this._freeDirty = true; this.refresh(); }
  // Jauns GPS mērījums: kartes piesaiste ar vēsturi (vienreiz katram mērījumam).
  setPosition(lat, lng, heading, accuracy) {
    if (!this.tracker && this.roads && typeof RoadTracker !== 'undefined') this.tracker = new RoadTracker(this.roads);
    this.pos = this.tracker ? this.tracker.update(lat, lng, heading, accuracy) : null;
    this._freeDirty = true;
    this.refresh();
    return this.pos;
  }
  setEnabled(v) { this.enabled = v; this.refresh(); }
  // Zīmes virziens mainījies (ielādēts no Mapillary) — piesaisti jārēķina no jauna.
  faceChanged(s) { s._m = undefined; }
  facesChanged() { if (this.route) this._routeDirty = true; this._freeDirty = true; this.refresh(); }
  setRoads(idx) {
    this.roads = idx;
    this.tracker = typeof RoadTracker !== 'undefined' ? new RoadTracker(idx) : null;
    this.pos = null;
    for (const list of this.grid.values()) for (const s of list) s._m = undefined;
    this.refresh();
  }
  // Kartē ielādēti jauni ceļi: maršruta zīmes jāpārvērtē (provizoriskās var kļūt precīzas).
  roadsChanged() { if (this.route) this._routeDirty = true; this._freeDirty = true; this.refresh(); }

  // Zīmes piesaiste ceļam (kešota). undefined — ceļi šai vietai vēl nav zināmi;
  // null — tuvumā nav braucama ceļa (ūdenī, parkā u.c.).
  match(s) {
    if (!s.value) {   // OSM zīme: novietota uz ceļa jau datos
      return s._m || (s._m = { lat: s.lat, lng: s.lng, own: true, quality: 'ok',
        travelDir: s.face != null ? (s.face + 180) % 360 : null, dirSource: s.face != null ? 'face' : null });
    }
    if (s._m !== undefined) return s._m;
    if (!this.roads || !this.roads.ready || !this.roads.covers(s.lat, s.lng)) return undefined;
    return (s._m = this.roads.snapSign(s.lat, s.lng, s.face, s.value) || null);
  }

  // Zīmes braukšanas virziens un cik tas drošs.
  _dir(s) {
    const m = s._m;
    if (m && m.travelDir != null) return { dir: m.travelDir, sure: m.dirSource === 'face' || m.dirSource === 'oneway' };
    if (s.face != null) return { dir: (s.face + 180) % 360, sure: true };
    return null;
  }

  // Kā zīmi rādīt brīvā braukšanā: 'mine' — attiecas uz mani (uz mana ceļa, manā virzienā);
  // 'unknown' — virziens nav apstiprināts vai nav zināms, kur esmu; 'other' — cits ceļš /
  // neskaidrs (blāva); 'opposite' — mana ceļa pretējais virziens (nerāda).
  // NEnosaka pēc kompasa vien: zīmes ceļa posmam jābūt uz mana ceļa priekšā.
  relation(s) {
    if (!this.pos || this.heading == null) return 'unknown';
    const f = this._freeApplicable();
    if (!f) return 'unknown';
    if (f.opposite.has(s)) return 'opposite';
    const it = f.status.get(s);
    return it ? REL_BY_STATUS[it.status] : 'other';
  }

  // ---------- Maršruts ----------
  setRoute(route) {
    this.route = route;
    this.routeAlong = null;
    this.routeGrid = null;
    this.routeList = [];
    this._routePath = null;
    this._routeSegs = null;
    if (route) {
      const g = new Map(), c = route.coords;
      for (let i = 0; i + 1 < c.length; i++) {
        const a = c[i], b = c[i + 1];
        const la0 = Math.floor(Math.min(a[1], b[1]) / ROUTE_CELL), la1 = Math.floor(Math.max(a[1], b[1]) / ROUTE_CELL);
        const lo0 = Math.floor(Math.min(a[0], b[0]) / ROUTE_CELL), lo1 = Math.floor(Math.max(a[0], b[0]) / ROUTE_CELL);
        for (let la = la0; la <= la1; la++) for (let lo = lo0; lo <= lo1; lo++) {
          const k = la + ':' + lo;
          if (!g.has(k)) g.set(k, []);
          g.get(k).push(i);
        }
      }
      this.routeGrid = g;
      this._routeDirty = true;
    }
    this.refresh();
  }
  setRouteProgress(along) { this.routeAlong = along; this.refresh(); }

  // Tuvākais maršruta posms zīmei: { along, bearing, side (+1 pa labi, -1 pa kreisi) } vai null.
  _matchRoute(lat, lng) {
    const c = this.route.coords, cum = this.route.cum;
    const k = 111320, cos = Math.cos(lat * Math.PI / 180);
    const la = Math.floor(lat / ROUTE_CELL), lo = Math.floor(lng / ROUTE_CELL);
    let best = null;
    const seen = new Set();
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const idx of this.routeGrid.get((la + i) + ':' + (lo + j)) || []) {
        if (seen.has(idx)) continue;
        seen.add(idx);
        const ax = (c[idx][0] - lng) * k * cos, ay = (c[idx][1] - lat) * k;
        const bx = (c[idx + 1][0] - lng) * k * cos, by = (c[idx + 1][1] - lat) * k;
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        if (!l2) continue;
        const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
        const px = ax + t * dx, py = ay + t * dy; // tuvākais maršruta punkts (zīme ir 0,0)
        const d = Math.hypot(px, py);
        if (d <= ROUTE_NEAR_M && (!best || d < best.d)) {
          // Zīmes puse: brauciena virziens × (zīme − punkts). < 0 → zīme pa labi.
          const cross = dx * (-py) - dy * (-px);
          best = {
            d,
            along: cum[idx] + t * (cum[idx + 1] - cum[idx]),
            bearing: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360,
            side: cross < 0 ? 1 : -1,
          };
        }
      }
    }
    return best;
  }

  // ---------- Trajektorija un zīmju atlase ----------
  // Maršruta trajektorija: kartes posmi, kas iet pa maršrutu, un krustojumi ar manevriem.
  _routePathObj() {
    const roadsGen = this.roads ? this.roads.gen : -1;
    if (this._routePath && this._routePath.gen === roadsGen) return this._routePath;
    const c = this.route.coords;
    let S = 90, W = 180, N = -90, E = -180;
    for (const p of c) { if (p[1] < S) S = p[1]; if (p[1] > N) N = p[1]; if (p[0] < W) W = p[0]; if (p[0] > E) E = p[0]; }
    const project = (lng, lat) => this._matchRoute(lat, lng);
    // Kartē vienlaikus ir tikai redzamās apkārtnes ceļi — maršruta posmus uzkrāj (ID ir stabili).
    const segs = this._routeSegs || (this._routeSegs = new Map());
    if (this.roads && this.roads.ready) for (const [id, v] of this.roads.segmentsAlong([S, W, N, E], project, ROUTE_SEG_TOL_M)) segs.set(id, v);
    // Krustojumi no OSRM (intersections) un manevru virzieni tajos.
    const junctions = [];
    for (const st of this.route.steps || []) {
      (st.intersections || []).forEach((ix, i) => {
        if (!ix.location || (ix.bearings && ix.bearings.length < 3 && i > 0)) return;
        const r = this._matchRoute(ix.location[1], ix.location[0]);
        if (!r) return;
        const dir = i === 0 ? (st.maneuver && st.maneuver.type === 'depart' ? null : maneuverDir(st.maneuver && st.maneuver.modifier)) : 'straight';
        junctions.push({ along: r.along, dir });
      });
    }
    junctions.sort((x, y) => x.along - y.along);
    this._routePath = { gen: roadsGen, segs, project, bbox: [S, W, N, E], junctions, from: -Infinity, to: Infinity, route: true };
    return this._routePath;
  }

  // Brīvā braukšana: mans ceļš uz priekšu (līdz maxM, krustojumos taisni).
  _freePathObj(maxM = 400) {
    const pos = this.pos;
    if (!pos || !this.roads || !this.roads.ready) return null;
    const ahead = this.roads.walk(pos.P, pos.next, maxM, true);
    if (ahead.length < 2) return null;
    // Līnija sākas pašreizējā posma sākumā (lai šis posms arī ir trajektorijā), "from" — mana vieta.
    const k = 111320, cos = Math.cos(pos.P[1] * Math.PI / 180);
    const back = this._backPoint(pos);
    const line = back ? [back, ...ahead] : ahead;
    const off = back ? Math.hypot((pos.P[0] - back[0]) * k * cos, (pos.P[1] - back[1]) * k) : 0;
    let S = 90, W = 180, N = -90, E = -180;
    for (const p of line) { S = Math.min(S, p[1]); N = Math.max(N, p[1]); W = Math.min(W, p[0]); E = Math.max(E, p[0]); }
    const project = (lng, lat) => projectOnLine(line, lng, lat);
    const pad = 0.0002;
    const segs = this.roads.segmentsAlong([S - pad, W - pad, N + pad, E + pad], project, PATH_TOL_M);
    const junctions = ahead.junctions.map(a => ({ along: a + off, dir: null }));
    return { segs, project, bbox: [S, W, N, E], junctions, from: off + 2, to: off + maxM, route: false, uncertain: pos.uncertain, end: ahead.end };
  }
  // Pašreizējā posma gals AIZ manis (pretēji braukšanas virzienam).
  _backPoint(pos) {
    let best = null;
    this.roads.eachSegInBox(pos.P[1] - 0.0002, pos.P[0] - 0.0004, pos.P[1] + 0.0002, pos.P[0] + 0.0004, seg => {
      if (seg.id !== pos.segId) return;
      best = (seg.b[0] === pos.next[0] && seg.b[1] === pos.next[1]) ? seg.a : seg.b;
    });
    return best;
  }

  // Zīmes novērtējums trajektorijā: { along, status, reason } vai null (nav uz trajektorijas),
  // vai { opposite: true } (uz trajektorijas, bet pretējā virzienā).
  _judge(x, path) {
    const m = this.match(x);
    if (m === null) return null;
    let at, provisional = false;
    if (m === undefined) {
      // Ceļi šai vietai vēl nav ielādēti (tikai maršrutam): pagaidu, NEapstiprināts.
      if (!path.route) return null;
      const r = path.project(x.lng, x.lat);
      if (!r || r.d > 18) return null;
      const ok = x.face != null ? angleDiff((x.face + 180) % 360, r.bearing) <= ROUTE_ANGLE : r.side > 0;
      return ok ? { along: r.along, status: 'probable', reason: 'roads-not-loaded', provisional: true } : null;
    }
    if (m.own) {
      at = path.project(x.lng, x.lat);
      if (!at || at.d > OWN_SIGN_TOL_M) return null;
    } else {
      if (m.quality === 'uncertain') return null;                   // nav zināms, kuram ceļam zīme pieder
      if (!path.segs.has(m.segId)) {
        // Maršrutam: šīs vietas ceļi kartē pašlaik nav ielādēti (zīme piesaistīta agrāk) —
        // pagaidu vērtējums pēc zīmes ceļa ass (stingri ≤ 4 m un tas pats virziens), NEapstiprināts.
        if (!path.route || this.roads.covers(m.roadPoint[1], m.roadPoint[0])) return null;   // cits ceļa posms
        const r = path.project(m.roadPoint[0], m.roadPoint[1]);
        if (!r || r.d > ROUTE_SEG_TOL_M) return null;
        const ax = angleDiff(m.roadBearing, r.bearing);
        if (Math.min(ax, 180 - ax) > 25 || angleDiff(m.travelDir, r.bearing) > ROUTE_ANGLE) return null;
        return { along: r.along, status: 'probable', reason: 'roads-not-loaded', provisional: true };
      }
      at = path.project(m.roadPoint[0], m.roadPoint[1]);
      if (!at) return null;
    }
    if (at.along < path.from || at.along > path.to) return null;
    const d = this._dir(x);
    if (d && angleDiff(d.dir, at.bearing) > ROUTE_ANGLE) return { opposite: true };
    const sure = !!(d && d.sure) || x.verifiedDir != null;
    const rule = turnRule(x.value);
    const res = { along: at.along, status: 'confirmed', reason: '', provisional };
    if (!rule && ENTRY_SIGN.test(x.value || '')) {
      // "Iebraukt aizliegts" stāv pie IEBRAUKTUVES (krustojumā). Ja uz mana ceļa priekšā tuvu nav
      // krustojuma, zīme attiecas uz citu iebrauktuvi (piebrauktuvi, sliedēm u.c.), nevis manu ceļu.
      const j = path.junctions.find(q => q.along >= at.along - 5);
      if (!sure) { res.status = 'unconfirmed'; res.reason = 'dir-unknown'; }
      else if (!j || j.along - at.along > ENTRY_JUNCTION_M) { res.status = 'unconfirmed'; res.reason = 'no-junction'; }
    } else if (!rule) {
      if (!d && m.own && BOTH_WAYS_CATS.has(x.cat)) { /* OSM mezgls uz paša ceļa: luksofors, pāreja u.c. — abos virzienos */ }
      else if (!d) { res.status = 'probable'; res.reason = 'dir-unknown'; }
      else if (!sure) { res.status = 'probable'; res.reason = 'dir-side'; }
    } else {
      // Pagriezienu zīmes: virzienam jābūt apstiprinātam un krustojumam priekšā.
      const j = path.junctions.find(q => q.along >= at.along - 5);
      if (!sure) { res.status = 'unconfirmed'; res.reason = 'dir-unknown'; }
      else if (!j || j.along - at.along > TURN_APPROACH_M) { res.status = 'unconfirmed'; res.reason = 'no-junction'; }
      else if (rule.kind === 'only') {
        res.junction = j.along; res.rule = rule;
        if (path.route && j.dir && !rule.dirs.includes(j.dir)) { res.status = 'contradicts-route'; res.reason = 'route-' + j.dir; }
        else if (!path.route && MULTI_LANE_CLASSES.has(m.cls || (this.roads && this._segCls(m.segId)))) { res.status = 'lane-unknown'; res.reason = 'multi-lane'; }
        else if (path.route && MULTI_LANE_CLASSES.has(m.cls || this._segCls(m.segId))) { res.reason = 'lane-maybe'; }
      }
    }
    // Bez maršruta: aiz nākamā krustojuma nav zināms, vai brauksi taisni — tikai "iespējams".
    if (!path.route && res.status === 'confirmed' && path.junctions.some(q => q.along > path.from && q.along < at.along - 5)) {
      res.status = 'probable'; res.reason = 'after-junction';
    }
    if (path.uncertain && res.status === 'confirmed') { res.status = 'probable'; res.reason = 'gps-uncertain'; }
    if (x.source === 'osm-turn') res.mapRule = true;               // kartes ierobežojums, ne pārbaudīta fiziska zīme
    return res;
  }
  _segCls(segId) {
    const p = this._routePath && this._routePath.segs.get(segId) || this._free && this._free.path && this._free.path.segs.get(segId);
    return p && p.seg ? p.seg.cls : null;
  }

  // Galvenā atlase: zīmes, kas attiecas uz trajektoriju. Atgriež
  // { list: [{ s, along, status, reason }], status: Map s → ieraksts, opposite: Set }.
  _evaluate(path) {
    const [S, W, N, E] = path.bbox, pad = 0.0005;
    const list = [], opposite = new Set();
    this.eachInBox(S - pad, W - pad, N + pad, E + pad, x => {
      const r = this._judge(x, path);
      if (!r) return;
      if (r.opposite) { opposite.add(x); return; }
      list.push(Object.assign({ s: x }, r));
    });
    // Vienā krustojuma pieejā dažādas obligātā virziena zīmes (piem. "tikai pa labi" un
    // "tikai taisni") — tās ir joslām, kuras nezinām. Nevienu nepiemēro visām joslām.
    const byJ = new Map();
    for (const it of list) if (it.rule && it.rule.kind === 'only' && it.junction != null) {
      const k = Math.round(it.junction);
      if (!byJ.has(k)) byJ.set(k, []);
      byJ.get(k).push(it);
    }
    for (const group of byJ.values()) {
      const sets = new Set(group.map(it => it.rule.dirs.join(',')));
      if (sets.size > 1) for (const it of group) if (it.status === 'confirmed' || it.status === 'contradicts-route') { it.status = 'lane-unknown'; it.reason = 'lane-conflict'; }
    }
    list.sort((a, b) => a.along - b.along);
    const status = new Map();
    for (const it of list) { status.set(it.s, it); it.s._app = it; }
    return { list, status, opposite };
  }

  _freeApplicable() {
    if (!this._freeDirty && this._free) return this._free;
    this._freeDirty = false;
    const path = this._freePathObj(400);
    this._free = path ? Object.assign(this._evaluate(path), { path }) : null;
    return this._free;
  }

  // Centralizēta atlase (skat. faila sākumu). Ar maršrutu — maršruta zīmes no "along";
  // bez maršruta — zīmes uz mana ceļa priekšā. statuses — kurus statusus atgriezt.
  getApplicableSigns({ along = null, maxM = 400, test = null, statuses = ['confirmed', 'probable'] } = {}) {
    let list;
    if (this.route) {
      if (this._routeDirty) this._rebuildRouteList();
      const from = along == null ? -Infinity : along;
      const to = along == null ? Infinity : along + maxM;
      list = this.routeList.filter(it => it.along >= from && it.along <= to)
        .map(it => Object.assign({}, it, { dist: along == null ? it.along : it.along - along }));
    } else {
      const f = this._freeApplicable();
      if (!f) return [];
      list = f.list.filter(it => it.along - f.path.from <= maxM).map(it => Object.assign({}, it, { dist: it.along - f.path.from + 2 }));
    }
    list = list.filter(it => statuses.includes(it.status) && this.filter(it.s) && (!test || test(it.s)));
    return dedupeAlong(list, 25);
  }

  _rebuildRouteList() {
    this._routeDirty = false;
    const r = this._evaluate(this._routePathObj());
    this.routeList = dedupeAlong(r.list, 25);
  }

  // Brīvā braukšana: zīmes uz MANA ceļa priekšā (tikai apstiprinātas vai ar minētu virzienu,
  // pagriezienu zīmes — tikai apstiprinātas). lat/lng/heading tiek ņemti no setPosition().
  signsAheadOnRoad(lat, lng, heading, accuracy, maxM = 400, test) {
    if (heading == null || !this.pos) return [];
    return this.getApplicableSigns({ maxM, test }).map(it => Object.assign(it, { along: it.dist }));
  }

  // Maršruta zīmes priekšā: no "from" līdz "from + ahead" metriem.
  routeSignsAhead(from, ahead, test) {
    if (!this.route) return [];
    if (this._routeDirty) this._rebuildRouteList();
    const out = [];
    for (const it of this.routeList) {
      if (it.along < from) continue;
      if (it.along > from + ahead) break;
      if (!this.filter(it.s)) continue;
      if (it.s._m === null) continue; // nav uz ceļa
      if (it.status !== 'confirmed' && it.status !== 'probable') continue;   // neapstiprinātas nav saistošas
      if (!test || test(it.s)) out.push(it);
    }
    return out;
  }

  // Pēdējā garām pabrauktā zīme (ne tālāk par "within" m atpakaļ), kas atbilst testam.
  lastRouteSignBefore(at, within, test) {
    if (!this.route) return null;
    if (this._routeDirty) this._rebuildRouteList();
    let found = null;
    for (const it of this.routeList) {
      if (it.along > at) break;
      if (it.status !== 'confirmed' && it.status !== 'probable') continue;
      if (it.along >= at - within && test(it.s)) found = it;
    }
    return found;
  }

  // ---------- Karte ----------
  // Pievieno avotu un slāņus (jāizsauc pēc katras stila ielādes).
  install(beforeId) {
    const map = this.map;
    if (map.getSource('signs')) return;
    map.addSource('signs', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    const relCase = (mine, other, unknown) => ['match', ['get', 'rel'], 'mine', mine, 'other', other, unknown];
    map.addLayer({
      id: 'signs', type: 'symbol', source: 'signs',
      minzoom: SIGNS_MIN_ZOOM,          // attālinātā kartē tūkstošiem zīmju tikai bremzē — tās nerāda
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': ['interpolate', ['linear'], ['zoom'],
          13, relCase(0.62, 0.42, 0.55),
          16, relCase(0.95, 0.6, 0.82),
          18.5, relCase(1.3, 0.8, 1.1)],
        'symbol-sort-key': ['get', 'prio'],
        'icon-padding': 1,
        'icon-pitch-alignment': 'viewport',
        'icon-rotation-alignment': 'viewport',
        // Laiks zem zīmes, piem. "P–Pk 7–19" (paslēpjas, ja nav vietas).
        'text-field': ['coalesce', ['get', 'time'], ''],
        'text-font': ['Noto Sans Bold'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 17, 12.5],
        'text-anchor': 'top',
        'text-offset': [0, 1.2],
        'text-optional': true,
        'text-padding': 1,
      },
      paint: {
        // Ja aizliegums tagad nav spēkā — zīme blāva.
        'icon-opacity': ['case', ['boolean', ['get', 'off'], false], 0.45, relCase(1, 0.4, 1)],
        'text-color': ['case', ['any', ['boolean', ['get', 'off'], false], ['boolean', ['get', 'unk'], false]], '#5f6b7a', '#c62828'],
        'text-halo-color': '#ffffff',
        'text-halo-width': 2.2,
      },
    }, beforeId);
    this.refresh(true);
  }

  // Karte prasa attēlu, kura vēl nav: ielādē to un uzzīmē 64×64.
  loadImage(id) {
    if (this.loading.has(id) || this.map.hasImage(id)) return;
    this.loading.add(id);
    const url = this.iconUrl.get(id) || svgDataUrl({ kind: 'other' });
    const done = (img) => {
      this.loading.delete(id);
      if (this.map.hasImage(id)) return;
      const c = document.createElement('canvas'); c.width = c.height = SIGN_IMG_PX;
      const g = c.getContext('2d');
      const w = img.naturalWidth || SIGN_IMG_PX, h = img.naturalHeight || SIGN_IMG_PX;
      const k = Math.min(SIGN_IMG_PX / w, SIGN_IMG_PX / h);
      try {
        g.drawImage(img, (SIGN_IMG_PX - w * k) / 2, (SIGN_IMG_PX - h * k) / 2, w * k, h * k);
        this.map.addImage(id, g.getImageData(0, 0, SIGN_IMG_PX, SIGN_IMG_PX), { pixelRatio: 2 });
      } catch { return fallback(); }
      this.refresh();
    };
    const fallback = () => {
      if (url === svgDataUrl({ kind: 'other' })) { this.loading.delete(id); return; }
      const f = new Image();
      f.onload = () => done(f);
      f.src = svgDataUrl({ kind: 'other' });
    };
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => done(img);
    img.onerror = fallback;
    img.src = url;
  }

  // Atjauno kartē redzamās zīmes (ne biežāk kā ~8 reizes sekundē).
  refresh(now) {
    if (now) { clearTimeout(this._timer); this._timer = null; return this._update(); }
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this._update(); }, 120);
  }

  // Zīmes vieta kartē: piesieta ceļam; null — paslēpt (ūdenī / ceļi vēl nav zināmi).
  // onRoute: zīme jau ir uz maršruta (tātad uz ceļa) — ja ceļi vēl nav zināmi, rāda uzreiz.
  _place(s, onRoute) {
    if (!this.roads) return s;
    const m = this.match(s);
    if (m === undefined) return onRoute ? s : null;
    return m;
  }

  _update() {
    const map = this.map, src = map.getSource && map.getSource('signs');
    if (!src) return;
    if (!this.enabled) { src.setData({ type: 'FeatureCollection', features: [] }); return; }
    // Attālinātā kartē zīmes nerāda un nerēķina (tas bija galvenais bremzētājs, attālinot karti).
    if (map.getZoom() < SIGNS_MIN_ZOOM) {
      if (!this._emptyShown) { src.setData({ type: 'FeatureCollection', features: [] }); this._emptyShown = true; }
      return;
    }
    this._emptyShown = false;
    const b = map.getBounds();
    const padLat = (b.getNorth() - b.getSouth()) * 0.25, padLng = (b.getEast() - b.getWest()) * 0.25;
    const S = b.getSouth() - padLat, W = b.getWest() - padLng, N = b.getNorth() + padLat, E = b.getEast() + padLng;
    const c = map.getCenter();
    const list = [];

    if (this.route) {
      // Tikai maršruta zīmes manā virzienā; braucot — bez garām pabrauktajām.
      if (this._routeDirty) this._rebuildRouteList();
      const from = this.routeAlong == null ? -Infinity : this.routeAlong - 15;
      for (const it of this.routeList) {
        if (it.along < from) continue;
        const s = it.s;
        if (s.lat < S || s.lat > N || s.lng < W || s.lng > E || !this.filter(s)) continue;
        const pos = this._place(s, true);
        if (!pos) continue;
        list.push({ s, pos, rel: REL_BY_STATUS[it.status] || 'other' });
      }
    } else {
      const f = this.pos && this.heading != null ? this._freeApplicable() : null;
      this.eachInBox(S, W, N, E, s => {
        if (!this.filter(s)) return;
        const pos = this._place(s);
        if (!pos) return;
        let rel = 'unknown';
        if (f) {
          if (f.opposite.has(s)) return;                    // mana ceļa pretējais virziens — nerāda
          const it = f.status.get(s);
          rel = it ? REL_BY_STATUS[it.status] : 'other';    // nav uz mana ceļa — blāva
          if (!it) s._app = null;
        } else s._app = null;
        list.push({ s, pos, rel });
      });
    }
    // Ja zīmju ir ļoti daudz, ņem tās, kas tuvāk centram.
    if (list.length > 5000) {
      list.sort((a, d) => Math.hypot(a.pos.lat - c.lat, a.pos.lng - c.lng) - Math.hypot(d.pos.lat - c.lat, d.pos.lng - c.lng));
      list.length = 5000;
    }
    // Zīmes ar zināmu darbības laiku ir svarīgākas — tās neaizsedz citas zīmes.
    const rank = { mine: 0, unknown: 10, other: 20 };
    src.setData({
      type: 'FeatureCollection',
      features: list.map(({ s, pos, rel }) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [pos.lng, pos.lat] },
        properties: Object.assign({ icon: this.iconFor ? this.iconFor(s) : s.icon, title: this.titleFor ? this.titleFor(s) : s.title, rel, prio: rank[rel] + SIGN_PRIORITY[s.cat] - (s.restriction && s.restriction.known ? 8 : 0) },
          s.mid ? { mid: s.mid } : null,
          s._m && s._m.quality === 'uncertain' ? { unsure: s._m.reason || 'piesaiste nav droša' } : null,
          s.conflict ? { conflict: true } : null,
          this.decorate ? this.decorate(s) : null),
      })),
    });
  }
}

const SIGNS_MIN_ZOOM = 12;

// Pārvērš mūsu SVG ikonu par attēla adresi (vienreiz katram veidam).
const svgUrlCache = new Map();
function svgDataUrl(sign) {
  const key = sign.kind + ':' + (sign.value || '');
  if (!svgUrlCache.has(key)) {
    svgUrlCache.set(key, 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(signSvg(sign, 64)));
  }
  return svgUrlCache.get(key);
}

// Vienādas zīmes tuvāk par "gap" metriem pa ceļu neko jaunu nepasaka — atstāj vienu.
function dedupeAlong(list, gap) {
  const kept = [], lastAt = new Map();
  for (const it of list) {
    const key = it.s.value || it.s.icon, prev = lastAt.get(key);
    if (prev != null && it.along - prev < gap) continue;
    lastAt.set(key, it.along);
    kept.push(it);
  }
  return kept;
}

// Punkta projekcija uz līnijas [[lng, lat], ...]: { d, along, bearing } metros/grādos.
function projectOnLine(line, lng, lat) {
  const k = 111320, cos = Math.cos(lat * Math.PI / 180);
  let best = null, acc = 0;
  for (let i = 1; i < line.length; i++) {
    const ax = (line[i - 1][0] - lng) * k * cos, ay = (line[i - 1][1] - lat) * k;
    const bx = (line[i][0] - lng) * k * cos, by = (line[i][1] - lat) * k;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, len = Math.sqrt(l2);
    if (l2) {
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (!best || d < best.d) best = { d, along: acc + t * len, bearing: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360 };
    }
    acc += len;
  }
  return best;
}

if (typeof module !== 'undefined') module.exports = { SignStore, dedupeAlong, projectOnLine, angleDiff, turnRule, maneuverDir };
