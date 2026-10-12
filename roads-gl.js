// Ceļu indekss no kartes datiem (OpenFreeMap / OpenMapTiles "transportation").
// Ar to katru zīmi piesien KONKRĒTAM ceļa posmam (nevis tikai tuvākajam punktam):
//   • attālums līdz ceļa asij (pēc ceļa klases),
//   • zīmes virziens pret ceļa virzienu (zīme skatās gar savu ceļu, nevis šķērsām),
//   • vienvirziena ielas (tur zīmes var būt arī kreisajā pusē).
// Ja divi dažādi ceļi ir gandrīz vienlīdz piemēroti un zīmes virziens nav zināms,
// piesaisti atzīmē kā NESKAIDRU, nevis izvēlas uz labu laimi.

const ROAD_CLASSES = {
  // klase: [cik tālu no ceļa ass zīme drīkst būt (m), kur to novietot (m no ass)]
  motorway: [40, 12], trunk: [38, 11], primary: [32, 9], secondary: [28, 8],
  tertiary: [25, 7], minor: [22, 5], service: [18, 4],
};
const ROAD_CELL = 0.0015;        // ~150 m
const SNAP_AMBIGUOUS = 0.18;     // ja 2. labākais ceļš ir tik tuvu vērtējumā — neskaidrs
const FACE_AXIS_OK = 35;         // zīme skatās gar ceļu (± grādi)

function roadAngleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
// Starpība starp divām asīm (virziens nav svarīgs): 0..90
function roadAxisDiff(a, b) {
  const d = roadAngleDiff(a, b);
  return d > 90 ? 180 - d : d;
}

