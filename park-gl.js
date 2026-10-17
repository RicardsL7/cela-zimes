// „Vai drīkstu šeit stāvēt?” — kartes daļa un saskarne.
// Lēmuma loģika ir parking.js. Šeit: kur stāv mašīna (ceļš, virziens, ielas puse), kuras zīmes
// uz to attiecas (aiz mašīnas līdz krustojumam, tajā pašā pusē), OSM dati tuvumā, rezultāta
// kartīte, zona kartē, atgādinājums un „Mana mašīna”.
// Izmanto app-gl.js globālos: map, signs, state, roadIndex, distM, loadMlyTiles, tilesForBounds,
// loadDirectionsBox, attachTimes, fetchOverpass, showSignPhoto, $.

const PARK_CAR_KEY = 'czCar';
const PARK_LVL_COLOR = { ok: '#16a34a', warn: '#e8890c', no: '#e03131', unknown: '#7b8794' };
let parkSeq = 0;
let parkCur = null;          // { lat, lng, dir, own, ctx, verdict }
let parkPin = null, carMarker = null, parkReminderTimer = null, parkTick = null;
const parkOsmCache = new Map();

const parkSleep = ms => new Promise(r => setTimeout(r, ms));
function parkBox(lat, lng, m) {
  const dLat = m / 111320, dLng = dLat / Math.cos(lat * Math.PI / 180);
  return [lat - dLat, lng - dLng, lat + dLat, lng + dLng];
}
function parkStore(v) { try { if (v) localStorage.setItem(PARK_CAR_KEY, JSON.stringify(v)); else localStorage.removeItem(PARK_CAR_KEY); } catch {} }
function parkLoadCar() {
  try {
    const c = JSON.parse(localStorage.getItem(PARK_CAR_KEY) || 'null');
    if (c && typeof c.lat === 'number' && Date.now() - c.t < 3 * 864e5) return c;
  } catch {}
  return null;
}

// ---------- Ģeometrija ----------
// Punkta projekcija uz līnijas [[lng, lat], …]: { d (m līdz līnijai), along (m no sākuma), off (+ pa labi, − pa kreisi) }
function parkProject(line, lat, lng) {
  if (!line || line.length < 2) return null;
  const k = 111320, cos = Math.cos(lat * Math.PI / 180);
  let best = null, acc = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const ax = (a[0] - lng) * k * cos, ay = (a[1] - lat) * k, dx = (b[0] - a[0]) * k * cos, dy = (b[1] - a[1]) * k;
    const l2 = dx * dx + dy * dy, len = Math.sqrt(l2);
    if (!l2) continue;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
    const px = ax + t * dx, py = ay + t * dy, d = Math.hypot(px, py);
    if (!best || d < best.d) best = { d, along: acc + t * len, off: (dx * (-py) - dy * (-px)) < 0 ? d : -d };
    acc += len;
  }
  return best;
}
function parkLineLen(line) {
  let s = 0;
  for (let i = 1; i < line.length; i++) s += distM(line[i - 1][1], line[i - 1][0], line[i][1], line[i][0]);
  return s;
}
function parkLineSlice(line, m) {          // pirmie m metri līnijas
  const out = [line[0]];
  let s = 0;
  for (let i = 1; i < line.length; i++) {
    const d = distM(line[i - 1][1], line[i - 1][0], line[i][1], line[i][0]);
    if (s + d >= m) { const f = (m - s) / d; out.push([line[i - 1][0] + (line[i][0] - line[i - 1][0]) * f, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * f]); return out; }
    s += d; out.push(line[i]);
  }
  return out;
}
function parkBearing(a, b) {           // [lng, lat] → grādi
  const cos = Math.cos(a[1] * Math.PI / 180);
  return (Math.atan2((b[0] - a[0]) * cos, b[1] - a[1]) * 180 / Math.PI + 360) % 360;
}

// ---------- Dati ----------
// Pārliecinās, ka karte rāda šo vietu pietuvinātu (ceļu indekss nāk no redzamās kartes).
// Novieto vietu redzamajā kartes daļā virs kartītes. Atgriež true, ja karte kustas.
function parkFrame(lat, lng, force) {
  const H = map.getContainer().clientHeight, W = map.getContainer().clientWidth;
  const sheetH = $('parkSheet').hidden ? 0 : Math.min($('parkSheet').offsetHeight || H * 0.5, H * 0.62);
  const targetY = Math.max(90, (H - sheetH) / 2 + 30);
  const pt = map.project([lng, lat]);
  if (!force && map.getZoom() >= 16.2 && map.getPitch() <= 5 && pt.y > 70 && pt.y < H - sheetH - 30 && pt.x > 40 && pt.x < W - 90) return false;
  state.follow = false;
  map.easeTo({ center: [lng, lat], zoom: Math.max(17.2, Math.min(map.getZoom(), 18)), pitch: 0, duration: 650,
    offset: [0, targetY - H / 2], essential: true });
  return true;
}
async function parkEnsureView(lat, lng) {
  if (parkFrame(lat, lng)) await Promise.race([new Promise(r => map.once('moveend', r)), parkSleep(1500)]);
  for (let i = 0; i < 40; i++) {
    let loaded = false;
    try { loaded = map.isSourceLoaded('openmaptiles'); } catch {}
    if (loaded && roadIndex.rebuild(map)) { signs.roadsChanged(); if (roadIndex.covers(lat, lng)) return true; }
    await parkSleep(200);
  }
  return roadIndex.ready && roadIndex.covers(lat, lng);
}

