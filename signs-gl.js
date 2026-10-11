// Zīmju slānis MapLibre kartē. Zīmes glabājas telpiskā indeksā, bet kartei
// tiek dotas tikai tās, kas ir redzamajā apgabalā. Pārklāšanos nokārto pati
// karte (svarīgākās zīmes paliek, pārējās paslēpjas), un zīmes griežas un
// sasveras kopā ar karti.
//
// Ja ir maršruts, rāda TIKAI zīmes, kas ir uz maršruta un attiecas uz manu
// braukšanas virzienu (pretējā virziena un sānielu zīmes paslēpj), un
// braucot paslēpj jau garām pabrauktās zīmes.

const SIGN_PRIORITY = { speed: 0, priority: 1, camera: 2, rail: 3, signals: 4, calming: 5, crossing: 6, other: 7 };
const SIGN_GRID = 0.01;      // telpiskā indeksa šūna grādos
const SIGN_IMG_PX = 64;      // zīmju attēlu izmērs (pikseļi), rāda kā 32 px
const ROUTE_CELL = 0.002;    // maršruta posmu indeksa šūna (~200 m)
const ROUTE_NEAR_M = 28;     // cik tālu no maršruta ass zīme vēl ir "uz maršruta"
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
    this.hideOpposite = false;
    this.roads = null;       // roadIndex vai null
    this.enabled = true;
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
  setHideOpposite(v) { this.hideOpposite = v; this.refresh(); }
  setEnabled(v) { this.enabled = v; this.refresh(); }
  facesChanged() { if (this.route) this._routeDirty = true; this.refresh(); }
  setRoads(idx) {
    this.roads = idx;
    for (const list of this.grid.values()) for (const s of list) s._snap = undefined;
    this.refresh();
  }

  // Vai zīme attiecas uz mani (pēc braukšanas virziena)? 'mine' | 'other' | 'unknown'
  relation(s) {
    if (s.face == null || this.heading == null) return 'unknown';
    // Zīmi lasa vadītājs, kurš brauc pretī tās priekšpusei: virziens = face + 180.
    return angleDiff((s.face + 180) % 360, this.heading) <= 60 ? 'mine' : 'other';
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

  // Vai zīme attiecas uz braucēju, kas brauc pa maršrutu? Ja zīmes virziens nav
  // zināms, pieņem, ka manā virzienā ir zīmes ceļa labajā pusē (labās puses satiksme).
  _routeApplies(s, m) {
    if (s.face != null) return angleDiff((s.face + 180) % 360, m.bearing) <= ROUTE_ANGLE;
    return m.side > 0;
  }

  _rebuildRouteList() {
    this._routeDirty = false;
    const c = this.route.coords;
    let s = 90, w = 180, n = -90, e = -180;
    for (const p of c) { if (p[1] < s) s = p[1]; if (p[1] > n) n = p[1]; if (p[0] < w) w = p[0]; if (p[0] > e) e = p[0]; }
    const pad = 0.0005, list = [];
    this.eachInBox(s - pad, w - pad, n + pad, e + pad, x => {
      const m = this._matchRoute(x.lat, x.lng);
      if (m && this._routeApplies(x, m)) list.push({ s: x, along: m.along });
    });
    list.sort((a, b) => a.along - b.along);
    this.routeList = list;
  }

  // Maršruta zīmes priekšā: no "from" līdz "from + ahead" metriem.
  routeSignsAhead(from, ahead, test) {
    if (!this.route) return [];
    if (this._routeDirty) this._rebuildRouteList();
    const out = [];
    for (const it of this.routeList) {
      if (it.along < from) continue;
      if (it.along > from + ahead) break;
      if (!this.filter(it.s.cat)) continue;
      if (this.roads && it.s.value && it.s._snap === null) continue; // ūdenī u.c.
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
    this._addArrowImages();
    const relCase = (mine, other, unknown) => ['match', ['get', 'rel'], 'mine', mine, 'other', other, unknown];
    // "Deguns": rāda, uz kuru pusi zīme skatās. Griežas kopā ar karti.
    map.addLayer({
      id: 'sign-dirs', type: 'symbol', source: 'signs', minzoom: 15.3,
      filter: ['has', 'face'],
      layout: {
        'icon-image': relCase('dir-mine', 'dir-other', 'dir-other'),
        'icon-rotate': ['get', 'face'],
        'icon-rotation-alignment': 'map',
        'icon-pitch-alignment': 'map',
        'icon-offset': [0, -17],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 15.3, 0.75, 18, 1.05],
      },
      paint: { 'icon-opacity': relCase(1, 0.35, 0.9) },
    }, beforeId);
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
      },
      paint: { 'icon-opacity': relCase(1, 0.4, 1) },
    }, beforeId);
    this.refresh(true);
  }

  // Bultiņa zīmes virziena rādīšanai (zaļa = man, tumša = citiem).
  _addArrowImages() {
    for (const [id, color] of [['dir-mine', '#1e9e4a'], ['dir-other', '#2b3646']]) {
      if (this.map.hasImage(id)) continue;
      const c = document.createElement('canvas'); c.width = c.height = 32;
      const g = c.getContext('2d');
      g.beginPath(); g.moveTo(16, 3); g.lineTo(27, 26); g.lineTo(16, 20); g.lineTo(5, 26); g.closePath();
      g.fillStyle = color; g.strokeStyle = '#fff'; g.lineWidth = 3; g.lineJoin = 'round';
      g.stroke(); g.fill();
      this.map.addImage(id, g.getImageData(0, 0, 32, 32), { pixelRatio: 2 });
    }
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
    if (!this.roads || !s.value) return s;
    if (s._snap === undefined) {
      if (!this.roads.ready || !this.roads.covers(s.lat, s.lng)) return onRoute ? s : null;
      s._snap = this.roads.snap(s.lat, s.lng) || null;
    }
    return s._snap;
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
        if (s.lat < S || s.lat > N || s.lng < W || s.lng > E || !this.filter(s.cat)) continue;
        const pos = this._place(s, true);
        if (!pos) continue;
        list.push({ s, pos, rel: 'mine' });
      }
    } else {
      this.eachInBox(S, W, N, E, s => {
        if (!this.filter(s.cat)) return;
        const pos = this._place(s);
        if (!pos) return;
        const rel = this.relation(s);
        if (rel === 'other' && this.hideOpposite) return;
        list.push({ s, pos, rel });
      });
    }
    // Ja zīmju ir ļoti daudz, ņem tās, kas tuvāk centram.
    if (list.length > 5000) {
      list.sort((a, d) => Math.hypot(a.pos.lat - c.lat, a.pos.lng - c.lng) - Math.hypot(d.pos.lat - c.lat, d.pos.lng - c.lng));
      list.length = 5000;
    }
    const rank = { mine: 0, unknown: 10, other: 20 };
    src.setData({
      type: 'FeatureCollection',
      features: list.map(({ s, pos, rel }) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [pos.lng, pos.lat] },
        properties: Object.assign(
          { icon: s.icon, title: s.title, rel, prio: rank[rel] + SIGN_PRIORITY[s.cat] },
          s.face != null ? { face: s.face } : {}),
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
