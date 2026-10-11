// Zīmju slānis MapLibre kartē. Zīmes glabājas telpiskā indeksā, bet kartei
// tiek dotas tikai tās, kas ir redzamajā apgabalā. Pārklāšanos nokārto pati
// karte (svarīgākās zīmes paliek, pārējās paslēpjas), un zīmes griežas un
// sasveras kopā ar karti.

const SIGN_PRIORITY = { speed: 0, priority: 1, camera: 2, rail: 3, signals: 4, calming: 5, crossing: 6, other: 7 };
const SIGN_GRID = 0.01;      // telpiskā indeksa šūna grādos
const SIGN_IMG_PX = 64;      // zīmju attēlu izmērs (pikseļi), rāda kā 32 px

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
  }

  // ---------- Dati ----------
  add(s) {
    const k = Math.floor(s.lat / SIGN_GRID) + ':' + Math.floor(s.lng / SIGN_GRID);
    if (!this.grid.has(k)) this.grid.set(k, []);
    this.grid.get(k).push(s);
    this.count++;
    if (!this.iconUrl.has(s.icon)) this.iconUrl.set(s.icon, s.src);
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
  setRoads(idx) {
    this.roads = idx;
    for (const list of this.grid.values()) for (const s of list) s._snap = undefined;
    this.refresh();
  }

  // Vai zīme attiecas uz mani? 'mine' | 'other' | 'unknown'
  relation(s) {
    if (s.face == null || this.heading == null) return 'unknown';
    // Zīmi lasa vadītājs, kurš brauc pretī tās priekšpusei: virziens = face + 180.
    let d = Math.abs((s.face + 180) % 360 - this.heading) % 360;
    if (d > 180) d = 360 - d;
    return d <= 60 ? 'mine' : 'other';
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

  _update() {
    const map = this.map, src = map.getSource && map.getSource('signs');
    if (!src) return;
    if (!this.enabled) { src.setData({ type: 'FeatureCollection', features: [] }); return; }
    const b = map.getBounds();
    const padLat = (b.getNorth() - b.getSouth()) * 0.25, padLng = (b.getEast() - b.getWest()) * 0.25;
    const c = map.getCenter();
    const list = [];
    this.eachInBox(b.getSouth() - padLat, b.getWest() - padLng, b.getNorth() + padLat, b.getEast() + padLng, s => {
      if (!this.filter(s.cat)) return;
      let pos = s;
      if (this.roads && s.value) { // Mapillary zīmes piesien tuvākajam ceļam
        if (s._snap === undefined) {
          if (!this.roads.ready || !this.roads.covers(s.lat, s.lng)) return; // ceļi vēl nav zināmi
          s._snap = this.roads.snap(s.lat, s.lng) || null;
        }
        if (!s._snap) return; // tālu no ceļa (ūdenī, parkā u.c.)
        pos = s._snap;
      }
      const rel = this.relation(s);
      if (rel === 'other' && this.hideOpposite) return;
      list.push({ s, pos, rel });
    });
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