// Mapillary zīmes un to virzieni ~450 m ap vietu.
async function parkLoadSigns(lat, lng) {
  if (!state.mlyToken) return false;
  const [s, w, n, e] = parkBox(lat, lng, 450);
  const tiles = tilesForBounds(s, w, n, e);
  try { await loadMlyTiles(tiles); } catch {}
  for (let i = 0; i < 40 && !tiles.every(([x, y]) => state.mlyTiles.has(x + ':' + y)); i++) await parkSleep(200);
  const ok = tiles.every(([x, y]) => state.mlyTiles.has(x + ':' + y));
  try {
    const [s2, w2, n2, e2] = parkBox(lat, lng, 320);
    await Promise.race([loadDirectionsBox(s2, w2, n2, e2), parkSleep(7000)]);
  } catch {}
  try { attachTimes(); } catch {}
  return ok;
}

function parkOsmQuery(lat, lng) {
  const p = lat.toFixed(6) + ',' + lng.toFixed(6);
  return `[out:json][timeout:12];
(
  way(around:35,${p})["highway"];
  node(around:70,${p})["highway"~"^(crossing|bus_stop)$"];
  node(around:70,${p})["railway"~"^(tram_stop|level_crossing)$"];
  node(around:70,${p})["public_transport"="platform"];
);
out tags geom;
is_in(${p})->.a;
(way(pivot.a)["amenity"="parking"]; relation(pivot.a)["amenity"="parking"];);
out tags;`;
}
async function parkLoadOsm(lat, lng) {
  const key = lat.toFixed(4) + ',' + lng.toFixed(4);
  const hit = parkOsmCache.get(key);
  if (hit && Date.now() - hit.t < 10 * 60000) return hit.v;
  // Overpass serveri bieži ir aizņemti (429/504) — mēģina vēlreiz ar pauzi.
  for (let i = 0; i < 3; i++) {
    try {
      const j = await fetchOverpass(parkOsmQuery(lat, lng), 20000);
      const v = { elements: j.elements || [] };
      parkOsmCache.set(key, { t: Date.now(), v });
      return v;
    } catch { await parkSleep(1500 * (i + 1)); }
  }
  return null;
}

