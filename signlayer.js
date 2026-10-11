// Ātrs zīmju slānis: visas zīmes zīmē vienā <canvas>, nevis kā tūkstošiem
// atsevišķu HTML elementu. Zīmē tikai redzamās zīmes, un attālinātā kartē
// paslēpj pārklājošās (svarīgākās paliek redzamas).

const SIGN_PRIORITY = { speed: 0, priority: 1, camera: 2, rail: 3, signals: 4, calming: 5, crossing: 6, other: 7 };
const GRID = 0.01; // telpiskā indeksa šūna grādos

const SignCanvasLayer = L.Layer.extend({
  initialize() {
    this._grid = new Map();   // "la:lo" -> [zīmes]
    this._count = 0;
    this._imgs = new Map();   // src -> { img, ok, failed }
    this._drawn = [];         // pēdējā zīmējuma zīmes (pieskārienu noteikšanai)
    this._filter = () => true;
    this._frame = null;
    this._heading = null;      // braukšanas virziens (grādi) vai null
    this._hideOpposite = false;
  },

  onAdd(map) {
    this._map = map;
    if (!map.getPane('signs')) {
      const pane = map.createPane('signs');
      pane.style.zIndex = 450;          // virs ceļiem un maršruta, zem manas atrašanās vietas
      pane.style.pointerEvents = 'none';
    }
    this._canvas = L.DomUtil.create('canvas', 'sign-canvas');
    map.getPane('signs').appendChild(this._canvas);
    this._ctx = this._canvas.getContext('2d');
    map.on('move', this.redraw, this);
    map.on('resize', this._resize, this);
    map.on('zoom zoomend viewreset', this.redraw, this);
    this._resize();
  },

  onRemove(map) {
    map.off('move', this.redraw, this);
    map.off('resize', this._resize, this);
    map.off('zoom zoomend viewreset', this.redraw, this);
    this._canvas.remove();
    this._drawn = [];
  },

  // sign: { lat, lng, cat, src, fallback, title }
  add(sign) {
    const k = Math.floor(sign.lat / GRID) + ':' + Math.floor(sign.lng / GRID);
    if (!this._grid.has(k)) this._grid.set(k, []);
    this._grid.get(k).push(sign);
    this._count++;
  },

  setFilter(fn) { this._filter = fn; this.redraw(); },
  setHeading(deg) { this._heading = deg; this.redraw(); },
  setHideOpposite(v) { this._hideOpposite = v; this.redraw(); },

  // Vai zīme attiecas uz mani? 'mine' | 'other' | 'unknown'
  _relation(s) {
    if (s.face == null || this._heading == null) return 'unknown';
    // Zīmi lasa vadītājs, kurš brauc pretī tās priekšpusei: virziens = face + 180.
    const reader = (s.face + 180) % 360;
    let d = Math.abs(reader - this._heading) % 360;
    if (d > 180) d = 360 - d;
    return d <= 60 ? 'mine' : 'other';
  },

  // Atrod zīmi zem pirksta / peles.
  hitTest(containerPoint) {
    let best = null, bestD = Infinity;
    for (const d of this._drawn) {
      const dist = Math.hypot(d.x - containerPoint.x, d.y - containerPoint.y);
      if (dist < d.r + 6 && dist < bestD) { best = d.sign; bestD = dist; }
    }
    return best;
  },

  redraw() {
    if (!this._map || this._frame) return;
    this._frame = requestAnimationFrame(() => { this._frame = null; this._draw(); });
  },

  // Mazs "deguns" zīmes malā: rāda, uz kuru pusi zīme skatās
  // (no turienes braucošajiem tā ir domāta).
  _drawPointer(ctx, p, h, face, rel) {
    const a = (face - 90) * Math.PI / 180; // 0° = ziemeļi = uz augšu ekrānā
    const tip = h + 9, base = h - 2, spread = 0.42;
    ctx.beginPath();
    ctx.moveTo(p.x + Math.cos(a) * tip, p.y + Math.sin(a) * tip);
    ctx.lineTo(p.x + Math.cos(a + spread) * base, p.y + Math.sin(a + spread) * base);
    ctx.lineTo(p.x + Math.cos(a - spread) * base, p.y + Math.sin(a - spread) * base);
    ctx.closePath();
    ctx.fillStyle = rel === 'mine' ? '#1e9e4a' : '#2b3646';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
  },

  _resize() {
    const size = this._map.getSize(), dpr = window.devicePixelRatio || 1;
    this._canvas.width = size.x * dpr;
    this._canvas.height = size.y * dpr;
    this._canvas.style.width = size.x + 'px';
    this._canvas.style.height = size.y + 'px';
    this._dpr = dpr;
    this._draw();
  },

  _image(src, fallback) {
    let e = this._imgs.get(src);
    if (!e) {
      const img = new Image();
      e = { img, ok: false, failed: false };
      img.onload = () => { e.ok = img.naturalWidth > 0 || img.width > 0; if (!e.ok) e.failed = true; this.redraw(); };
      img.onerror = () => { e.failed = true; this.redraw(); };
      img.src = src;
      this._imgs.set(src, e);
    }
    if (e.failed && fallback) return this._image(fallback);
    return e.ok ? e.img : null;
  },

  _draw() {
    const map = this._map;
    if (!map) return;
    const ctx = this._ctx, dpr = this._dpr || 1;
    L.DomUtil.setPosition(this._canvas, map.containerPointToLayerPoint([0, 0]));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    this._drawn = [];

    const zoom = map.getZoom();
    const size = zoom >= 18 ? 34 : zoom >= 17 ? 30 : zoom >= 16 ? 26 : 22;
    const cell = zoom >= 18 ? 0 : zoom >= 17 ? size * 0.8 : size * 1.25; // pārklāšanās režģis (px)

    // Savāc redzamās zīmes no telpiskā indeksa.
    const b = map.getBounds().pad(0.05);
    const visible = [];
    for (let la = Math.floor(b.getSouth() / GRID); la <= Math.floor(b.getNorth() / GRID); la++) {
      for (let lo = Math.floor(b.getWest() / GRID); lo <= Math.floor(b.getEast() / GRID); lo++) {
        const list = this._grid.get(la + ':' + lo);
        if (!list) continue;
        for (const s of list) {
          if (s.lat < b.getSouth() || s.lat > b.getNorth() || s.lng < b.getWest() || s.lng > b.getEast()) continue;
          if (this._filter(s.cat)) visible.push(s);
        }
      }
    }
    // Manas zīmes pirmās, tad pēc svarīguma; pretējā virziena — pēdējās (vai paslēptas).
    const rank = { mine: 0, unknown: 1, other: 2 };
    for (const s of visible) s._rel = this._relation(s);
    const shown = this._hideOpposite ? visible.filter(s => s._rel !== 'other') : visible.slice();
    shown.sort((a, c) => (rank[a._rel] - rank[c._rel]) || (SIGN_PRIORITY[a.cat] - SIGN_PRIORITY[c.cat]));

    const taken = new Set();
    const half = size / 2;
    for (const s of shown) {
      const p = map.latLngToContainerPoint([s.lat, s.lng]);
      if (cell) {
        const key = Math.floor(p.x / cell) + ':' + Math.floor(p.y / cell);
        if (taken.has(key)) continue;
        taken.add(key);
      }
      const img = this._image(s.src, s.fallback);
      if (!img) continue; // vēl ielādējas: uzzīmēs, kad būs gatavs
      const other = s._rel === 'other';
      const sz = s._rel === 'mine' ? size * 1.15 : other ? size * 0.75 : size;
      const h = sz / 2;
      ctx.globalAlpha = other ? 0.35 : 1;
      if (s.face != null) this._drawPointer(ctx, p, h, s.face, s._rel);
      try { ctx.drawImage(img, p.x - h, p.y - h, sz, sz); } catch { ctx.globalAlpha = 1; continue; }
      ctx.globalAlpha = 1;
      this._drawn.push({ x: p.x, y: p.y, r: h, sign: s });
    }
  },
});

// Pārvērš mūsu SVG ikonu par attēla adresi (vienreiz katram veidam).
const svgUrlCache = new Map();
function svgDataUrl(sign) {
  const key = sign.kind + ':' + (sign.value || '');
  if (!svgUrlCache.has(key)) {
    svgUrlCache.set(key, 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(signSvg(sign, 40)));
  }
  return svgUrlCache.get(key);
}
