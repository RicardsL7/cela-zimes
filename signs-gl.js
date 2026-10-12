// Zīmju slānis MapLibre kartē. Zīmes glabājas telpiskā indeksā, bet kartei
// tiek dotas tikai tās, kas ir redzamajā apgabalā. Pārklāšanos nokārto pati
// karte (svarīgākās zīmes paliek, pārējās paslēpjas), un zīmes griežas un
// sasveras kopā ar karti.
//
// Katra zīme tiek piesaistīta konkrētam ceļa posmam (roads-gl.js → snapSign):
// zināms posms, braukšanas virziens, uz kuru tā attiecas, puse un piesaistes
// kvalitāte. Ja ir maršruts, rāda TIKAI zīmes, kuru ceļa posms sakrīt ar maršrutu
// un kuru virziens sakrīt ar maršruta virzienu; braucot paslēpj garām pabrauktās.

const SIGN_PRIORITY = { speed: 0, priority: 1, camera: 2, rail: 3, signals: 4, calming: 5, crossing: 6, other: 7 };
const SIGN_GRID = 0.01;      // telpiskā indeksa šūna grādos
const SIGN_IMG_PX = 64;      // zīmju attēlu izmērs (pikseļi), rāda kā 32 px
const ROUTE_CELL = 0.002;    // maršruta posmu indeksa šūna (~200 m)
const ROUTE_NEAR_M = 28;     // ātrā atlase: zīme ne tālāk par šo no maršruta ass
const ROUTE_AXIS_M = 8;      // zīmes ceļa ass punkts ne tālāk par šo no maršruta
const ROUTE_AXIS_DEG = 25;   // zīmes ceļa virziens ≈ maršruta virziens
const ROUTE_ANGLE = 50;      // cik grādu zīmes virziens drīkst atšķirties no maršruta

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
    this.iconUrl = new Map(); // attēla id -> adrese
    this.loading = new Set();
    this._timer = null;
    // Maršruts
    this.route = null;
    this.routeGrid = null;
    this.routeAlong = null;  // cik metru no maršruta jau nobraukts (navigācijā)
    this.routeList = [];     // [{ s, along }] maršruta zīmes pēc kārtas
    this._routeDirty = false;
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
  setHeading(deg) { this.heading = deg; this.refresh(); }
  setEnabled(v) { this.enabled = v; this.refresh(); }
  // Zīmes virziens mainījies (ielādēts no Mapillary) — piesaisti jārēķina no jauna.
  faceChanged(s) { s._m = undefined; }
  facesChanged() { if (this.route) this._routeDirty = true; this.refresh(); }
  setRoads(idx) {
    this.roads = idx;
    for (const list of this.grid.values()) for (const s of list) s._m = undefined;
    this.refresh();
  }
  // Kartē ielādēti jauni ceļi: maršruta zīmes jāpārvērtē (provizoriskās var kļūt precīzas).
  roadsChanged() { if (this.route) this._routeDirty = true; this.refresh(); }

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

  // Vai zīme attiecas uz mani (brīvā braukšanā, pēc kursa)?
  // 'mine' — mans virziens; 'other' — šķērsiela / neskaidrs (rāda blāvu); 'opposite' — pretējais (nerāda).
  relation(s) {
    const m = s._m;
    if (m && m.quality === 'uncertain') return 'other';
    if (this.heading == null) return 'unknown';
    const d = this._dir(s);
    if (!d) return 'unknown';
    const diff = angleDiff(d.dir, this.heading);
    if (!d.sure) return diff > 135 ? 'unknown' : 'mine';   // puse tikai minēta — neslēpj
    if (diff <= 60) return 'mine';
    return diff >= 120 ? 'opposite' : 'other';
  }

  // ---------- Maršruts ----------
  setRoute(route) {
    this.route = route;
    this.routeAlong = null;
    this.routeGrid = null;
    this.routeList = [];
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

  // Vai zīme pieder maršrutam? Atgriež { along, provisional } vai null.
  //  • Ja ceļi zināmi: zīmes ceļa posmam jāsakrīt ar maršrutu (ass ≤ 8 m, virziens ±25°)
  //    un zīmes braukšanas virzienam — ar maršruta virzienu. Tā neiekļūst paralēlu
  //    ielu, šķērsielu un pretējās brauktuves zīmes.
  //  • Ja ceļi vēl nav ielādēti: pagaidu vērtējums pēc maršruta ģeometrijas (stingrāks
  //    attālums); kad ceļi ielādējas, zīmi pārvērtē.
  _routeMember(x) {
    const raw = this._matchRoute(x.lat, x.lng);
    if (!raw) return null;
    const m = this.match(x);
    if (m === null) return null;                                  // nav uz ceļa
    if (m && !m.own) {
      if (m.quality === 'uncertain' && m.dirSource !== 'face') return null;
      const r = this._matchRoute(m.roadPoint[1], m.roadPoint[0]);
      if (!r || r.d > ROUTE_AXIS_M) return null;
      const axis = angleDiff(m.roadBearing, r.bearing);
      if (Math.min(axis, 180 - axis) > ROUTE_AXIS_DEG) return null;  // cits ceļš (šķērsiela)
      if (angleDiff(m.travelDir, r.bearing) > ROUTE_ANGLE) return null; // pretējais virziens
      return { along: r.along, provisional: false };
    }
    // OSM zīme vai ceļi vēl nav zināmi.
    if (raw.d > (m && m.own ? 15 : 18)) return null;
    const ok = x.face != null ? angleDiff((x.face + 180) % 360, raw.bearing) <= ROUTE_ANGLE : raw.side > 0 || !!(m && m.own);
    return ok ? { along: raw.along, provisional: !m } : null;
  }

  _rebuildRouteList() {
    this._routeDirty = false;
    const c = this.route.coords;
    let s = 90, w = 180, n = -90, e = -180;
    for (const p of c) { if (p[1] < s) s = p[1]; if (p[1] > n) n = p[1]; if (p[0] < w) w = p[0]; if (p[0] > e) e = p[0]; }
    const pad = 0.0005, list = [];
    this.eachInBox(s - pad, w - pad, n + pad, e + pad, x => {
      const r = this._routeMember(x);
      if (r) list.push({ s: x, along: r.along, provisional: r.provisional });
    });
    list.sort((a, b) => a.along - b.along);
    this.routeList = dedupeAlong(list, 25);
  }

  // ---------- Brīvā braukšana: zīmes uz MANA ceļa priekšā ----------
  // Nosaka, pa kuru ceļu braucu, un iet pa to uz priekšu līdz krustojumam.
  signsAheadOnRoad(lat, lng, heading, accuracy, maxM = 400, test) {
    if (!this.roads || !this.roads.ready || heading == null) return [];
    const pos = this.roads.matchPosition(lat, lng, heading, accuracy);
    if (!pos) return [];
    const line = this.roads.walk(pos.P, pos.next, maxM);
    if (line.length < 2) return [];
    let S = 90, W = 180, N = -90, E = -180;
    for (const p of line) { S = Math.min(S, p[1]); N = Math.max(N, p[1]); W = Math.min(W, p[0]); E = Math.max(E, p[0]); }
    const pad = 0.0004, out = [];
    this.eachInBox(S - pad, W - pad, N + pad, E + pad, x => {
      if (!this.filter(x) || (test && !test(x))) return;
      const m = this.match(x);
      if (!m || (m.quality === 'uncertain' && m.dirSource !== 'face')) return;
      const pt = m.own ? [x.lng, x.lat] : m.roadPoint;
      const pr = projectOnLine(line, pt[0], pt[1]);
      if (!pr || pr.d > (m.own ? 12 : 4) || pr.along < 3) return;
      const d = this._dir(x);
      if (d && angleDiff(d.dir, pr.bearing) > ROUTE_ANGLE) return;
      out.push({ s: x, along: pr.along });
    });
    out.sort((a, b) => a.along - b.along);
    return dedupeAlong(out, 25);
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
        list.push({ s, pos, rel: 'mine' });
      }
    } else {
      this.eachInBox(S, W, N, E, s => {
        if (!this.filter(s)) return;
        const pos = this._place(s);
        if (!pos) return;
        const rel = this.relation(s);
        if (rel === 'opposite') return; // pretējā virziena zīmes nerāda
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
        properties: Object.assign({ icon: s.icon, title: s.title, rel, prio: rank[rel] + SIGN_PRIORITY[s.cat] - (s.restriction && s.restriction.known ? 8 : 0) },
          s.mid ? { mid: s.mid } : null,
          s._m && s._m.quality === 'uncertain' ? { unsure: s._m.reason || 'piesaiste nav droša' } : null,
          s.conflict ? { conflict: true } : null,
          this.decorate ? this.decorate(s) : null),
      })),
    });
  }
}

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

if (typeof module !== 'undefined') module.exports = { SignStore, dedupeAlong, projectOnLine, angleDiff };