// ---------- Konteksts lēmumam ----------
function parkContext(lat, lng, dirIn, osm, acc, mly) {
  const ctx = { signs: [], near: {}, acc, roadKnown: false, dirKnown: false, mly, osmOk: !!osm, lines: null };
  const els = osm ? osm.elements : [];
  const area = els.find(el => el.tags && el.tags.amenity === 'parking' && !el.geometry);
  if (area) {
    const t = area.tags;
    ctx.area = { name: t.name || '', access: t.access || '', fee: t.fee || '', feeCond: (t['fee:conditional'] || '').replace(/^yes\s*@\s*/, ''), oh: t.opening_hours || '', maxstay: pkMaxstay(t.maxstay) };
  }
  if (!roadIndex.ready || !roadIndex.covers(lat, lng)) return ctx;
  const cands = roadIndex._candidates(lat, lng, 12).filter(c => c.d <= 25).sort((a, b) => a.d - b.d);
  if (!cands.length) return ctx;
  const best = cands[0];
  ctx.roadKnown = true;
  // Braukšanas virziens un ielas puse (+1 — pa labi no braukšanas virziena).
  const geo = best.d >= 1.8 ? (best.right ? 1 : -1) : 0;           // pret a→b
  let dir;
  if (dirIn != null) dir = roadAngleDiff(dirIn, best.bearing) <= 90 ? best.bearing : (best.bearing + 180) % 360;
  else if (best.seg.oneway) dir = best.bearing;
  else if (geo) dir = geo === 1 ? best.bearing : (best.bearing + 180) % 360;   // divvirzienu ielā parasti stāv pa labi
  else dir = best.bearing;
  ctx.dirKnown = dirIn != null || best.seg.oneway || !!geo;
  const sameAB = roadAngleDiff(dir, best.bearing) < 1;
  const side = geo ? (sameAB ? geo : -geo) : (best.seg.oneway ? 0 : 1);
  ctx.dir = dir; ctx.side = side;

  // Ceļš uz priekšu (līdz krustojumam) un atpakaļ (līdz krustojumam — tik tālu darbojas zīmes aiz mašīnas).
  const mf = roadIndex.matchPosition(lat, lng, dir, acc), mb = roadIndex.matchPosition(lat, lng, (dir + 180) % 360, acc);
  const fw = mf ? roadIndex.walk(mf.P, mf.next, 160) : [best.P];
  const bw = mb ? roadIndex.walk(mb.P, mb.next, 420) : [best.P];
  ctx.lines = { fw, bw };
  if (fw.end === 'junction') ctx.near.junctionAhead = parkLineLen(fw);
  if (bw.end === 'junction') ctx.near.junctionBehind = parkLineLen(bw);
  // Punkts → { at (− aiz, + priekšā), curb (+1/−1 attiecībā pret mašīnas virzienu, 0 — uz ass) }
  const locate = (la, lo, maxD) => {
    const pf = parkProject(fw, la, lo), pb = parkProject(bw, la, lo);
    let r = null;
    if (pb && pb.d <= maxD && (!pf || pb.d <= pf.d)) r = { at: -pb.along, d: pb.d, off: -pb.off };   // atpakaļ līnija iet pretējā virzienā
    else if (pf && pf.d <= maxD) r = { at: pf.along, d: pf.d, off: pf.off };
    if (!r) return null;
    r.curb = Math.abs(r.off) < 1 ? 0 : r.off > 0 ? 1 : -1;
    return r;
  };

  // Zīmes
  const [s, w, n, e] = parkBox(lat, lng, 440);
  const tows = [];
  signs.eachInBox(s, w, n, e, x => {
    const kind = parkSignKind(x.value);
    if (!kind) return;
    const L = locate(x.lat, x.lng, 16);
    if (!L || L.at < -420 || L.at > 160) return;
    if (kind === 'tow') { tows.push(L.at); return; }
    if (kind === 'stop') { if (side === 0 || L.curb === 0 || L.curb === side) parkStop(ctx, L.at); return; }
    const m = signs.match(x);
    let facing = 0;                      // +1 — vērsta pret manu braukšanas virzienu (attiecas uz mani), −1 — pretējam
    if (m && m.travelDir != null) facing = roadAngleDiff(m.travelDir, dir) <= 60 ? 1 : roadAngleDiff(m.travelDir, dir) >= 120 ? -1 : 0;
    let sure = !!m && m.quality !== 'uncertain' && (m.dirSource !== 'side' || facing === 1);
    // Ielas puse: zīmei jābūt manā pusē.
    if (side !== 0 && L.curb !== 0 && L.curb !== side) return;
    if (side === 0 || L.curb === 0) sure = false;
    let at = L.at;
    if (facing === -1) {
      // Pretējā virziena zīme manā ielas pusē (stāvot pa kreisi): tās zona iet pretī — uz mani.
      if (side !== -1 || at < 0) return;
      at = -at;                          // pārvērš kā „aiz manis” (zona sniedzas līdz mašīnai)
      sure = false;
    } else if (facing === 0 && kind !== 'parking') sure = false;
    const cond = x.timeRule ? x.timeRule.cond : (x.timeCond || null);
    ctx.signs.push({ kind, at, cond: cond && cond.known ? cond : null, sure,
      timeUnknown: !(cond && cond.known) && !!x.restriction && !x.restriction.known, ref: x });
  });
  for (const t of tows) { const sg = ctx.signs.find(z => Math.abs(z.at - t) < 6 && /no-/.test(z.kind)); if (sg) sg.tow = true; }

  // OSM: pārejas, pieturas, dzelzceļš, tilti, ielas stāvēšanas atzīmes
  for (const el of els) {
    const t = el.tags || {};
    if (el.type === 'node') {
      if (t.highway === 'crossing') {
        const L = locate(el.lat, el.lon, 5);
        if (L && L.at > -6 && (ctx.near.crossingAt == null || Math.abs(L.at) < Math.abs(ctx.near.crossingAt))) ctx.near.crossingAt = L.at;
      } else if (t.railway === 'level_crossing') {
        const d = distM(lat, lng, el.lat, el.lon);
        if (ctx.near.railM == null || d < ctx.near.railM) ctx.near.railM = d;
      } else if (t.highway === 'bus_stop' || (t.public_transport === 'platform' && (t.bus === 'yes' || t.trolleybus === 'yes')) || t.railway === 'tram_stop') {
        const L = locate(el.lat, el.lon, 22);
        if (L && (side === 0 || L.curb === 0 || L.curb === side)) parkStop(ctx, L.at);
      }
    } else if (el.type === 'way' && el.geometry && t.highway) {
      const line = el.geometry.map(g => [g.lon, g.lat]);
      const pr = parkProject(line, lat, lng);
      if (!pr || pr.d > 14) continue;
      // Ceļa virziens tuvākajā vietā
      let bi = 1, bd = Infinity;
      for (let i = 1; i < line.length; i++) { const q = parkProject([line[i - 1], line[i]], lat, lng); if (q && q.d < bd) { bd = q.d; bi = i; } }
      const wb = parkBearing(line[bi - 1], line[bi]);
      if (Math.min(roadAngleDiff(wb, dir), roadAngleDiff(wb, (dir + 180) % 360)) > 35) continue;
      if (pr.d < 8 && /^(yes|viaduct)$/.test(t.bridge || '')) ctx.near.bridge = true;
      if (pr.d < 8 && /^(yes|building_passage)$/.test(t.tunnel || '') && t.tunnel !== 'building_passage') ctx.near.tunnel = true;
      if (ctx.osm === undefined || pr.d < ctx._osmD) {
        const forward = roadAngleDiff(wb, dir) <= 90;
        const osmSide = (side === -1) === forward ? 'left' : 'right';
        const o = parkOsmSide(t, side === 0 ? 'right' : osmSide);
        ctx._osmD = pr.d;
        ctx.osm = o;
        ctx.osmWay = t.name || '';
      }
    }
  }
  if (ctx.osm === undefined) ctx.osm = null;
  return ctx;
}
function parkStop(ctx, at) {
  if (at >= 0) { if (ctx.near.stopAhead == null || at < ctx.near.stopAhead) ctx.near.stopAhead = at; }
  else if (ctx.near.stopBehind == null || -at < ctx.near.stopBehind) ctx.near.stopBehind = -at;
}

