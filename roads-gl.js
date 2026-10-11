// Ceļu indekss no kartes datiem (OpenFreeMap). Ar to Mapillary zīmes
// "piesien" tuvākajam braucamajam ceļam: tālu no ceļa (upē, parkā, mājā)
// esošās zīmes paslēpj, tuvās novieto glīti ceļa malā.

const ROAD_CLASSES = {
  // klase: [cik tālu no ceļa ass zīme drīkst būt (m), kur to novietot (m no ass)]
  motorway: [40, 12], trunk: [38, 11], primary: [32, 9], secondary: [28, 8],
  tertiary: [25, 7], minor: [22, 5], service: [18, 4],
};
const ROAD_CELL = 0.0015; // ~150 m

const roadIndex = {
  ready: false,
  grid: new Map(),
  coverage: null, // [s, w, n, e] apgabals, kuram ceļi ir zināmi

  // Pārbūvē indeksu no kartē ielādētajiem ceļiem.
  rebuild(gl) {
    if (gl.getZoom() < 13.5) return false; // attālinātā kartē mazās ielas nav datos
    let feats;
    try { feats = gl.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation' }); }
    catch { return false; }
    const grid = new Map();
    for (const f of feats) {
      const cls = String(f.properties.class || '').replace('_construction', '');
      const conf = ROAD_CLASSES[cls];
      if (!conf) continue;
      const g = f.geometry;
      const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      for (const line of lines) {
        for (let i = 1; i < line.length; i++) {
          const a = line[i - 1], b = line[i];
          const seg = { a, b, max: conf[0], edge: conf[1] };
          const la0 = Math.floor(Math.min(a[1], b[1]) / ROAD_CELL), la1 = Math.floor(Math.max(a[1], b[1]) / ROAD_CELL);
          const lo0 = Math.floor(Math.min(a[0], b[0]) / ROAD_CELL), lo1 = Math.floor(Math.max(a[0], b[0]) / ROAD_CELL);
          for (let la = la0; la <= la1; la++) for (let lo = lo0; lo <= lo1; lo++) {
            const k = la + ':' + lo;
            if (!grid.has(k)) grid.set(k, []);
            grid.get(k).push(seg);
          }
        }
      }
    }
    const b = gl.getBounds();
    let cov = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
    // Sasvērtā skatā tālumā karte ielādē mazāk detalizētus datus (bez mazajām
    // ielām), tāpēc zīmes pārbauda tikai ~500 m ap centru.
    if (gl.getPitch && gl.getPitch() > 10) {
      const c = gl.getCenter(), dLat = 0.0045, dLng = 0.0045 / Math.cos(c.lat * Math.PI / 180);
      cov = [Math.max(cov[0], c.lat - dLat), Math.max(cov[1], c.lng - dLng), Math.min(cov[2], c.lat + dLat), Math.min(cov[3], c.lng + dLng)];
    }
    this.grid = grid;
    this.coverage = cov;
    this.ready = true;
    return true;
  },

  covers(lat, lng) {
    const c = this.coverage;
    return !!c && lat >= c[0] && lat <= c[2] && lng >= c[1] && lng <= c[3];
  },

  // Atgriež { lat, lng } jaunajai vietai, vai null, ja tuvumā nav ceļa.
  snap(lat, lng) {
    const k = 111320, cos = Math.cos(lat * Math.PI / 180);
    const la = Math.floor(lat / ROAD_CELL), lo = Math.floor(lng / ROAD_CELL);
    let best = null;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const seg of this.grid.get((la + i) + ':' + (lo + j)) || []) {
        // punkts metros attiecībā pret zīmi
        const ax = (seg.a[0] - lng) * k * cos, ay = (seg.a[1] - lat) * k;
        const bx = (seg.b[0] - lng) * k * cos, by = (seg.b[1] - lat) * k;
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
        const px = ax + t * dx, py = ay + t * dy;
        const d = Math.hypot(px, py);
        if (d <= seg.max && (!best || d / seg.max < best.score)) best = { score: d / seg.max, d, px, py, edge: seg.edge };
      }
    }
    if (!best) return null;
    if (best.d <= best.edge) return { lat, lng }; // jau ceļa malā
    // Novieto zīmi ceļa malā tajā pusē, kur tā bija (edge metri no ass).
    const f = (best.d - best.edge) / best.d;
    return { lat: lat + (best.py * f) / k, lng: lng + (best.px * f) / (k * cos) };
  },
};
