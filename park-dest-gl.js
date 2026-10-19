// „Kur pie galamērķa drīkstēšu stāvēt?” — ielas ap galamērķi iekrāsotas pēc tā, vai tur drīkstēs
// stāvēt IERAŠANĀS brīdī: zaļš — drīkst, oranžs — ar nosacījumiem (maksa, īss laiks, nedroši dati),
// sarkans — nedrīkst. Tuvākās atļautās vietas sarakstā; ar vienu pieskārienu — maršruts uz turieni.
// Lēmumu pieņem tā pati loģika kā „Vai drīkstu šeit stāvēt?” (parking.js + park-gl.js) katram
// ielas posmam abās pusēs ik pēc ~18 m.

const PD_RADIUS = 260;                // m ap galamērķi
const PD_STEP = 18;                   // m starp pārbaudes punktiem
const PD_OFFSET = 4.2;                // m no ceļa ass uz ielas malu
const PD_CLASSES = new Set(['minor', 'tertiary', 'secondary', 'primary', 'residential', 'living_street', 'unclassified']);
const PD_COLOR = { ok: '#16a34a', warn: '#f08c00', no: '#e03131' };
let pdSeq = 0, pdState = null;

function pdClear() {
  pdSeq++;
  pdState = null;
  for (const id of ['pd-lines', 'pd-lots']) { const s = map.getSource && map.getSource(id); if (s) s.setData({ type: 'FeatureCollection', features: [] }); }
}
function pdEnsureLayers() {
  if (map.getSource('pd-lines')) return true;
  try {
    map.addSource('pd-lines', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('pd-lots', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  } catch { return false; }
  const before = map.getLayer('signs') ? 'signs' : undefined;
  map.addLayer({ id: 'pd-lots', type: 'fill', source: 'pd-lots', paint: { 'fill-color': ['get', 'c'], 'fill-opacity': 0.28 } }, before);
  map.addLayer({ id: 'pd-lots-line', type: 'line', source: 'pd-lots', paint: { 'line-color': ['get', 'c'], 'line-width': 2, 'line-opacity': 0.9 } }, before);
  map.addLayer({ id: 'pd-lines-casing', type: 'line', source: 'pd-lines', layout: { 'line-cap': 'butt' },
    paint: { 'line-color': '#ffffff', 'line-opacity': 0.75, 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 3, 16, 6, 18, 11] } }, before);
  map.addLayer({ id: 'pd-lines', type: 'line', source: 'pd-lines', layout: { 'line-cap': 'butt' },
    paint: { 'line-color': ['get', 'c'], 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 2, 16, 4, 18, 8] } }, before);
  return true;
}