// ---------- Pārbaude ----------
async function parkCheck(lat, lng, opts = {}) {
  const seq = ++parkSeq;
  const own = !!opts.own;
  const dirIn = opts.dir != null ? opts.dir : own ? state.heading : null;
  const acc = own && state.me && state.me.accuracy ? state.me.accuracy : (own ? 10 : 6);
  openParkSheet();
  parkRenderLoading(own ? 'Pārbaudu vietu, kur tu esi…' : 'Pārbaudu izvēlēto vietu…');
  parkShowPin(lat, lng, 'unknown');
  const step = (k, st) => { if (seq === parkSeq) { const li = document.querySelector(`#parkBody [data-step="${k}"]`); if (li) li.className = 'pk-step ' + st; } };
  step('road', 'run');
  const viewOk = await parkEnsureView(lat, lng);
  if (seq !== parkSeq) return;
  step('road', viewOk ? 'done' : 'fail');
  step('signs', 'run'); step('osm', 'run');
  let osm = null, osmDone = false;
  const osmP = parkLoadOsm(lat, lng).then(v => { osm = v; osmDone = true; step('osm', v ? 'done' : 'fail'); return v; });
  const mly = await parkLoadSigns(lat, lng);
  step('signs', state.mlyToken ? (mly ? 'done' : 'fail') : 'skip');
  await Promise.race([osmP, parkSleep(2500)]);       // OSM gaida nedaudz; ja kavējas — atbilde tagad, papildina vēlāk
  if (seq !== parkSeq) return;
  const finish = () => {
    // Pēc ielādes ceļu indekss var būt pārbūvēts — pārliecinās, ka tas aptver vietu.
    const ctx = parkContext(lat, lng, dirIn, osm, acc, mly);
    if (!osmDone) ctx.osmPending = true;
    const verdict = parkVerdict(ctx, new Date());
    parkCur = { lat, lng, dir: ctx.dir, own, ctx, verdict, at: Date.now() };
    parkRender();
    parkDrawZone();
    requestAnimationFrame(() => parkFrame(lat, lng));
    return ctx;
  };
  if (!roadIndex.covers(lat, lng)) await parkEnsureView(lat, lng);
  if (seq !== parkSeq) return;
  finish();
  if (own && (!state.me || (state.me.speedKmh ?? 0) < 12)) parkSaveCar(parkCur);
  if (!osmDone) {
    await osmP;
    if (seq !== parkSeq) return;
    if (!roadIndex.covers(lat, lng)) await parkEnsureView(lat, lng);
    if (seq !== parkSeq) return;
    finish();
    if (own && (!state.me || (state.me.speedKmh ?? 0) < 12)) parkSaveCar(parkCur);
  }
}

function parkSaveCar(p) {
  const v = p.verdict;
  const car = { lat: p.lat, lng: p.lng, dir: p.dir, t: Date.now(), state: v.state, headline: v.headline,
    until: v.until ? +v.until : null, remindAt: null };
  const old = parkLoadCar();
  if (old && distM(old.lat, old.lng, p.lat, p.lng) < 25 && old.remindAt) car.remindAt = old.remindAt;   // tā pati vieta — atgādinājums paliek
  parkStore(car);
  parkShowCar();
}