const roadIndex = {
  ready: false,
  grid: new Map(),
  coverage: null, // [s, w, n, e] apgabals, kuram ceļi ir zināmi
  gen: 0,         // palielinās pēc katras pārbūves

  // Pārbūvē indeksu no kartē ielādētajiem ceļiem.
  rebuild(gl) {
    if (gl.getZoom() < 13.5) return false; // attālinātā kartē mazās ielas nav datos
    let feats;
    try { feats = gl.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation' }); }
    catch { return false; }
    const segs = [];
    for (const f of feats) {
      const cls = String(f.properties.class || '').replace('_construction', '');
      if (!ROAD_CLASSES[cls]) continue;
      const g = f.geometry;
      const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      for (const line of lines) {
        for (let i = 1; i < line.length; i++) {
          segs.push({ a: line[i - 1], b: line[i], cls, roadId: f.id != null ? String(f.id) : null, oneway: f.properties.oneway === 1 });
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
    this.setSegments(segs, cov);
    return true;
  },

  // Ievieto posmus indeksā (izmanto arī testos). seg: { a, b, cls, roadId, oneway }
  setSegments(segs, coverage) {
    const grid = new Map();
    let n = 0;
    for (const s of segs) {
      const conf = ROAD_CLASSES[s.cls] || ROAD_CLASSES.minor;
      const seg = Object.assign({ max: conf[0], edge: conf[1] }, s);
      if (!seg.roadId) seg.roadId = 'r' + n;
      seg.id = seg.roadId + '#' + (n++);
      const la0 = Math.floor(Math.min(seg.a[1], seg.b[1]) / ROAD_CELL), la1 = Math.floor(Math.max(seg.a[1], seg.b[1]) / ROAD_CELL);
      const lo0 = Math.floor(Math.min(seg.a[0], seg.b[0]) / ROAD_CELL), lo1 = Math.floor(Math.max(seg.a[0], seg.b[0]) / ROAD_CELL);
      for (let la = la0; la <= la1; la++) for (let lo = lo0; lo <= lo1; lo++) {
        const k = la + ':' + lo;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(seg);
      }
    }
    this.grid = grid;
    this.coverage = coverage;
    this.ready = true;
    this.gen++;
  },

  covers(lat, lng) {
    const c = this.coverage;
    return !!c && lat >= c[0] && lat <= c[2] && lng >= c[1] && lng <= c[3];
  },

  // Visi ceļu posmi ap punktu ar ģeometriju metros.
  _candidates(lat, lng, extra = 0) {
    const k = 111320, cos = Math.cos(lat * Math.PI / 180);
    const la = Math.floor(lat / ROAD_CELL), lo = Math.floor(lng / ROAD_CELL);
    const out = [], seen = new Set();
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const seg of this.grid.get((la + i) + ':' + (lo + j)) || []) {
        if (seen.has(seg)) continue;
        seen.add(seg);
        const ax = (seg.a[0] - lng) * k * cos, ay = (seg.a[1] - lat) * k;
        const bx = (seg.b[0] - lng) * k * cos, by = (seg.b[1] - lat) * k;
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        if (!l2) continue;
        const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
        const px = ax + t * dx, py = ay + t * dy, d = Math.hypot(px, py);
        if (d > seg.max + extra) continue;
        out.push({
          seg, d, px, py,
          bearing: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360,   // a→b
          right: dx * (-py) - dy * (-px) < 0,                          // punkts pa labi no a→b
          P: [lng + px / (k * cos), lat + py / k],                     // tuvākais punkts uz ass
        });
      }
    }
    return out;
  },

  // Piesaista zīmi ceļa posmam. face — virziens, uz kuru skatās zīmes priekšpuse
  // (null, ja nezināms). value — zīmes kods (vajag "iebraukt aizliegts" gadījumam).
  // Atgriež null (tuvumā nav ceļa) vai:
  // { lat, lng, segId, roadId, roadBearing, travelDir, dirSource, side, dist, quality, reason }
  snapSign(lat, lng, face, value) {
    const cands = this._candidates(lat, lng);
    if (!cands.length) return null;
    const hasFace = face != null && !isNaN(face);
    for (const c of cands) {
      c.score = c.d / c.seg.max;
      if (hasFace) {
        c.axis = roadAxisDiff(face, c.bearing);
        c.score += c.axis <= FACE_AXIS_OK ? c.axis / 90 * 0.3 : 1;   // zīme šķērsām šim ceļam
      }
    }
    cands.sort((x, y) => x.score - y.score);
    const best = cands[0];
    // Labākais cits ceļš (ne tas pats ceļš un ne paralēls dublikāts uz tās pašas ass).
    const rival = cands.find(c => c.seg.roadId !== best.seg.roadId &&
      !(roadAxisDiff(c.bearing, best.bearing) < 15 && Math.hypot(c.px - best.px, c.py - best.py) < 3));
    let quality = 'ok', reason = '';
    if (rival && rival.score - best.score < SNAP_AMBIGUOUS) { quality = 'uncertain'; reason = 'tuvumā ir vairāki ceļi'; }
    if (hasFace && best.axis > FACE_AXIS_OK) { quality = 'uncertain'; reason = 'zīme nav vērsta gar nevienu tuvāko ceļu'; }

    // Braukšanas virziens, uz kuru zīme attiecas.
    const ab = best.bearing, ba = (ab + 180) % 360;
    let travelDir, dirSource;
    if (hasFace) {
      const t = (face + 180) % 360;       // vadītājs brauc pretī zīmes priekšpusei
      travelDir = roadAngleDiff(t, ab) <= roadAngleDiff(t, ba) ? ab : ba;
      dirSource = 'face';
    } else if (best.seg.oneway) {
      // Vienvirziena ielā zīmes attiecas uz atļauto virzienu, lai kurā pusē tās stāv;
      // izņēmums — "iebraukt aizliegts" ielas galā ir pretējā virziena braucējiem.
      travelDir = /no-entry/.test(value || '') ? ba : ab;
      dirSource = 'oneway';
    } else {
      travelDir = best.right ? ab : ba;    // labās puses satiksme: zīme ir braucējam pa labi
      dirSource = 'side';
    }
    const rightOfTravel = travelDir === ab ? best.right : !best.right;

    // Novieto zīmi ceļa malā tajā pusē, kur tā bija (edge metri no ass).
    let pos = { lat, lng };
    if (best.d > best.seg.edge) {
      const f = (best.d - best.seg.edge) / best.d, k = 111320, cos = Math.cos(lat * Math.PI / 180);
      pos = { lat: lat + (best.py * f) / k, lng: lng + (best.px * f) / (k * cos) };
    }
    return {
      lat: pos.lat, lng: pos.lng, segId: best.seg.id, roadId: best.seg.roadId, roadPoint: best.P,
      roadBearing: ab, oneway: best.seg.oneway, travelDir, dirSource,
      side: rightOfTravel ? 1 : -1, dist: Math.round(best.d * 10) / 10, quality, reason,
    };
  },

  // Saderības dēļ: tikai jaunā vieta.
  snap(lat, lng) {
    const m = this.snapSign(lat, lng, null, '');
    return m ? { lat: m.lat, lng: m.lng } : null;
  },

  // Uz kura ceļa un kurā virzienā esmu? heading — GPS kurss (var būt null).
  matchPosition(lat, lng, heading, accuracy = 10) {
    const cands = this._candidates(lat, lng, Math.min(30, Math.max(0, accuracy - 10)));
    if (!cands.length) return null;
    let best = null;
    for (const c of cands) {
      let score = c.d / (c.seg.max + accuracy);
      let dir = c.bearing;
      if (heading != null) {
        const ax = roadAxisDiff(heading, c.bearing);
        if (ax > 50) continue;                                      // braucu šķērsām šim ceļam
        score += ax / 90;
        dir = roadAngleDiff(heading, c.bearing) <= 90 ? c.bearing : (c.bearing + 180) % 360;
      }
      if (c.seg.oneway && roadAngleDiff(dir, c.bearing) > 90) score += 0.5; // pret vienvirziena kustību
      if (!best || score < best.score) best = { score, c, dir };
    }
    if (!best) return null;
    const { c, dir } = best;
    let next = roadAngleDiff(dir, c.bearing) <= 90 ? c.seg.b : c.seg.a;
    // Stāvu tieši posmu savienojumā — turpinājumu ņem no nākamā posma tajā pašā virzienā.
    const k = 111320, cos = Math.cos(lat * Math.PI / 180);
    const near = (p, q) => Math.hypot((q[0] - p[0]) * k * cos, (q[1] - p[1]) * k) < 1;
    if (near(c.P, next)) {
      for (const o of cands) {
        if (near(o.seg.a, next) && roadAngleDiff(o.bearing, dir) < 45) { next = o.seg.b; break; }
        if (near(o.seg.b, next) && roadAngleDiff((o.bearing + 180) % 360, dir) < 45) { next = o.seg.a; break; }
      }
    }
    return { roadId: c.seg.roadId, segId: c.seg.id, P: c.P, dir, dist: c.d, next };
  },

  // Iet pa ceļu no P caur "next", līdz krustojumam, strupceļam vai maxM metriem.
  // Atgriež līniju [[lng, lat], ...].
  walk(P, next, maxM) {
    const k = 111320, cos = Math.cos(P[1] * Math.PI / 180);
    const dist = (p, q) => Math.hypot((q[0] - p[0]) * k * cos, (q[1] - p[1]) * k);
    const brg = (p, q) => (Math.atan2((q[0] - p[0]) * cos, q[1] - p[1]) * 180 / Math.PI + 360) % 360;
    const line = [P];
    let prev = P, cur = next, total = 0;
    for (let step = 0; step < 80; step++) {
      const d = dist(prev, cur);
      if (!d) break;
      if (total + d >= maxM) { const f = (maxM - total) / d; line.push([prev[0] + (cur[0] - prev[0]) * f, prev[1] + (cur[1] - prev[1]) * f]); break; }
      total += d;
      line.push(cur);
      // Kurp no šejienes var braukt tālāk (bez iebrauktuvēm)? Līdzīgus virzienus apvieno
      // (vienu ceļu kartē bieži glabā vairākas reizes — flīžu malās).
      const back = brg(cur, prev), dirs = [];
      const la = Math.floor(cur[1] / ROAD_CELL), lo = Math.floor(cur[0] / ROAD_CELL);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const seg of this.grid.get((la + i) + ':' + (lo + j)) || []) {
          if (seg.cls === 'service') continue;
          const da = dist(cur, seg.a), db = dist(cur, seg.b);
          const cand = [];
          if (da < 2.5 && db > 2.5) cand.push(seg.b);
          else if (db < 2.5 && da > 2.5) cand.push(seg.a);
          else if (da > 2.5 && db > 2.5) {
            const ax = (seg.a[0] - cur[0]) * k * cos, ay = (seg.a[1] - cur[1]) * k;
            const dx = (seg.b[0] - seg.a[0]) * k * cos, dy = (seg.b[1] - seg.a[1]) * k, l2 = dx * dx + dy * dy;
            const t = l2 ? -(ax * dx + ay * dy) / l2 : -1;
            if (t > 0 && t < 1 && Math.hypot(ax + t * dx, ay + t * dy) < 2.5) cand.push(seg.a, seg.b);
          }
          for (const q of cand) {
            const b = brg(cur, q);
            if (roadAngleDiff(b, back) < 30) continue;            // atpakaļ
            const c = dirs.find(x => roadAngleDiff(x.b, b) < 25);
            if (c) { if (dist(cur, q) > dist(cur, c.q)) c.q = q; } else dirs.push({ b, q });
          }
        }
      }
      if (dirs.length !== 1) break;                                // krustojums vai strupceļš
      if (roadAngleDiff(dirs[0].b, brg(prev, cur)) > 70) break;    // ass pagrieziens
      prev = cur; cur = dirs[0].q;
    }
    return line;
  },
};

if (typeof module !== 'undefined') module.exports = { roadIndex, roadAngleDiff, roadAxisDiff, ROAD_CLASSES };