// Punkts ar nobīdi (m) pa labi no virziena br.
function pdOffset(lng, lat, br, m) {
  const b = (br + 90) * Math.PI / 180;
  return [lng + m * Math.sin(b) / (111320 * Math.cos(lat * Math.PI / 180)), lat + m * Math.cos(b) / 111320];
}
// Ielu nosaukumi no kartes flīzēm
function pdNames(lat, lng) {
  let f = [];
  try { f = map.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation_name' }); } catch {}
  const out = [];
  for (const x of f) {
    const name = x.properties && (x.properties['name:lv'] || x.properties.name);
    if (!name) continue;
    const g = x.geometry;
    for (const line of g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []) {
      if (line.some(q => distM(lat, lng, q[1], q[0]) < PD_RADIUS + 200)) out.push({ name, line });
    }
  }
  return out;
}
function pdNameAt(names, lat, lng) {
  let best = null;
  for (const n of names) { const p = parkProject(n.line, lat, lng); if (p && p.d < 18 && (!best || p.d < best.d)) best = { d: p.d, name: n.name }; }
  return best ? best.name : '';
}

async function pdOpen() {
  const dest = state.nav.dest, route = state.nav.route;
  if (!dest) return;
  const seq = ++pdSeq;
  const eta = new Date(Date.now() + (route ? route.duration * 1000 : 0));
  openParkSheet();
  clearInterval(parkTick);
  $('parkTitle').textContent = 'Kur stāvēt pie galamērķa?';
  $('parkBody').innerHTML = `<div class="pk-loading"><div class="pk-spin" aria-hidden="true"></div><p class="pk-lt"></p>
    <div class="pd-prog"><span></span></div></div>`;
  $('parkBody').querySelector('.pk-lt').textContent = `Pārbaudu ielas ap „${dest.name}” ierašanās laikam ${pkWhen(eta, new Date())}…`;
  const prog = k => { const b = document.querySelector('#parkBody .pd-prog span'); if (b) b.style.width = Math.round(k * 100) + '%'; };
  // Karte: galamērķis redzams ar ~250 m apkārtni (ceļu indekss nāk no redzamās kartes).
  const H = map.getContainer().clientHeight, sh = Math.min($('parkSheet').offsetHeight || H * 0.5, H * 0.62);
  state.follow = false;
  map.easeTo({ center: [dest.lng, dest.lat], zoom: 16, pitch: 0, bearing: 0, duration: 700, offset: [0, Math.max(90, (H - sh) / 2 + 20) - H / 2], essential: true });
  await Promise.race([new Promise(r => map.once('moveend', r)), parkSleep(1600)]);
  for (let i = 0; i < 40 && seq === pdSeq; i++) {
    let loaded = false;
    try { loaded = map.isSourceLoaded('openmaptiles'); } catch {}
    if (loaded && roadIndex.rebuild(map)) { signs.roadsChanged(); if (roadIndex.covers(dest.lat, dest.lng)) break; }
    await parkSleep(200);
  }
  if (seq !== pdSeq) return;
  prog(0.08);
  const [mly, osmAll] = await Promise.all([parkLoadSigns(dest.lat, dest.lng), parkLoadLocal(dest.lat, dest.lng, PD_RADIUS + 150)]);
  // „Mašīna stāvlaukumā” atzīme attiecas uz galamērķa punktu — ielu punktiem to nosaka katram atsevišķi.
  const osm = osmAll ? { elements: osmAll.elements.filter(el => !(el.tags && el.tags.amenity === 'parking' && !el.geometry)), lots: osmAll.lots, osm: osmAll.osm, local: true } : null;
  const lotBoxes = ((osm && osm.lots) || []).map(L => {
    let s = 90, w = 180, n = -90, e = -180;
    for (const [la, lo] of L.pts) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
    return { L, s, w, n, e };
  });
  const inLot = (la, lo) => lotBoxes.some(b => la >= b.s && la <= b.n && lo >= b.w && lo <= b.e && parkInPoly(la, lo, b.L.pts));
  if (seq !== pdSeq) return;
  prog(0.2);

  // Ielu posmi ap galamērķi (katrs posms vienreiz)
  const [s, w, n, e] = parkBox(dest.lat, dest.lng, PD_RADIUS);
  const segs = new Map();
  roadIndex.eachSegInBox(s, w, n, e, seg => {
    if (!PD_CLASSES.has(seg.cls) || segs.has(seg.id)) return;
    const mid = [(seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2];
    if (distM(dest.lat, dest.lng, mid[1], mid[0]) <= PD_RADIUS) segs.set(seg.id, seg);
  });
  // Pārbaudes punkti
  const samples = [];
  for (const seg of segs.values()) {
    const len = distM(seg.a[1], seg.a[0], seg.b[1], seg.b[0]);
    if (len < 6) continue;
    const br = parkBearing(seg.a, seg.b), k = Math.max(1, Math.round(len / PD_STEP));
    for (let i = 0; i < k; i++) {
      const t0 = i / k, t1 = (i + 1) / k, tm = (t0 + t1) / 2;
      const at = t => [seg.a[0] + (seg.b[0] - seg.a[0]) * t, seg.a[1] + (seg.b[1] - seg.a[1]) * t];
      for (const side of [1, -1]) {
        const dir = seg.oneway ? br : side === 1 ? br : (br + 180) % 360;
        const p = pdOffset(...at(tm), br, side * PD_OFFSET);
        samples.push({ lng: p[0], lat: p[1], dir, side, br, a: pdOffset(...at(t0), br, side * 3), b: pdOffset(...at(t1), br, side * 3) });
      }
    }
  }
  const names = pdNames(dest.lat, dest.lng);
  try { parkTileFeat = { poi: map.querySourceFeatures('openmaptiles', { sourceLayer: 'poi' }), tr: map.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation', filter: ['has', 'brunnel'] }) }; }
  catch { parkTileFeat = { poi: [], tr: [] }; }
  pdEnsureLayers();
  const feats = [], results = [];
  const t0 = performance.now();
  try {
    for (let i = 0; i < samples.length; i++) {
      if (seq !== pdSeq) return;
      const q = samples[i];
      if (inLot(q.lat, q.lng)) continue;                               // stāvlaukumus rāda atsevišķi
      const ctx = parkContext(q.lat, q.lng, q.dir, osm, 5, mly);
      const v = parkVerdict(ctx, eta);
      if (v.state === 'unknown') continue;
      let st = v.state, note = '';
      if (st === 'ok' && v.until && v.until - eta < 60 * 60000) { st = 'warn'; note = 'tikai līdz ' + pkWhen(v.until, eta); }
      else if (st === 'ok') note = v.until ? 'līdz ' + pkWhen(v.until, eta) : 'bez laika ierobežojuma';
      else if (st === 'warn') note = /maks/i.test(v.headline + v.sub) ? 'maksas' : pdShort((v.reasons.find(r => r.level === 'warn') || {}).text);
      else note = v.headline.toLowerCase();
      results.push({ q, st, note, d: distM(dest.lat, dest.lng, q.lat, q.lng) });
      feats.push({ type: 'Feature', properties: { c: PD_COLOR[st] }, geometry: { type: 'LineString', coordinates: [q.a, q.b] } });
      if (performance.now() - t0 > 40 * (1 + Math.floor(i / 40))) {    // ik pa brīdim atdod vadību saskarnei
        map.getSource('pd-lines') && map.getSource('pd-lines').setData({ type: 'FeatureCollection', features: feats });
        prog(0.2 + 0.75 * i / samples.length);
        await parkSleep(0);
      }
    }
  } finally { parkTileFeat = null; }
  if (seq !== pdSeq) return;
  map.getSource('pd-lines') && map.getSource('pd-lines').setData({ type: 'FeatureCollection', features: feats });

  // Stāvlaukumi tuvumā
  const lots = [];
  const lotFeats = [];
  for (const L of (osm && osm.lots) || []) {
    if (!L.tags) continue;
    const c = L.pts.reduce((m, q) => [m[0] + q[0] / L.pts.length, m[1] + q[1] / L.pts.length], [0, 0]);
    const d = distM(dest.lat, dest.lng, c[0], c[1]);
    if (d > PD_RADIUS + 60) continue;
    const t = L.tags, priv = /^(private|no)$/.test(t.access || ''), cust = /^(customers|residents|permit|permissive|destination)$/.test(t.access || '');
    const paid = t.fee === 'yes' || !!t['fee:conditional'];
    const st = priv ? 'no' : (cust || paid) ? 'warn' : 'ok';
    lotFeats.push({ type: 'Feature', properties: { c: PD_COLOR[st] }, geometry: { type: 'Polygon', coordinates: [L.pts.map(q => [q[1], q[0]]).concat(L.pts[0][0] === L.pts.at(-1)[0] && L.pts[0][1] === L.pts.at(-1)[1] ? [] : [[L.pts[0][1], L.pts[0][0]]])] } });
    if (priv) continue;
    lots.push({ lot: true, lat: c[0], lng: c[1], d, st, name: t.name || 'Stāvlaukums',
      note: [paid ? 'maksas' : t.fee === 'no' ? 'bez maksas' : '', cust ? (t.access === 'customers' ? 'klientiem' : 'ierobežota piekļuve') : '', t.maxstay ? 'max ' + t.maxstay : ''].filter(Boolean).join(' · ') });
  }
  map.getSource('pd-lots') && map.getSource('pd-lots').setData({ type: 'FeatureCollection', features: lotFeats });

  // Labākās vietas: katrai ielas pusei tuvākā zaļā (tad oranžā), plus stāvlaukumi
  const bySide = new Map();
  for (const r of results) {
    if (r.st === 'no') continue;
    r.name = r.name || pdNameAt(names, r.q.lat, r.q.lng) || 'Iela bez nosaukuma';
    const key = r.name + '|' + r.st + '|' + Math.round(r.q.br / 45) % 4 + (r.q.side > 0 ? 'R' : 'L');
    const b = bySide.get(key);
    if (!b || r.d < b.d) bySide.set(key, r);
  }
  const rank = x => x.d * (x.st === 'ok' ? 1 : 1.8);
  const picks = [...bySide.values(), ...lots].sort((a, b) => rank(a) - rank(b));
  const seenName = new Set(), list = [];
  for (const p of picks) { const k = (p.name || '') + p.st; if (seenName.has(k)) continue; seenName.add(k); list.push(p); if (list.length >= 5) break; }
  const counts = { ok: 0, warn: 0, no: 0 };
  for (const r of results) counts[r.st]++;
  pdState = { dest, eta, list, counts };
  pdRender();
}

function pdRender() {
  const P = pdState, body = $('parkBody');
  if (!P) return;
  body.textContent = '';
  const best = P.list.find(x => x.st === 'ok') || P.list[0];
  const card = document.createElement('div');
  card.className = 'pk-verdict pk-' + (best ? best.st : 'unknown');
  card.innerHTML = `<div class="pk-badge">${pkSvg(best ? best.st : 'unknown', 34)}</div><div class="pk-vt"><div class="pk-head"></div><div class="pk-sub"></div><div class="pk-conf"></div></div>`;
  card.querySelector('.pk-head').textContent = best ? (best.st === 'ok' ? 'Drīkst stāvēt ' + pdDist(best.d) + ' no galamērķa' : 'Tuvākā vieta ' + pdDist(best.d) + ' — ar nosacījumiem') : 'Atļautu vietu tuvumā neatradu';
  card.querySelector('.pk-sub').textContent = best ? best.name + (best.note ? ' · ' + best.note : '') : 'Pamēģini pietuvināt karti vai pārbaudīt konkrētu vietu, pieskaroties kartei.';
  card.querySelector('.pk-conf').textContent = `Ierašanās ${pkWhen(P.eta, new Date())} · pārbaudīti ${P.counts.ok + P.counts.warn + P.counts.no} ielas posmi`;
  body.appendChild(card);
  const leg = document.createElement('div');
  leg.className = 'pd-legend';
  leg.innerHTML = '<span><i style="background:#16a34a"></i>drīkst</span><span><i style="background:#f08c00"></i>ar nosacījumiem</span><span><i style="background:#e03131"></i>nedrīkst</span>';
  body.appendChild(leg);
  const ul = document.createElement('ul');
  ul.className = 'pd-list';
  for (const x of P.list) {
    const li = document.createElement('li');
    li.className = 'pd-item';
    li.innerHTML = `<span class="pd-dot" style="background:${PD_COLOR[x.st]}">${x.lot ? 'P' : ''}</span><div class="pd-t"><div class="pd-n"></div><div class="pd-s"></div></div>
      <div class="pd-b"><button type="button" class="pk-btn pd-info">Sīkāk</button><button type="button" class="btn primary pd-go">Braukt</button></div>`;
    li.querySelector('.pd-n').textContent = x.name;
    li.querySelector('.pd-s').textContent = pdDist(x.d) + ' līdz galamērķim' + (x.note ? ' · ' + x.note : '');
    const lat = x.lot ? x.lat : x.q.lat, lng = x.lot ? x.lng : x.q.lng;
    li.querySelector('.pd-t').addEventListener('click', () => { map.easeTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 17), duration: 500 }); parkFlashSign({ lat, lng }); });
    li.querySelector('.pd-info').addEventListener('click', () => parkCheck(lat, lng, { dir: x.lot ? null : x.q.dir, own: false }));
    li.querySelector('.pd-go').addEventListener('click', () => {
      const d = P.dest;
      closeParkSheet();
      selectDestination({ name: 'P · ' + x.name, sub: `${pdDist(x.d)} kājām līdz „${d.name}”`, lat, lng });
    });
    ul.appendChild(li);
  }
  body.appendChild(ul);
  const tip = document.createElement('p');
  tip.className = 'pk-tip';
  tip.textContent = 'Pieskaries jebkurai iekrāsotajai ielai, lai redzētu, kāpēc tur drīkst vai nedrīkst.';
  body.appendChild(tip);
  const fine = document.createElement('p');
  fine.className = 'pk-fine';
  fine.textContent = 'Krāsas balstītas uz ielu foto zīmēm (Mapillary), OpenStreetMap un Ceļu satiksmes noteikumiem ierašanās laikam. Pilsētu maksas zonas (piem., Rīgas centrā) zināmas tikai tur, kur tās atzīmētas kartē. Ielas bez krāsas nav pārbaudītas. Noteicošās ir zīmes uz vietas.';
  body.appendChild(fine);
}
// Īss iemesls sarakstam
function pdShort(t) {
  t = t || '';
  if (/iespējams|piederība/i.test(t)) return 'iespējams aizliegts — pārbaudi zīmi';
  if (/Krustojums/.test(t)) return 'tuvu krustojumam';
  if (/pārej/i.test(t)) return 'tuvu gājēju pārejai';
  if (/[Pp]ietura/.test(t)) return 'tuvu pieturai';
  if (/PIRMS/.test(t)) return 'aizlieguma zīme tuvumā';
  if (/plāksnīte/.test(t)) return 'zīmei ir laika plāksnīte — pārbaudi';
  if (/klientiem|atļauju/.test(t)) return 'ierobežota piekļuve';
  return t ? t.replace(/ — .*$/, '').toLowerCase() : 'pārbaudi zīmes';
}
function pdDist(m) { return m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(1).replace('.', ',') + ' km'; }

(function pdWait() {
  if (typeof wirePark === 'function' && $('destParkBtn') && typeof map !== 'undefined' && map) $('destParkBtn').addEventListener('click', pdOpen);
  else setTimeout(pdWait, 200);
})();