// ---------- Saskarne ----------
function openParkSheet() {
  if (!$('placesSheet').hidden) closePlaces();
  if (typeof toggleSettings === 'function') toggleSettings(false);
  $('parkSheet').hidden = false;
  document.documentElement.classList.add('parking');
  clearInterval(parkTick);
  parkTick = setInterval(parkRefreshLive, 30000);
}
function closeParkSheet() {
  parkSeq++;
  $('parkSheet').hidden = true;
  document.documentElement.classList.remove('parking');
  clearInterval(parkTick);
  if (parkPin) { parkPin.remove(); parkPin = null; }
  parkClearZone();
}
function parkRenderLoading(title) {
  $('parkBody').innerHTML = `<div class="pk-loading"><div class="pk-spin" aria-hidden="true"></div><p class="pk-lt"></p>
    <ul class="pk-steps">
      <li class="pk-step" data-step="road">Ceļš, virziens un ielas puse</li>
      <li class="pk-step" data-step="signs">Ceļa zīmes un laika plāksnītes</li>
      <li class="pk-step" data-step="osm">Pārejas, pieturas, krustojumi, stāvlaukumi</li>
    </ul></div>`;
  $('parkBody').querySelector('.pk-lt').textContent = title;
}
const PK_ICON = {
  ok: '<path d="m7 12.5 3.2 3.2L17.5 8.5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>',
  warn: '<path d="M12 7v6.2" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/><circle cx="12" cy="16.9" r="1.6" fill="currentColor"/>',
  no: '<path d="m8 8 8 8M16 8l-8 8" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/>',
  unknown: '<path d="M9.4 9.3a2.7 2.7 0 1 1 3.6 2.6c-.7.3-1 .8-1 1.5v.6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="17.2" r="1.5" fill="currentColor"/>',
  info: '<circle cx="12" cy="7.6" r="1.5" fill="currentColor"/><path d="M12 11v6" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
};
function pkSvg(k, size = 24) { return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${PK_ICON[k]}</svg>`; }

function parkRender() {
  const p = parkCur;
  if (!p) return;
  const v = p.verdict, body = $('parkBody');
  body.textContent = '';
  // Galvenā atbilde
  const card = document.createElement('div');
  card.className = 'pk-verdict pk-' + v.state;
  card.innerHTML = `<div class="pk-badge">${pkSvg(v.state, 34)}</div><div class="pk-vt"><div class="pk-head"></div><div class="pk-sub"></div><div class="pk-conf"></div></div>`;
  card.querySelector('.pk-head').textContent = v.headline;
  card.querySelector('.pk-sub').textContent = v.sub;
  card.querySelector('.pk-conf').textContent = p.ctx.osmPending ? 'Papildina ar pārejām, pieturām un stāvlaukumiem…' : v.confidenceText;
  body.appendChild(card);
  if (p.ctx.osmWay || p.ctx.area) {
    const where = document.createElement('p');
    where.className = 'pk-where';
    where.textContent = (p.ctx.area ? 'Stāvlaukums' + (p.ctx.area.name ? ' „' + p.ctx.area.name + '”' : '') : p.ctx.osmWay) +
      (p.ctx.dirKnown || p.ctx.area ? '' : ' · virziens nav zināms');
    body.appendChild(where);
  }
  // Darbības
  const acts = document.createElement('div');
  acts.className = 'pk-acts';
  const btn = (cls, icon, text, fn, title) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'pk-btn ' + cls; b.title = title || text;
    b.innerHTML = icon + '<span></span>'; b.querySelector('span').textContent = text;
    b.addEventListener('click', fn); acts.appendChild(b); return b;
  };
  const car = parkLoadCar();
  const isCar = car && distM(car.lat, car.lng, p.lat, p.lng) < 25;
  if (v.remindAt) {
    const armed = isCar && car.remindAt && Math.abs(car.remindAt - v.remindAt) < 60000;
    btn('pk-remind' + (armed ? ' on' : ''), '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3.5a5.5 5.5 0 0 0-5.5 5.5v3.6L5 15.5h14l-1.5-2.9V9A5.5 5.5 0 0 0 12 3.5Z" fill="currentColor"/><path d="M10 18a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
      armed ? 'Atgādināšu ' + pkWhen(v.remindAt, new Date()) : 'Atgādināt ' + pkWhen(v.remindAt, new Date()), () => parkSetReminder(p), 'Atgādinājums lietotnē (kamēr lietotne ir atvērta)');
    btn('pk-cal', '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
      'Kalendārā', () => parkCalendar(p), 'Pievienot telefona kalendāram — atgādinās vienmēr');
  }
  if (!p.ctx.area && p.ctx.roadKnown) btn('pk-flip', '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 4v14m0 0-3-3m3 3 3-3M17 20V6m0 0-3 3m3-3 3 3" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    'Otrā virzienā', () => parkCheck(p.lat, p.lng, { dir: (p.dir + 180) % 360, own: p.own }), 'Mašīna stāv pretējā virzienā vai otrā ielas pusē');
  if (acts.childNodes.length) body.appendChild(acts);
  // Kāpēc
  const ul = document.createElement('ul');
  ul.className = 'pk-reasons';
  for (const r of v.reasons) {
    const li = document.createElement('li');
    li.className = 'pk-r pk-r-' + r.level;
    const ico = r.ref && r.ref.src ? `<img class="pk-sign" alt="" src="${r.ref.src}">` : `<span class="pk-dot">${pkSvg(r.level === 'info' ? 'info' : r.level, 16)}</span>`;
    li.innerHTML = ico + '<div class="pk-rt"><div class="pk-rx"></div><div class="pk-rs"></div></div>';
    li.querySelector('.pk-rx').textContent = r.text;
    li.querySelector('.pk-rs').textContent = [r.detail, r.src].filter(Boolean).join(' · ');
    if (r.ref) {
      li.classList.add('tap');
      li.addEventListener('click', () => { const H = map.getContainer().clientHeight, sh = Math.min($('parkSheet').offsetHeight, H * 0.62); map.easeTo({ center: [r.ref.lng, r.ref.lat], duration: 500, offset: [0, Math.max(90, (H - sh) / 2 + 30) - H / 2] }); parkFlashSign(r.ref); });
    }
    ul.appendChild(li);
  }
  body.appendChild(ul);
  // Pierādījums: zīmes foto
  const pr = v.proof;
  if (pr && pr.mid && state.mlyToken) {
    const box = document.createElement('div');
    box.className = 'pk-proof';
    const h = document.createElement('div'); h.className = 'pk-proof-h'; h.textContent = 'Pierādījums — zīme no ielas foto';
    box.appendChild(h);
    body.appendChild(box);
    showSignPhoto(box, pr.mid, null);
  }
  // Mašīna
  if (p.own || isCar) {
    const c = document.createElement('div');
    c.className = 'pk-car';
    c.innerHTML = '<span class="pk-car-ico" aria-hidden="true">' + PARK_CAR_SVG + '</span><span class="pk-car-t"></span>';
    c.querySelector('.pk-car-t').textContent = isCar ? 'Mašīnas vieta saglabāta — kartē redzēsi, kur to atstāji' : 'Mašīnas vieta nav saglabāta';
    if (isCar) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'link-btn'; b.textContent = 'Aizmirst';
      b.addEventListener('click', () => { parkForgetCar(); parkRender(); });
      c.appendChild(b);
    }
    body.appendChild(c);
  } else {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'pk-savecar'; b.innerHTML = PARK_CAR_SVG + '<span>Te noliku mašīnu</span>';
    b.addEventListener('click', () => { parkSaveCar(p); parkRender(); });
    body.appendChild(b);
  }
  const tip = document.createElement('p');
  tip.className = 'pk-tip';
  tip.textContent = 'Pieskaries kartei, lai pārbaudītu jebkuru citu vietu — arī galamērķī pirms brauciena.';
  body.appendChild(tip);
  const fine = document.createElement('p');
  fine.className = 'pk-fine';
  fine.textContent = 'Atbilde balstīta uz ielu foto (Mapillary), OpenStreetMap un Ceļu satiksmes noteikumiem. Dati var būt novecojuši — noteicošās ir zīmes un apzīmējumi uz vietas.';
  body.appendChild(fine);
  parkShowPin(p.lat, p.lng, v.state);
}

// Ik pēc 30 s: laiks iet — atbilde var mainīties (piem., 19:00 aizliegums beidzas).
function parkRefreshLive() {
  if (!parkCur || $('parkSheet').hidden) return;
  const v = parkVerdict(parkCur.ctx, new Date());
  const changed = v.state !== parkCur.verdict.state;
  parkCur.verdict = v;
  if (changed) { parkRender(); parkDrawZone(); }
  else {
    const sub = document.querySelector('#parkBody .pk-sub');
    if (sub) sub.textContent = v.sub;
  }
}

// ---------- Karte: pārbaudes vieta, zona, mašīna ----------
function parkShowPin(lat, lng, st) {
  if (!parkPin) {
    const el = document.createElement('div');
    el.className = 'pk-pin';
    el.innerHTML = '<span class="pk-pin-pulse"></span><span class="pk-pin-p">P</span>';
    parkPin = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([lng, lat]).addTo(map);
  }
  parkPin.setLngLat([lng, lat]);
  parkPin.getElement().dataset.st = st;
}
function parkClearZone() {
  const src = map && map.getSource && map.getSource('park-zone');
  if (src) src.setData({ type: 'FeatureCollection', features: [] });
}
function parkEnsureLayers() {
  if (map.getSource('park-zone')) return;
  map.addSource('park-zone', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('park-walk', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const before = map.getLayer('signs') ? 'signs' : undefined;
  map.addLayer({ id: 'park-walk', type: 'line', source: 'park-walk', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#3b5bdb', 'line-width': 5, 'line-dasharray': [0.1, 1.8] } }, before);
  map.addLayer({ id: 'park-zone-casing', type: 'line', source: 'park-zone', filter: ['==', ['get', 'k'], 'zone'],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 13, 'line-opacity': 0.85 } }, before);
  map.addLayer({ id: 'park-zone', type: 'line', source: 'park-zone', filter: ['==', ['get', 'k'], 'zone'],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'c'], 'line-width': 8, 'line-opacity': 0.9 } }, before);
  map.addLayer({ id: 'park-sign', type: 'circle', source: 'park-zone', filter: ['==', ['get', 'k'], 'sign'],
    paint: { 'circle-radius': 15, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 3.5, 'circle-stroke-color': ['get', 'c'] } });
}
// Kartē: posms, uz kuru attiecas atbilde (no noteicošās zīmes līdz mašīnai) un pati zīme.
function parkDrawZone() {
  const p = parkCur;
  if (!p || !p.ctx.lines) { parkClearZone(); return; }
  parkEnsureLayers();
  const col = PARK_LVL_COLOR[p.verdict.state];
  const feats = [];
  const { fw, bw } = p.ctx.lines;
  const proofSign = p.ctx.signs.find(s => s.ref === p.verdict.proof);
  const back = proofSign && proofSign.at < 0 ? Math.min(-proofSign.at, 420) : Math.min(40, parkLineLen(bw));
  const zone = parkLineSlice(bw, back).reverse().concat(parkLineSlice(fw, Math.min(14, parkLineLen(fw))).slice(1));
  if (zone.length > 1) feats.push({ type: 'Feature', properties: { k: 'zone', c: col }, geometry: { type: 'LineString', coordinates: zone } });
  for (const r of p.verdict.reasons) if (r.ref) feats.push({ type: 'Feature', properties: { k: 'sign', c: PARK_LVL_COLOR[r.level] || '#7b8794' }, geometry: { type: 'Point', coordinates: [r.ref.lng, r.ref.lat] } });
  map.getSource('park-zone').setData({ type: 'FeatureCollection', features: feats });
}
function parkFlashSign(s) {
  const el = document.createElement('div');
  el.className = 'pk-flash';
  const m = new maplibregl.Marker({ element: el }).setLngLat([s.lng, s.lat]).addTo(map);
  setTimeout(() => m.remove(), 1800);
}

const PARK_CAR_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M5.2 10.6 6.8 6.4A2 2 0 0 1 8.7 5h6.6a2 2 0 0 1 1.9 1.4l1.6 4.2A2.5 2.5 0 0 1 20.5 13v3.6a1 1 0 0 1-1 1h-.8v1.2a1.2 1.2 0 0 1-2.4 0v-1.2H7.7v1.2a1.2 1.2 0 0 1-2.4 0v-1.2h-.8a1 1 0 0 1-1-1V13a2.5 2.5 0 0 1 1.7-2.4ZM7.4 10.2h9.2l-1.2-3.2H8.6Z" fill="currentColor"/><circle cx="7.4" cy="13.8" r="1.3" fill="#fff"/><circle cx="16.6" cy="13.8" r="1.3" fill="#fff"/></svg>';

// Kartē „Mana mašīna” ar atlikušo laiku.
function parkShowCar() {
  const car = parkLoadCar();
  if (!car) { if (carMarker) { carMarker.remove(); carMarker = null; } return; }
  if (!carMarker) {
    const el = document.createElement('button');
    el.type = 'button'; el.className = 'car-marker';
    el.innerHTML = '<span class="cm-ico">' + PARK_CAR_SVG + '</span><span class="cm-t"></span>';
    el.addEventListener('click', ev => { ev.stopPropagation(); parkOpenCar(); });
    carMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([car.lng, car.lat]).addTo(map);
  }
  carMarker.setLngLat([car.lng, car.lat]);
  parkUpdateCarChip();
  parkArmReminder(car);
}
function parkUpdateCarChip() {
  const car = parkLoadCar();
  if (!carMarker || !car) return;
  const el = carMarker.getElement(), now = Date.now();
  let txt = 'Mana mašīna', st = car.state;
  if (car.until && car.until > now) { txt = 'vēl ' + pkDur(car.until - now); if (car.until - now < 30 * 60000) st = 'warn'; }
  else if (car.until && car.until <= now) { txt = 'laiks beidzies!'; st = 'no'; }
  else if (car.state === 'no') txt = 'aizliegts!';
  el.querySelector('.cm-t').textContent = txt;
  el.dataset.st = st;
  el.title = 'Mana mašīna — novietota ' + pkWhen(new Date(car.t), new Date());
}
function parkForgetCar() {
  parkStore(null);
  clearTimeout(parkReminderTimer);
  if (carMarker) { carMarker.remove(); carMarker = null; }
  const src = map.getSource('park-walk');
  if (src) src.setData({ type: 'FeatureCollection', features: [] });
}
// Pieskāriens mašīnai: atkārtota pārbaude tur + ceļš kājām līdz mašīnai.
async function parkOpenCar() {
  const car = parkLoadCar();
  if (!car) return;
  await parkCheck(car.lat, car.lng, { dir: car.dir, own: false });
  if (!parkCur) return;
  const body = $('parkBody');
  const box = document.createElement('div');
  box.className = 'pk-walk';
  box.innerHTML = '<div class="pk-walk-t"></div>';
  const t = box.querySelector('.pk-walk-t');
  t.textContent = 'Novietota ' + pkWhen(new Date(car.t), new Date());
  if (state.me) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn primary pk-walk-b';
    b.textContent = 'Aiziet līdz mašīnai';
    b.addEventListener('click', () => parkWalkToCar(car, t));
    box.appendChild(b);
  }
  const f = document.createElement('button');
  f.type = 'button'; f.className = 'btn ghost pk-walk-b'; f.textContent = 'Mašīnu paņēmu';
  f.addEventListener('click', () => { parkForgetCar(); closeParkSheet(); });
  box.appendChild(f);
  body.insertBefore(box, body.children[1] || null);
}
async function parkWalkToCar(car, label) {
  if (!state.me) return;
  parkEnsureLayers();
  const a = [state.me.lng, state.me.lat], b = [car.lng, car.lat];
  let coords = [a, b], dist = distM(a[1], a[0], b[1], b[0]), dur = dist / 1.3, real = false;
  try {
    const url = `https://routing.openstreetmap.de/routed-foot/route/v1/driving/${a[0].toFixed(6)},${a[1].toFixed(6)};${b[0].toFixed(6)},${b[1].toFixed(6)}?overview=full&geometries=geojson`;
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 8000);
    const j = await fetch(url, { signal: ctl.signal }).then(r => r.json()).finally(() => clearTimeout(tm));
    const r = j && j.routes && j.routes[0];
    if (r && r.geometry) { coords = r.geometry.coordinates; dist = r.distance; dur = r.duration; real = true; }
  } catch {}
  map.getSource('park-walk').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
  const lngs = coords.map(c => c[0]), lats = coords.map(c => c[1]);
  state.follow = false;
  map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
    { padding: { top: 90, bottom: Math.min($('parkSheet').offsetHeight + 30, window.innerHeight - 220), left: 50, right: 90 }, maxZoom: 18, pitch: 0, duration: 800 });
  label.textContent = `Kājām ${dist < 1000 ? Math.round(dist / 10) * 10 + ' m' : (dist / 1000).toFixed(1).replace('.', ',') + ' km'} · ~${Math.max(1, Math.round(dur / 60))} min` + (real ? '' : ' (taisnā līnijā)');
}

// ---------- Atgādinājums ----------
function parkReminderText(car) {
  const u = car.until ? new Date(car.until) : null;
  return u ? `No ${pkWhen(u, new Date())} mašīnu te atstāt nedrīkst. Pārliec to!` : 'Laiks pārlikt mašīnu.';
}
async function parkSetReminder(p) {
  if (!p.verdict.remindAt) return;
  if (p.own === false && !(parkLoadCar() && distM(parkLoadCar().lat, parkLoadCar().lng, p.lat, p.lng) < 25)) parkSaveCar(p);
  const car = parkLoadCar();
  car.remindAt = +p.verdict.remindAt; car.until = p.verdict.until ? +p.verdict.until : car.until;
  parkStore(car);
  try { if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission(); } catch {}
  parkArmReminder(car);
  parkShowCar();
  parkRender();
  parkToast(`Atgādināšu ${pkWhen(p.verdict.remindAt, new Date())}. Drošākam atgādinājumam pievieno arī kalendāram.`);
}
function parkArmReminder(car) {
  clearTimeout(parkReminderTimer);
  if (!car || !car.remindAt) return;
  const ms = car.remindAt - Date.now();
  if (ms <= 0) { if (ms > -30 * 60000 && !car.fired) parkFire(car); return; }
  parkReminderTimer = setTimeout(() => parkFire(parkLoadCar() || car), Math.min(ms, 2 ** 31 - 1));
}
function parkFire(car) {
  if (!car || car.fired) return;
  car.fired = true; parkStore(car);
  const text = parkReminderText(car);
  try { if ('Notification' in window && Notification.permission === 'granted') new Notification('Ceļa Zīmes — mašīna', { body: text, tag: 'cz-park' }); } catch {}
  try { navigator.vibrate && navigator.vibrate([250, 120, 250, 120, 400]); } catch {}
  parkToast(text, true);
  parkUpdateCarChip();
}
function parkCalendar(p) {
  const v = p.verdict;
  if (!v.remindAt) return;
  const ics = parkIcs({ start: v.remindAt, end: v.until || new Date(v.remindAt.getTime() + 15 * 60000),
    title: 'Pārliec mašīnu', text: (v.until ? `No ${pkWhen(v.until, v.remindAt)} te stāvēt aizliegts. ` : '') + 'Ceļa Zīmes',
    lat: p.lat, lng: p.lng, alarmMin: 0, uid: 'park-' + Math.round(p.lat * 1e5) + '-' + Math.round(p.lng * 1e5) + '-' + (+v.remindAt) + '@cela-zimes' });
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'parvietot-masinu.ics';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function parkToast(text, loud) {
  let t = $('parkToast');
  if (!t) { t = document.createElement('div'); t.id = 'parkToast'; t.className = 'pk-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = text;
  t.classList.toggle('loud', !!loud);
  t.classList.add('show');
  clearTimeout(parkToast._t);
  parkToast._t = setTimeout(() => t.classList.remove('show'), loud ? 12000 : 5000);
  t.onclick = () => t.classList.remove('show');
}

// ---------- Pieslēgšana ----------
function wirePark() {
  $('parkBtn').addEventListener('click', () => {
    if (state.me) parkCheck(state.me.lat, state.me.lng, { own: true });
    else { const c = map.getCenter(); parkCheck(c.lat, c.lng, { own: false }); parkToast('GPS vēl nav — pārbaudu kartes centru. Pieskaries kartei, lai izvēlētos vietu.'); }
  });
  $('closePark').addEventListener('click', closeParkSheet);
  map.on('click', e => {
    if ($('parkSheet').hidden) return;
    const layers = ['signs', 'alerts', 'radar-icon', 'radar-core'].filter(l => map.getLayer(l));
    if (layers.length && map.queryRenderedFeatures(e.point, { layers }).length) return;
    parkCheck(e.lngLat.lat, e.lngLat.lng, { own: false });
  });
  setInterval(parkUpdateCarChip, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { const c = parkLoadCar(); parkArmReminder(c); parkUpdateCarChip(); } });
  parkShowCar();
}
(function parkWait() {
  if (typeof map !== 'undefined' && map && typeof signs !== 'undefined' && signs && map.isStyleLoaded && map.isStyleLoaded()) wirePark();
  else setTimeout(parkWait, 150);
})();
