// Automātiskie testi: node tests/run.js
// Ielādē lietotnes moduļus (bez kartes un pārlūka) vienā kontekstā un pārbauda
// zīmju piesaisti ceļam, virzienus, maršruta filtrēšanu, laikus un datu modeli.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
// A08: Windows ar git core.autocrlf failus var izdot ar CRLF rindu beigām — testi (un ielādētie moduļi) vienmēr redz LF,
// tāpēc rezultāts nav atkarīgs no operētājsistēmas. (.gitattributes arī liek LF, šis — drošībai.)
const readRaw = fs.readFileSync;
fs.readFileSync = function () { const r = readRaw.apply(fs, arguments); return typeof r === 'string' ? r.replace(/\r\n/g, '\n') : r; };

const ctx = vm.createContext({ console, Intl, Date, Math, Map, Set, JSON, Number, String, Array, Object, isNaN, setTimeout, clearTimeout,
  signSvg: () => '<svg/>', encodeURIComponent, decodeURIComponent, escape, URLSearchParams, Buffer, Error, Promise });
for (const f of ['times.js', 'model.js', 'roads-gl.js', 'signs-gl.js', 'nav.js', 'speedlimit.js', 'alerts.js', 'places.js', 'cache.js', 'auth.js', 'rides.js', 'reports.js']) {
  // Klases un const deklarācijas padara pieejamas testam.
  const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/if \(typeof module[\s\S]*?\n}\n?$/m, '');
  vm.runInContext(src + '\n;globalThis.__exp = (globalThis.__exp || {});', ctx, { filename: f });
}
const G = name => vm.runInContext(name, ctx);
const roadIndex = G('roadIndex'), SignStore = G('SignStore');
const parseCondition = G('parseCondition'), invertCondition = G('invertCondition'), isLvHoliday = G('isLvHoliday');
const makeRestriction = G('makeRestriction'), describeRestriction = G('describeRestriction');
const parseVerifiedGeoJSON = G('parseVerifiedGeoJSON'), SignDeduper = G('SignDeduper'), gpsFixQuality = G('gpsFixQuality');
const dedupeAlong = G('dedupeAlong');

// ---------- Palīgi ----------
let pass = 0, fail = 0;
const results = [];
const pending = [];
function test(name, fn) {
  const idx = results.push('') - 1;
  const okF = () => { pass++; results[idx] = '  ✓ ' + name; };
  const bad = e => { fail++; results[idx] = '  ✗ ' + name + '\n      ' + e.message; };
  try { const r = fn(); if (r && typeof r.then === 'function') pending.push(r.then(okF, bad)); else okF(); }
  catch (e) { bad(e); }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || ''} — sagaidīts ${JSON.stringify(b)}, ir ${JSON.stringify(a)}`); }
function ok(v, msg) { if (!v) throw new Error(msg || 'nav patiess'); }

// Lokālas koordinātas metros ap Rīgu → [lng, lat]
const LAT0 = 56.95, LNG0 = 24.10, K = 111320, COS = Math.cos(LAT0 * Math.PI / 180);
const P = (x, y) => [LNG0 + x / (K * COS), LAT0 + y / K];
const LL = (x, y) => { const p = P(x, y); return { lat: p[1], lng: p[0] }; };
function seg(x1, y1, x2, y2, roadId, extra = {}) { return Object.assign({ a: P(x1, y1), b: P(x2, y2), cls: 'minor', roadId }, extra); }
// Ceļš kā vairāki posmi pa 50 m
function road(x1, y1, x2, y2, roadId, extra) {
  const out = [], n = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1) / 50));
  for (let i = 0; i < n; i++) out.push(seg(x1 + (x2 - x1) * i / n, y1 + (y2 - y1) * i / n, x1 + (x2 - x1) * (i + 1) / n, y1 + (y2 - y1) * (i + 1) / n, roadId, extra));
  return out;
}
const COVER = [LAT0 - 0.01, LNG0 - 0.02, LAT0 + 0.01, LNG0 + 0.02];
function makeRoute(pts) {   // pts: [[x,y], ...] metros
  const coords = pts.map(([x, y]) => P(x, y)), cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { coords, cum };
}
function store() {
  const s = new SignStore({ getSource: () => null });
  s.setRoads(roadIndex);
  return s;
}
let uid = 0;
function sign(x, y, value, face = null, cat = 'other') { return Object.assign(LL(x, y), { value, face, cat, icon: value, title: value, uid: 't' + (++uid) }); }
const routeIds = st => st.routeList.map(it => it.s.uid);
const rigaDate = s => new Date(s);   // ISO ar nobīdi, piem. '2026-10-12T05:59:00+03:00'

// =====================================================================
console.log('Ceļa zīmju testi\n');

// 1. Divas paralēlas ielas ar atšķirīgām zīmēm
test('1. Paralēlas ielas: zīme tiek piesaistīta savai ielai, nevis tuvākajai citai', () => {
  roadIndex.setSegments([...road(-200, 0, 300, 0, 'A'), ...road(-200, 30, 300, 30, 'B')], COVER);
  const m = roadIndex.snapSign(LL(50, 9).lat, LL(50, 9).lng, 270, 'regulatory--no-parking--g1');
  eq(m.roadId, 'A', 'ceļš'); eq(m.quality, 'ok', 'kvalitāte'); eq(Math.round(m.travelDir), 90, 'virziens');
});
test('1b. Paralēlas ielas: maršrutā pa ielu B nerāda ielas A zīmi (agrāk 28 m rādiuss to rādīja)', () => {
  const st = store();
  const a = sign(50, 9, 'regulatory--no-parking--g1', 270);        // ielas A zīme (21 m no B)
  const b = sign(80, 24, 'regulatory--maximum-speed-limit-30--g1', 270, 'speed'); // ielas B zīme, B labajā pusē? (B ass y=30, zīme dienvidos = labā eastbound)
  st.add(a); st.add(b);
  st.setRoute(makeRoute([[-150, 30], [250, 30]]));
  st._rebuildRouteList();
  ok(!routeIds(st).includes(a.uid), 'ielas A zīme maršrutā'); ok(routeIds(st).includes(b.uid), 'ielas B zīme nav maršrutā');
});
test('1c. Paralēlas ielas: zīme pa vidu bez virziena → NESKAIDRA (netiek piesaistīta automātiski)', () => {
  const m = roadIndex.snapSign(LL(60, 15).lat, LL(60, 15).lng, null, 'regulatory--no-parking--g1');
  eq(m.quality, 'uncertain');
  const st = store(); const x = sign(60, 15, 'regulatory--no-parking--g1'); st.add(x);
  st.setRoute(makeRoute([[-150, 0], [250, 0]])); st._rebuildRouteList();
  ok(!routeIds(st).includes(x.uid), 'neskaidra zīme iekļauta maršrutā');
});

// 2. Vienvirziena iela
test('2. Vienvirziena iela: zīme kreisajā pusē attiecas uz atļauto virzienu', () => {
  roadIndex.setSegments(road(-200, 0, 300, 0, 'C', { oneway: true }), COVER);  // atļauts uz austrumiem
  const m = roadIndex.snapSign(LL(40, 6).lat, LL(40, 6).lng, null, 'regulatory--no-stopping--g1');  // ziemeļos = pa kreisi
  eq(m.dirSource, 'oneway'); eq(Math.round(m.travelDir), 90); eq(m.side, -1, 'puse');
  const st = store(); const x = sign(40, 6, 'regulatory--no-stopping--g1'); st.add(x);
  st.setRoute(makeRoute([[-150, 0], [250, 0]])); st._rebuildRouteList();
  ok(routeIds(st).includes(x.uid), 'zīme nav maršrutā uz austrumiem');
});
test('2b. Vienvirziena ielas galā "iebraukt aizliegts" attiecas uz pretējo virzienu', () => {
  const m = roadIndex.snapSign(LL(290, -6).lat, LL(290, -6).lng, null, 'regulatory--no-entry--g1');
  eq(Math.round(m.travelDir), 270);
});

// 3. Pretēji braukšanas virzieni
test('3. Pretēji virzieni: uz austrumiem rāda tikai savējo, uz rietumiem — otru', () => {
  roadIndex.setSegments(road(-200, 0, 300, 0, 'D'), COVER);
  const east = sign(50, -7, 'regulatory--maximum-speed-limit-50--g1', 270, 'speed');  // labā puse, skatās uz rietumiem
  const west = sign(60, 7, 'regulatory--maximum-speed-limit-30--g1', 90, 'speed');    // pretējā puse
  const st = store(); st.add(east); st.add(west);
  st.setRoute(makeRoute([[-150, 0], [250, 0]])); st._rebuildRouteList();
  ok(routeIds(st).includes(east.uid) && !routeIds(st).includes(west.uid), 'uz austrumiem: ' + routeIds(st));
  st.setRoute(makeRoute([[250, 0], [-150, 0]])); st._rebuildRouteList();
  ok(routeIds(st).includes(west.uid) && !routeIds(st).includes(east.uid), 'uz rietumiem: ' + routeIds(st));
  // brīvā braukšanā: pēc mana ceļa posma UN kursa
  st.setRoute(null); st.heading = 90;
  const me = LL(0, -1); st.setPosition(me.lat, me.lng, 90, 5);
  eq(st.relation(east), 'mine'); eq(st.relation(west), 'opposite');
});

// 4. Krustojums ar aizliegtu pagriezienu
test('4. Krustojums: šķērsielas zīme netiek rādīta maršrutā pa galveno ielu', () => {
  roadIndex.setSegments([...road(-200, 0, 300, 0, 'MAIN'), ...road(100, -200, 100, 200, 'CROSS')], COVER);
  const cross = sign(94, 14, 'regulatory--no-left-turn--g1', 0);   // šķērsielā, skatās uz ziemeļiem
  const mine = sign(85, -6, 'regulatory--no-left-turn--g1', 270);  // galvenajā ielā pirms krustojuma
  const st = store(); st.add(cross); st.add(mine);
  eq(roadIndex.snapSign(cross.lat, cross.lng, 0, cross.value).roadId, 'CROSS', 'šķērsielas zīmes ceļš');
  st.setRoute(makeRoute([[-150, 0], [250, 0]])); st._rebuildRouteList();
  ok(!routeIds(st).includes(cross.uid), 'šķērsielas zīme maršrutā'); ok(routeIds(st).includes(mine.uid), 'savas ielas zīme nav maršrutā');
});
test('4b. Pagrieziena aizliegums ar laiku "none @ (22:00-07:00)" → spēkā 07:00–22:00', () => {
  const c = invertCondition(parseCondition('(22:00-07:00)'));
  eq(c.ui, '07:00–22:00');
  eq(c.test(rigaDate('2026-10-12T12:00:00+03:00')), true); eq(c.test(rigaDate('2026-10-12T23:00:00+03:00')), false);
});

// 5. Stāvēt aizliegts 06:00–22:00
test('5. Stāvēt aizliegts 06:00–22:00', () => {
  const c = parseCondition('06:00-22:00');
  eq(describeRestriction('Stāvēt aizliegts', makeRestriction(c, 'osm', 'medium')), 'Stāvēt aizliegts · 06:00–22:00');
  eq(c.test(rigaDate('2026-10-12T05:59:00+03:00')), false, '05:59'); eq(c.test(rigaDate('2026-10-12T06:00:00+03:00')), true, '06:00');
  eq(c.test(rigaDate('2026-10-12T21:59:00+03:00')), true, '21:59'); eq(c.test(rigaDate('2026-10-12T22:00:00+03:00')), false, '22:00');
  const c2 = parseCondition('Mo-Fr 06:00-22:00');
  eq(describeRestriction('Stāvēt aizliegts', makeRestriction(c2, 'osm', 'medium')), 'Stāvēt aizliegts · P–Pk · 06:00–22:00');
});

// 6. Tikai noteiktās nedēļas dienās
test('6. Ierobežojums tikai darbdienās; svētku dienas', () => {
  const c = parseCondition('Mo-Fr 08:00-20:00');
  eq(c.test(rigaDate('2026-10-10T09:00:00+03:00')), false, 'sestdiena');
  eq(c.test(rigaDate('2026-10-12T09:00:00+03:00')), true, 'pirmdiena');
  const r = makeRestriction(c, 'osm', 'medium');
  eq(JSON.stringify(r.days), JSON.stringify(['Mo', 'Tu', 'We', 'Th', 'Fr'])); eq(r.timezone, 'Europe/Riga');
  const ph = parseCondition('Mo-Fr 08:00-20:00; PH off');
  eq(ph.test(rigaDate('2026-11-18T09:00:00+02:00')), false, '18. novembris (svētki)');
  eq(ph.test(rigaDate('2026-11-19T09:00:00+02:00')), true, '19. novembris');
  ok(isLvHoliday(2026, 3, 3) && isLvHoliday(2026, 3, 6), 'Lieldienas 2026');
});

// 7. Pāri pusnaktij
test('7. Ierobežojums pāri pusnaktij (22:00–07:00 un Pk 22:00–06:00)', () => {
  const c = parseCondition('22:00-07:00');
  eq(c.test(rigaDate('2026-10-12T23:30:00+03:00')), true); eq(c.test(rigaDate('2026-10-13T06:59:00+03:00')), true);
  eq(c.test(rigaDate('2026-10-13T07:00:00+03:00')), false);
  const f = parseCondition('Fr 22:00-06:00');
  eq(f.test(rigaDate('2026-10-10T03:00:00+03:00')), true, 'sestdienas rīts pieder piektdienai');
  eq(f.test(rigaDate('2026-10-11T03:00:00+03:00')), false, 'svētdienas rīts');
  eq(parseCondition('Mo-Fr 07:00-09:00, 16:00-19:00').test(rigaDate('2026-10-12T17:00:00+03:00')), true, 'vairāki intervāli');
});

// 8. Zīme bez zināma laika
test('8. Zīme bez zināma darbības laika — neizdomā, raksta "laiks nav zināms"', () => {
  const r = makeRestriction(null, 'mapillary-plate', 'low');
  eq(r.known, false); eq(describeRestriction('Apstāties aizliegts', r), 'Apstāties aizliegts · darbības laiks nav zināms');
  const u = parseCondition('wet');
  eq(u.known, false); eq(u.test(new Date()), null);
});

// 9. Neprecīzs GPS
test('9. Neprecīzs GPS: kvalitāte, ceļa noteikšana un šķērsvirziens', () => {
  eq(gpsFixQuality(8), 'good'); eq(gpsFixQuality(30), 'fair'); eq(gpsFixQuality(65), 'poor');
  roadIndex.setSegments([...road(-200, 0, 300, 0, 'A'), ...road(-200, 30, 300, 30, 'B')], COVER);
  const p = LL(50, 25);   // 25 m no A, 5 m no B
  eq(roadIndex.matchPosition(p.lat, p.lng, 90, 5).roadId, 'B');
  eq(roadIndex.matchPosition(p.lat, p.lng, 0, 5), null, 'braucot šķērsām ceļam nepiesaista');
  const far = LL(50, 60);  // 30 m no B
  eq(roadIndex.matchPosition(far.lat, far.lng, 90, 5), null, 'precīzs GPS tālu no ceļa');
  ok(roadIndex.matchPosition(far.lat, far.lng, 90, 35), 'neprecīzs GPS (±35 m) — atrod tuvāko ceļu');
  const st = store();
  eq(st.signsAheadOnRoad(p.lat, p.lng, null, 5).length, 0, 'bez kursa nevar noteikt zīmes priekšā');
});
test('9b. Zīmes priekšā uz MANA ceļa (bez maršruta)', () => {
  roadIndex.setSegments([...road(-200, 0, 300, 0, 'A'), ...road(-200, 30, 300, 30, 'B')], COVER);
  const st = store();
  const ahead = sign(120, -6, 'regulatory--maximum-speed-limit-30--g1', 270, 'speed');
  const other = sign(120, 24, 'regulatory--maximum-speed-limit-50--g1', 270, 'speed');   // ielā B
  const behind = sign(-60, -6, 'regulatory--yield--g1', 270, 'priority');
  [ahead, other, behind].forEach(x => st.add(x));
  const me = LL(0, -1);
  st.heading = 90; st.setPosition(me.lat, me.lng, 90, 8);
  const list = st.signsAheadOnRoad(me.lat, me.lng, 90, 8);
  eq(list.map(i => i.s.uid).join(), ahead.uid); ok(Math.abs(list[0].along - 120) < 3, 'attālums ' + list[0].along);
});

// 10. Dublētas vai pretrunīgas zīmes
test('10. Dublikāti un pretrunas', () => {
  const d = new SignDeduper();
  const a = LL(0, 0); d.add(a.lat, a.lng, 'other', 'regulatory--no-entry--g1', null, {});
  const b = LL(3, 0); eq(d.check(b.lat, b.lng, 'other', 'regulatory--no-entry--g1', null).status, 'duplicate', '3 m');
  const c = LL(12, 0); eq(d.check(c.lat, c.lng, 'other', 'regulatory--no-entry--g1', null).status, 'ok', '12 m — otra ceļa puse');
  const s1 = LL(100, 0); d.add(s1.lat, s1.lng, 'speed', 'regulatory--maximum-speed-limit-30--g1', 30, {});
  const s2 = LL(104, 0); eq(d.check(s2.lat, s2.lng, 'speed', 'regulatory--maximum-speed-limit-50--g1', 50).status, 'conflict');
  const o = LL(212, 0); d.add(o.lat, o.lng, 'crossing', 'information--pedestrians-crossing--g1', null, {});
  const o2 = LL(200, 0); eq(d.check(o2.lat, o2.lng, 'crossing', null, null).status, 'duplicate', 'OSM pāreja pie Mapillary pārejas');
  const list = [{ s: { value: 'x' }, along: 10 }, { s: { value: 'x' }, along: 20 }, { s: { value: 'x' }, along: 60 }];
  eq(dedupeAlong(list, 25).length, 2, 'vienādas zīmes pa ceļu');
});

// Datu modelis un imports
test('Imports: derīgas zīmes importē, nederīgas noraida ar kļūdām', () => {
  const json = { type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [24.1, 56.95] },
      properties: { id: 1, type: 'regulatory--no-parking--g1', direction: 90, opening_hours: 'Mo-Fr 06:00-22:00', verified_at: '2026-10-01' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [24.1, 56.95] }, properties: { id: 2, type: 'x', direction: 400 } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [24.1, 56.95] }, properties: { id: 3, type: 'x', opening_hours: 'kad lietus' } },
  ] };
  const r = parseVerifiedGeoJSON(json, parseCondition);
  eq(r.records.length, 1); eq(r.errors.length, 2);
  eq(r.records[0].restriction.text, 'P–Pk · 06:00–22:00'); eq(r.records[0].quality, 'verified');
});

// 11. No foto nolasītie plāksnīšu laiki
test('11. Plāksnīte "⚒ 8.00–18.00" → darba dienās 08:00–18:00; datu fails bez kļūdām', () => {
  const parsePlateTimes = G('parsePlateTimes');
  const r = parsePlateTimes({ entries: [
    { id: 'a', type: 'regulatory--no-stopping--g1', lat: 56.9076, lng: 24.0818, opening_hours: 'Mo-Fr 08:00-18:00; PH off', plate_text: '⚒ 8.00–18.00' },
    { id: 'b', type: 'regulatory--no-stopping--g1', lat: 56.9, lng: 24.1, opening_hours: 'nesalasāms' },
    { id: 'c', lat: 56.9, lng: 24.1, opening_hours: '08:00-18:00' },
  ] }, parseCondition);
  eq(r.records.length, 1); eq(r.errors.length, 2);
  const p = r.records[0];
  eq(describeRestriction('Apstāties aizliegts', p.restriction), 'Apstāties aizliegts · P–Pk · 08:00–18:00 (izņemot svētku dienas)');
  eq(p.cond.test(rigaDate('2026-10-12T09:00:00+03:00')), true, 'pirmdiena 9:00');
  eq(p.cond.test(rigaDate('2026-10-12T18:30:00+03:00')), false, 'pirmdiena 18:30');
  eq(p.cond.test(rigaDate('2026-10-10T09:00:00+03:00')), false, 'sestdiena');
  eq(p.cond.test(rigaDate('2026-11-18T09:00:00+02:00')), false, '18. novembris');
  const file = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'plate-times.json'), 'utf8'));
  const all = parsePlateTimes(file, parseCondition);
  eq(all.errors.length, 0, 'kļūdas datu failā: ' + JSON.stringify(all.errors)); ok(all.records.length > 0, 'tukšs fails');
});

// =====================================================================
// Zīmes attiecas TIKAI uz lietotāja reālo braukšanas ceļu (A–H)
const turnRule = G('turnRule');
// Maršruts ar OSRM līdzīgiem soļiem: turns: [{ at: [x,y], modifier }] (krustojumu vietas)
function makeRouteSteps(pts, turns = [], crossings = []) {
  const r = makeRoute(pts);
  const steps = [{ maneuver: { type: 'depart' }, intersections: [{ location: P(...pts[0]), bearings: [90] }] }];
  for (const c of crossings) steps[0].intersections.push({ location: P(...c), bearings: [0, 90, 180, 270] });
  for (const t of turns) steps.push({ maneuver: { type: 'turn', modifier: t.modifier }, intersections: [{ location: P(...t.at), bearings: [0, 90, 180, 270] }] });
  r.steps = steps;
  return r;
}
const appl = (st, opts) => st.getApplicableSigns(Object.assign({ statuses: ['confirmed', 'probable', 'unconfirmed', 'lane-unknown', 'contradicts-route'] }, opts));
const statusOf = (st, x, opts) => { const it = appl(st, opts).find(i => i.s === x); return it ? it.status : 'nav'; };
const drive = (st, x, y, h, acc = 5) => { const p = LL(x, y); st.heading = h; return st.setPosition(p.lat, p.lng, h, acc); };

test('A. Vienības gatve: blakus ceļa "Braukt tikai pa labi" netiek attiecināta uz manu ceļu', () => {
  // Vienības gatve (trunk) ziemeļu–dienvidu virzienā, paralēli 18 m — vietējais ceļš, šķērsiela y=100.
  roadIndex.setSegments([...road(0, -300, 0, 300, 'VIEN', { cls: 'trunk' }), ...road(18, -300, 18, 300, 'SIDE', { cls: 'service' }),
    ...road(-200, 100, 200, 100, 'CROSS')], COVER);
  const st = store();
  const sideOnly = sign(22, 60, 'regulatory--turn-right-ahead--g1', 180, 'other');   // vietējā ceļa zīme
  const trunkOnly = sign(9, 75, 'regulatory--turn-right-ahead--g1', 180, 'other');   // uz Vienības, bet joslai
  const speed = sign(9, 20, 'regulatory--maximum-speed-limit-50--g1', 180, 'speed'); // uz Vienības manā virzienā
  [sideOnly, trunkOnly, speed].forEach(x => st.add(x));
  eq(roadIndex.snapSign(sideOnly.lat, sideOnly.lng, 180, sideOnly.value).roadId, 'SIDE', 'blakus zīmes ceļš');
  const pos = drive(st, 0, -50, 0);
  eq(pos.roadId, 'VIEN', 'mans ceļš');
  eq(statusOf(st, sideOnly), 'nav', 'blakus ceļa zīme manā trajektorijā');
  eq(st.relation(sideOnly), 'other', 'blakus ceļa zīme kartē nav "mana"');
  eq(statusOf(st, trunkOnly), 'lane-unknown', 'obligātais virziens daudzjoslu ceļā bez joslu datiem');
  ok(st.relation(trunkOnly) !== 'mine', 'joslas zīme parādīta kā saistoša');
  eq(statusOf(st, speed), 'confirmed', 'ātruma zīme uz mana ceļa');
  eq(st.relation(speed), 'mine');
  const card = st.getApplicableSigns({}).map(i => i.s.uid);
  ok(card.includes(speed.uid) && !card.includes(sideOnly.uid) && !card.includes(trunkOnly.uid), 'kartīte: ' + card);
});

test('B. Paralēlas ielas: brīvā braukšanā rāda tikai manas ielas zīmes', () => {
  roadIndex.setSegments([...road(-200, 0, 300, 0, 'A'), ...road(-200, 25, 300, 25, 'B')], COVER);
  const st = store();
  const a = sign(80, -6, 'regulatory--no-stopping--g1', 270, 'other');
  const b = sign(90, 19, 'regulatory--no-parking--g1', 270, 'other');   // ielas B labā puse (6 m no B, 19 m no A)
  st.add(a); st.add(b);
  drive(st, 0, -1, 90);
  eq(statusOf(st, a), 'confirmed'); eq(statusOf(st, b), 'nav');
  eq(st.relation(a), 'mine'); eq(st.relation(b), 'other');
});

test('C. Krustojums: pagrieziena ierobežojums attiecas tikai uz savu atzaru un manevru', () => {
  roadIndex.setSegments([...road(-200, 0, 300, 0, 'MAIN'), ...road(100, -200, 100, 200, 'CROSS')], COVER);
  const st = store();
  const noLeft = sign(85, -6, 'regulatory--no-left-turn--g1', 270, 'other');            // MAIN pieeja
  const straightOrRight = sign(80, -6, 'regulatory--go-straight-or-turn-right--g1', 270, 'other');
  const crossOnly = sign(106, -20, 'regulatory--turn-right-ahead--g1', 180, 'other');   // CROSS pieeja no dienvidiem
  [noLeft, straightOrRight, crossOnly].forEach(x => st.add(x));
  st.setRoute(makeRouteSteps([[-150, 0], [250, 0]], [], [[100, 0]]));                  // taisni
  st._rebuildRouteList();
  eq(statusOf(st, noLeft), 'confirmed', 'aizliegts pa kreisi (manā pieejā)');
  eq(statusOf(st, straightOrRight), 'confirmed', 'taisni vai pa labi, braucot taisni');
  eq(statusOf(st, crossOnly), 'nav', 'šķērsielas pieejas zīme');
  st.setRoute(makeRouteSteps([[-150, 0], [100, 0], [100, 150]], [{ at: [100, 0], modifier: 'left' }]));   // pa kreisi
  st._rebuildRouteList();
  eq(statusOf(st, straightOrRight), 'contradicts-route', 'zīme neatbilst manevram — iespējams, citai joslai');
  ok(!st.routeSignsAhead(-1, 1000).some(i => i.s === straightOrRight), 'pretrunīgā zīme maršruta zīmēs');
  eq(statusOf(st, noLeft), 'confirmed', 'aizliegums jārāda arī tad, ja maršruts to pārkāpj');
});

test('D. Atdalītas brauktuves: pretējās brauktuves zīmes nesajauc', () => {
  // Ziemeļu virziena brauktuve x=0 (a→b uz ziemeļiem), dienvidu x=9 (a→b uz dienvidiem).
  roadIndex.setSegments([...road(0, -300, 0, 300, 'NB', { oneway: true, cls: 'primary' }),
    ...road(9, 300, 9, -300, 'SB', { oneway: true, cls: 'primary' })], COVER);
  const st = store();
  const nb = sign(-5, 20, 'regulatory--maximum-speed-limit-50--g1', null, 'speed');
  const sb = sign(14, 40, 'regulatory--maximum-speed-limit-70--g1', null, 'speed');
  st.add(nb); st.add(sb);
  drive(st, 0, -40, 0);
  eq(statusOf(st, nb), 'confirmed'); eq(statusOf(st, sb), 'nav');
  st.setRoute(makeRoute([[0, -200], [0, 250]])); st._rebuildRouteList();
  ok(routeIds(st).includes(nb.uid) && !routeIds(st).includes(sb.uid), 'maršrutā: ' + routeIds(st));
});

test('E. GPS kļūda: viens punkts blakus ielā ceļu nemaina, divi pēc kārtas — maina', () => {
  roadIndex.setSegments([...road(-200, 0, 300, 0, 'A'), ...road(-200, 30, 300, 30, 'B')], COVER);
  const st = store();
  const a = sign(150, -6, 'regulatory--maximum-speed-limit-30--g1', 270, 'speed');
  const b = sign(150, 24, 'regulatory--maximum-speed-limit-50--g1', 270, 'speed');
  st.add(a); st.add(b);
  eq(drive(st, 0, 0, 90).roadId, 'A');
  eq(drive(st, 15, 0, 90).roadId, 'A');
  eq(drive(st, 30, 26, 90).roadId, 'A', 'GPS lēciens uz B');
  eq(statusOf(st, a), 'confirmed'); eq(statusOf(st, b), 'nav');
  eq(drive(st, 45, 29, 90).roadId, 'B', 'otrais mērījums uz B');
  eq(drive(st, 55, 30, 90, 65).roadId, 'B', 'vājš signāls (±65 m) ceļu nemaina');
});

test('F. Nogriežoties citā ielā zīmes pārslēdzas uz jauno ielu (arī mainot maršrutu)', () => {
  roadIndex.setSegments([...road(-200, 0, 300, 0, 'MAIN'), ...road(100, -200, 100, 300, 'CROSS')], COVER);
  const st = store();
  const mainAfter = sign(180, -6, 'regulatory--maximum-speed-limit-30--g1', 270, 'speed');
  const crossAhead = sign(106, 80, 'regulatory--maximum-speed-limit-40--g1', 180, 'speed');
  st.add(mainAfter); st.add(crossAhead);
  drive(st, 40, 0, 90);
  eq(statusOf(st, mainAfter), 'probable', 'aiz krustojuma — tikai "ja brauksi taisni"'); eq(statusOf(st, crossAhead), 'nav');
  drive(st, 100, 8, 0);                                     // nogriezos pa kreisi (uz ziemeļiem)
  eq(st.pos.roadId, 'CROSS', 'uzreiz pēc pagrieziena (savienots ceļš)');
  eq(statusOf(st, crossAhead), 'confirmed'); eq(statusOf(st, mainAfter), 'nav');
  st.setRoute(makeRouteSteps([[-150, 0], [250, 0]], [], [[100, 0]])); st._rebuildRouteList();
  ok(routeIds(st).includes(mainAfter.uid) && !routeIds(st).includes(crossAhead.uid), 'maršruts taisni');
  st.setRoute(makeRouteSteps([[-150, 0], [100, 0], [100, 250]], [{ at: [100, 0], modifier: 'left' }])); st._rebuildRouteList();
  ok(!routeIds(st).includes(mainAfter.uid) && routeIds(st).includes(crossAhead.uid), 'jauns maršruts pa kreisi: ' + routeIds(st));
});

test('G. Joslu ierobežojumi: obligātā virziena zīmi bez joslu datiem nepiemēro visām joslām', () => {
  roadIndex.setSegments([...road(-200, 0, 300, 0, 'BIG', { cls: 'primary' }), ...road(100, -200, 100, 200, 'X'),
    ...road(-200, 400, 300, 400, 'SMALL'), ...road(100, 200, 100, 600, 'Y')], COVER);
  const st = store();
  const big = sign(80, -9, 'regulatory--turn-right-ahead--g1', 270, 'other');
  st.add(big);
  drive(st, 20, 0, 90);
  eq(statusOf(st, big), 'lane-unknown', 'daudzjoslu ceļš');
  ok(!st.getApplicableSigns({}).some(i => i.s === big), 'nav kartītē');
  const right = sign(80, 394, 'regulatory--turn-right-ahead--g1', 270, 'other');
  const straight = sign(70, 394, 'regulatory--go-straight--g1', 270, 'other');
  st.add(right);
  drive(st, 20, 400, 90);
  eq(statusOf(st, right), 'confirmed', 'viena josla, viena zīme');
  st.add(straight); st._freeDirty = true;
  eq(statusOf(st, right), 'lane-unknown', 'pretrunīgas obligātā virziena zīmes vienā pieejā = joslām');
  eq(statusOf(st, straight), 'lane-unknown');
  eq(turnRule('regulatory--go-straight-or-turn-left--g1').dirs.join(), 'straight,left');
});

test('H. Nepilnīgi dati: zīme ar nezināmu virzienu netiek parādīta kā apstiprināta', () => {
  roadIndex.setSegments([...road(-200, 0, 300, 0, 'A'), ...road(100, -200, 100, 200, 'X')], COVER);
  const st = store();
  const speed = sign(60, -6, 'regulatory--maximum-speed-limit-30--g1', null, 'speed');    // virziens tikai pēc puses
  const turn = sign(85, -6, 'regulatory--no-left-turn--g1', null, 'other');                // pagrieziens bez virziena
  const virtual = sign(88, -6, 'regulatory--no-right-turn--g1', 270, 'other'); virtual.source = 'osm-turn';
  [speed, turn, virtual].forEach(x => st.add(x));
  drive(st, 0, 0, 90);
  eq(statusOf(st, speed), 'probable'); eq(st.relation(speed), 'unknown', 'nav "mana" (apstiprināta)');
  eq(statusOf(st, turn), 'unconfirmed'); ok(!st.getApplicableSigns({}).some(i => i.s === turn), 'nav kartītē');
  const v = appl(st).find(i => i.s === virtual);
  ok(v && v.mapRule, 'kartes ierobežojums atzīmēts kā "nav pārbaudīta fiziska zīme"');
  // neskaidra kartes piesaiste (divi ceļi gandrīz vienādi) → apstiprinātu nav
  roadIndex.setSegments([...road(-200, 0, 300, 0, 'P1'), ...road(-200, 12, 300, 12, 'P2')], COVER);
  const st2 = store(); const s2 = sign(60, -5, 'regulatory--maximum-speed-limit-30--g1', 270, 'speed'); st2.add(s2);
  drive(st2, 0, 6, 90);
  ok(st2.pos.uncertain, 'GPS starp diviem ceļiem — neskaidrs');
  ok(statusOf(st2, s2) !== 'confirmed', 'neskaidrā situācijā nekas nav "apstiprināts"');
});

test('I. "Iebraukt aizliegts" vidū kvartālam (iebrauktuvei/sliedēm) neattiecas uz manu ceļu; krustojumā — attiecas', () => {
  roadIndex.setSegments([...road(-200, 0, 300, 0, 'A'), ...road(150, -200, 150, 200, 'X')], COVER);
  const st = store();
  const mid = sign(40, -6, 'regulatory--no-entry--g1', 270, 'other');      // 110 m līdz krustojumam
  const atJ = sign(140, -6, 'regulatory--no-entry--g1', 270, 'other');     // 10 m pirms krustojuma
  st.add(mid); st.add(atJ);
  drive(st, 0, 0, 90);
  eq(statusOf(st, mid), 'unconfirmed'); eq(statusOf(st, atJ), 'confirmed');
});

test('J. Zīme pie veloceliņa / tramvaja sliedēm netiek piesaistīta auto ceļam', () => {
  roadIndex.setSegments([...road(-200, 0, 300, 0, 'A', { cls: 'secondary' })], COVER,
    [{ a: P(-200, -8), b: P(300, -8), cls: 'path' }]);                      // veloceliņš 8 m no ass
  const bike = sign(60, -7, 'regulatory--priority-over-oncoming-vehicles--g1', 270, 'other');   // 1 m no veloceliņa
  const m1 = roadIndex.snapSign(bike.lat, bike.lng, 270, bike.value);
  eq(m1.quality, 'uncertain', 'pie veloceliņa');
  const road2 = sign(80, -5, 'regulatory--maximum-speed-limit-40--g1', 270, 'speed');           // pie brauktuves
  eq(roadIndex.snapSign(road2.lat, road2.lng, 270, road2.value).quality, 'ok', 'pie brauktuves');
  const st = store(); st.add(bike); st.add(road2);
  drive(st, 0, 0, 90);
  eq(statusOf(st, bike), 'nav'); eq(statusOf(st, road2), 'confirmed');
});

// =====================================================================
// Navigācijas līnija: nobrauktā daļa pazūd aiz bultas
test('K. Maršruta līnija: paliek tikai nenobrauktā daļa (arī līkumos), bez lēkāšanas', () => {
  const routePointAt = G('routePointAt'), routeRemaining = G('routeRemaining'), smoothProgress = G('smoothProgress');
  const R = makeRoute([[0, 0], [100, 0], [100, 100], [0, 100]]);     // 300 m ar diviem pagriezieniem
  const p = routePointAt(R, 150);
  ok(Math.abs(LL(100, 50).lat - p.lat) < 1e-6 && Math.abs(LL(100, 50).lng - p.lng) < 1e-6, 'punkts pēc 150 m');
  const rest = routeRemaining(R, 150);
  eq(rest.length, 3, 'sākas pie bultas un turpinās pa maršruta punktiem'); eq(rest[1], R.coords[2]); eq(rest[2], R.coords[3]);
  eq(routeRemaining(R, 0), R.coords, 'pirms brauciena — viss maršruts');
  eq(routeRemaining(R, 1000).length, 2, 'galamērķī — tukša līnija');
  // GPS svārstības atpakaļ līniju neatjauno; liels solis atpakaļ (pārrēķins) — jā
  eq(smoothProgress(150, 140), 150); eq(smoothProgress(150, 160), 160); eq(smoothProgress(150, 60), 60); eq(smoothProgress(null, 20), 20);
  eq(Math.round(routePointAt(R, 250).bearing), 270, 'virziens pēdējā posmā');
  // v134: driven part — from start to the arrow, ends exactly where the remaining part starts
  const routeDone = G('routeDone');
  const done = routeDone(R, 150);
  eq(done.length, 3); eq(done[0], R.coords[0]); eq(done[1], R.coords[1]); eq(JSON.stringify(done[2]), JSON.stringify(rest[0]), 'saskaras ar atlikušo daļu');
  eq(routeDone(R, 0).length, 0, 'pirms brauciena — nekā'); eq(routeDone(R, null).length, 0);
});

test('v134: nobrauktā daļa — blāva līnija; griezums seko bultai arī pie vāja GPS', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
  ok(/id: 'route-done-line'[\s\S]{0,200}'line-opacity': 0\.2\d/.test(app), 'blāva, caurspīdīga līnija');
  ok(app.indexOf("id: 'route-done-line'") < app.indexOf("id: 'route-casing'"), 'zem galvenā maršruta');
  ok(/routeDone\(route, along\)/.test(app), 'drawRoute zīmē arī nobraukto daļu');
  ok(/loc\.off <= ROUTE_CUT_M/.test(app) && /const ROUTE_CUT_M = 70;/.test(app), 'griezums arī tad, kad bulta nav piesaistīta');
  for (const f of ['index.html', 'index-gl.html']) {
    const h = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    ok(/nav\.js\?v=134/.test(h) && /app-gl\.js\?v=1[3-9]\d/.test(h), f + ': v134');
  }
});

test('T. Virzienus nosaka tikai vajadzīgajām zīmēm', () => {
  const f = G('signNeedsDirection');
  eq(f({ cat: 'speed', value: 'regulatory--maximum-speed-limit-50--g1' }), true);
  eq(f({ cat: 'camera' }), true);
  eq(f({ cat: 'rail' }), true);
  eq(f({ cat: 'signals' }), true);
  eq(f({ cat: 'warning', value: 'warning--children--g2' }), true);
  eq(f({ cat: 'info', value: 'information--parking--g1' }), false);
  eq(f({ cat: 'regulatory', value: 'regulatory--keep-right--g1' }), false);
  eq(f({ cat: 'regulatory', value: 'regulatory--no-parking--g1', timeRule: { cond: {} } }), true);
});

// Brīdinājumi
test('L. Brīdinājumi: kartē tikai noteiktās kategorijas; laikapstākļi tikai no datiem; ziņojumi noveco', () => {
  const alertTypeForSign = G('alertTypeForSign'), alertTypeForOsm = G('alertTypeForOsm'), weatherAlerts = G('weatherAlerts');
  const AlertStore = G('AlertStore'), makeReport = G('makeReport'), ALERT_TYPES = G('ALERT_TYPES');
  eq(Object.keys(ALERT_TYPES).length, 25, '25 kategorijas');
  eq(alertTypeForSign({ cat: 'camera' }), 'camera-fixed');
  eq(alertTypeForSign({ cat: 'rail' }), 'rail');
  eq(alertTypeForSign({ cat: 'signals' }), 'traffic-light');
  eq(alertTypeForSign({ cat: 'other', value: 'warning--children--g2' }), 'school');
  eq(alertTypeForSign({ cat: 'speed', value: 'regulatory--maximum-speed-limit-50--g1' }), null, 'parasta zīme nav brīdinājums');
  eq(alertTypeForSign({ cat: 'other', value: 'regulatory--no-parking--g1' }), null);
  const cond = parseCondition('Mo-Fr 07:00-19:00');
  eq(alertTypeForSign({ cat: 'other', value: 'regulatory--no-left-turn--g1', timeRule: { cond } }, rigaDate('2026-10-12T09:00:00+03:00')), 'restriction', 'ierobežojums spēkā');
  eq(alertTypeForSign({ cat: 'other', value: 'regulatory--no-left-turn--g1', timeRule: { cond } }, rigaDate('2026-10-12T21:00:00+03:00')), null, 'nav spēkā — nerāda');
  eq(alertTypeForOsm({ highway: 'construction' }), 'roadworks'); eq(alertTypeForOsm({ hazard: 'ice' }), 'ice'); eq(alertTypeForOsm({ highway: 'primary' }), null);
  eq(weatherAlerts({ weather_code: 3, visibility: 30000, temperature_2m: 9, precipitation: 0, rain: 0, showers: 0, snowfall: 0, wind_gusts_10m: 5 }).length, 0, 'labs laiks — nekā');
  const bad = weatherAlerts({ weather_code: 45, visibility: 300, temperature_2m: -1, precipitation: 0.3, rain: 0, showers: 0, snowfall: 0.2, wind_gusts_10m: 22 }).map(w => w.type).sort().join();
  eq(bad, 'fog,ice,snow,weather');
  const saved = []; const st = new AlertStore({ load: () => [], save: l => saved.push(l.length) });
  const t0 = Date.parse('2026-10-13T10:00:00Z');
  const r = st.add(makeReport('police', 56.95, 24.1, 90, t0));
  eq(st.list(t0 + 30 * 60000).length, 1, 'pēc 30 min vēl redzams');
  eq(st.list(t0 + 61 * 60000).length, 0, 'pēc 61 min vairs nav');
  ok(st.prune(t0 + 61 * 60000) && !st.items.has(r.id), 'novecojis izdzēsts');
  let threw = false; try { makeReport('rail', 0, 0, null); } catch { threw = true; }
  ok(threw, 'nevar "ziņot" par pastāvīgu objektu');
});

test('M. Ziņojumu grupas (satiksme / bīstamība) kopā aptver visus ziņojamos veidus, bez dublikātiem', () => {
  const ALERT_TYPES = G('ALERT_TYPES'), RG = G('REPORT_GROUPS');
  const all = [...RG.traffic, ...RG.hazard];
  eq(new Set(all).size, all.length, 'bez dublikātiem');
  for (const t of all) ok(ALERT_TYPES[t] && ALERT_TYPES[t].report, t + ' ir ziņojams');
  const reportable = Object.keys(ALERT_TYPES).filter(t => ALERT_TYPES[t].report).sort().join();
  eq([...all].sort().join(), reportable, 'visi ziņojamie veidi ir kādā pogā');
});

test('N. Vietas tuvumā: 13 kategorijas, pareizs Overpass vaicājums, tuvākās pirmās, darba laiks', () => {
  const CATS = G('PLACE_CATEGORIES'), q = G('buildPlacesQuery'), parse = G('parsePlaces'), pc = G('parseCondition');
  eq(CATS.length, 13, '13 kategorijas (ar auto mazgātavām)');
  const qq = q('fuel', 56.95, 24.1, 3000);
  ok(qq.includes('nwr["amenity"="fuel"](around:3000,56.95000,24.10000);') && qq.includes('out center'), 'degvielas vaicājums');
  ok(q('crisis', 56.95, 24.1, 3000).split('around:').length === 4, 'ārkārtas palīdzība — 3 vaicājumi');
  const now = new Date('2026-10-14T10:00:00Z'); // trešdiena 13:00 Rīgā
  const els = [
    { type: 'node', id: 1, lat: 56.96, lon: 24.1, tags: { amenity: 'fuel', name: 'Tālā', opening_hours: '24/7' } },
    { type: 'way', id: 2, center: { lat: 56.951, lon: 24.1 }, tags: { amenity: 'fuel', brand: 'Circle K', 'addr:street': 'Brīvības iela', 'addr:housenumber': '1', opening_hours: 'Mo-Fr 06:00-08:00' } },
    { type: 'node', id: 3, lat: 56.9511, lon: 24.1001, tags: { amenity: 'fuel', brand: 'Circle K' } },
    { type: 'node', id: 4, tags: { amenity: 'fuel' } },
  ];
  const r = parse(els, 'fuel', 56.95, 24.1, now, pc);
  eq(r.length, 2, 'bez koordinātēm un dublikātiem');
  eq(r[0].name, 'Degviela · Circle K', 'bez name — kategorija · zīmols (F24)'); eq(r[0].addr, 'Brīvības iela 1'); eq(r[0].open, false, 'slēgts 13:00');
  eq(r[1].name, 'Tālā'); eq(r[1].open, true, '24/7 atvērts');
  ok(r[0].d < r[1].d, 'tuvākā pirmā');
});

test('O. Vietas ātri (Photon) + darba laiks fonā pēc OSM id; privātās stāvvietas izmestas', () => {
  const url = G('buildPhotonPlacesUrl'), pp = G('parsePhotonPlaces'), dq = G('buildPlaceDetailsQuery'), merge = G('mergePlaceDetails'), pc = G('parseCondition');
  const u = url('food', 56.95, 24.1, 5, 25);
  ok(u.startsWith('https://photon.komoot.io/reverse?lat=56.95000&lon=24.10000&radius=5&limit=25'), 'Photon adrese');
  ok(u.includes('osm_tag=amenity%3Arestaurant') && u.includes('osm_tag=amenity%3Afast_food'), 'vairākas birkas');
  const feats = [
    { geometry: { coordinates: [24.1, 56.97] }, properties: { osm_type: 'N', osm_id: 1, name: 'Tālā' } },
    { geometry: { coordinates: [24.1, 56.951] }, properties: { osm_type: 'W', osm_id: 2, street: 'Brīvības iela', housenumber: '5' } },
    { geometry: { coordinates: [24.1, 56.9512] }, properties: { osm_type: 'N', osm_id: 3, name: 'Privātā' } },
  ];
  const r = pp(feats, 'parking', 56.95, 24.1);
  eq(r.map(p => p.id).join(), 'way2,node3,node1', 'tuvākā pirmā');
  eq(r[0].name, 'Stāvvieta'); eq(r[0].addr, 'Brīvības iela 5');
  const q = dq(r);
  ok(q.includes('node(id:3,1);') && q.includes('way(id:2);') && q.includes('out tags'), 'vaicājums pēc id');
  const m = merge(r, [{ type: 'way', id: 2, tags: { name: 'Centrs', fee: 'yes', capacity: '40', opening_hours: '24/7' } }, { type: 'node', id: 3, tags: { access: 'private' } }], new Date(), pc);
  eq(m.length, 2, 'privātā izmesta');
  eq(m[0].name, 'Centrs'); eq(m[0].open, true); eq(m[0].extra.join(), 'maksas,40 vietas');
});

test('P. Kešatmiņa: atkārtots pieprasījums netiek sūtīts; vienlaicīgi apvienoti; noveco', async () => {
  const cachedJson = G('cachedJson'), cacheGet = G('cacheGet'), onceInflight = G('onceInflight');
  let calls = 0;
  const loader = () => new Promise(r => setTimeout(() => r({ n: ++calls }), 5));
  const [a, b] = await Promise.all([cachedJson('t', 'k', 60000, loader), cachedJson('t', 'k', 60000, loader)]);
  eq(calls, 1, 'vienlaicīgie apvienoti'); eq(a.n, 1); eq(b.n, 1);
  const c = await cachedJson('t', 'k', 60000, loader);
  eq(calls, 1, 'otrreiz no kešatmiņas'); eq(c.n, 1);
  eq(await cacheGet('t', 'k', 0), null, 'novecojis netiek izmantots');
  eq(await cacheGet('t', 'cits', 60000), null);
  let x = 0; await Promise.all([onceInflight('z', async () => ++x), onceInflight('z', async () => ++x)]); eq(x, 1);
});

test('Q. Vietas uzreiz no kartes flīzēm (bez interneta): kategorija, attālums, bez dublikātiem', () => {
  const tp = G('parseTilePlaces'), rs = G('resortPlaces');
  const F = (sub, name, lng, lat) => ({ properties: { class: 'x', subclass: sub, name }, geometry: { type: 'Point', coordinates: [lng, lat] } });
  const feats = [F('fuel', 'Neste', 24.1, 56.96), F('fuel', 'Circle K', 24.1, 56.951), F('fuel', 'Circle K', 24.1001, 56.9511),
    F('restaurant', 'Lido', 24.1, 56.9505), F('charging_station', null, 24.1, 56.9502)];
  const r = tp(feats, 'fuel', 56.95, 24.1);
  eq(r.map(p => p.name).join(), 'Circle K,Neste', 'tikai degviela, tuvākā pirmā, dublikāts izmests');
  eq(tp(feats, 'ev', 56.95, 24.1)[0].name, 'Elektroauto uzlāde', 'bez nosaukuma — kategorijas nosaukums');
  eq(rs(r, 56.97, 24.1)[0].name, 'Neste', 'pārkārtots pēc jaunās vietas');
  const cw = tp([F('car_wash', null, 24.1, 56.9503)], 'carwash', 56.95, 24.1);
  eq(cw.length === 1 && cw[0].name, 'Auto mazgātava', 'auto mazgātava no kartes flīzēm (F24 — vienskaitlī)');
  eq(G('carWashInfo')({ self_service: 'yes', automated: 'yes' }).join(), 'pašapkalpošanās,automātiskā');
  eq(G('buildPlacesQuery')('carwash', 56.95, 24.1, 1500).includes('"amenity"="car_wash"'), true, 'Overpass vaicājums');
});

test('R. Darba laika punkts: zaļš / oranžs / dzeltens / sarkans / pelēks ar laiku', () => {
  const st = G('placeStatus'), pc = G('parseCondition');
  const wed22 = new Date('2026-10-14T19:00:00Z');   // trešdiena 22:00 Rīgā
  const S = (oh, now = wed22) => { const r = st(oh, now, pc); return r.state + ' | ' + r.text; };
  eq(S('Mo-Su 08:00-23:00'), 'open | atvērts līdz 23:00');
  eq(S('Mo-Su 08:00-22:30'), 'closing | aizveras pēc 30 min');
  eq(S('Mo-Su 22:45-23:59'), 'opening | atveras pēc 45 min');
  eq(S('Mo-Fr 08:00-18:00'), 'closed | slēgts · atveras rīt 08:00');
  eq(S('Mo-Fr 08:00-18:00', new Date('2026-10-16T19:00:00Z')), 'closed | slēgts · atveras pirmdien 08:00', 'piektdienas vakars');
  eq(S('Mo-Su 20:00-02:00'), 'open | atvērts līdz rīt 02:00', 'pāri pusnaktij');
  eq(S('24/7'), 'open | atvērts visu diennakti');
  eq(S(''), 'unknown | ');
  eq(S('pēc vienošanās'), 'unknown | ');
});

test('X. Kopbraucieni: saskaņošana ar maršrutu, pārbaudes, demo krātuve', async () => {
  const match = G('rideMatchRoute'), list = G('rideListForDriver'), val = G('rideValidate'), pv = G('rideProfileValid'), tt = G('rideTimeText');
  // Taisns maršruts uz austrumiem: 0..~6,1 km (24.10 → 24.20, 56.95)
  const coords = []; for (let i = 0; i <= 10; i++) coords.push([24.10 + i * 0.01, 56.95]);
  const cum = [0]; for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + G('rideDist')(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
  const route = { coords, cum };
  const now = Date.parse('2026-10-16T12:00:00Z');
  const req = (o = {}) => ({ id: 'r', user_id: 'p', status: 'open', depart_at: new Date(now + 600000).toISOString(),
    from_lat: 56.951, from_lng: 24.12, to_lat: 56.949, to_lng: 24.17, seats: 1, ...o });
  const m = match(req(), route, 0);
  ok(m && m.pick < m.drop, 'pa ceļam'); ok(m.detourMin >= 1 && m.detourMin <= 3, 'neliels apkārtceļš ' + m.detourMin);
  eq(match(req({ from_lng: 24.17, to_lng: 24.12 }), route, 0), null, 'pretējā virzienā — neder');
  eq(match(req({ from_lat: 56.97 }), route, 0), null, 'sākums par tālu no maršruta (~2 km)');
  eq(match(req(), route, 2500), null, 'jau pabraukts garām');
  const L = list([req({ id: 'a', from_lng: 24.15, to_lng: 24.19 }), req({ id: 'b' }), req({ id: 'c', status: 'matched' }),
    req({ id: 'd', depart_at: new Date(now - 3600000).toISOString() }), req({ id: 'e', user_id: 'me' })], { route, along: 0, myId: 'me', now });
  eq(L.map(x => x.req.id).join(','), 'b,a', 'pēc kārtas pa ceļam; bez saskaņotiem, novecojušiem un saviem');
  const N = list([req({ id: 'near' }), req({ id: 'far', from_lat: 57.2 })], { me: { lat: 56.95, lng: 24.11 }, now });
  eq(N.map(x => x.req.id).join(','), 'near', 'bez maršruta — tuvumā');
  eq(val(req(), now), null);
  ok(/pārāk tuvu/.test(val(req({ to_lat: 56.951, to_lng: 24.1205 }), now)));
  ok(/pagājis/.test(val(req({ depart_at: new Date(now - 3600000).toISOString() }), now)));
  ok(/1 līdz 4/.test(val(req({ seats: 7 }), now)));
  ok(/uz kurieni/.test(val(req({ to_lat: undefined }), now)));
  eq(pv({ name: 'Ilze', phone: '+371 2612 3456' }), null); ok(/vārdu/.test(pv({ name: ' ' }))); ok(/nepareizs/.test(pv({ name: 'Ilze', phone: '12ab' })));
  eq(tt(new Date(now + 60000).toISOString(), now), 'tagad'); eq(tt(new Date(now + 20 * 60000).toISOString(), now), 'pēc 20 min');
  // Demo krātuve: pasažieris → šoferis piedāvā → pasažieris pieņem → abi redz tālruni
  const mem = { d: {}, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = v; } };
  const S = G('LocalRideStore');
  const pas = new S(mem, 'k');
  await pas.saveProfile({ name: 'Anna', phone: '+37120000001' });
  const r = await pas.createRequest({ from_lat: 56.95, from_lng: 24.1, from_name: 'A', to_lat: 56.96, to_lng: 24.2, to_name: 'B', depart_at: new Date().toISOString(), seats: 1, note: '' });
  const drvMem = { d: { k: mem.d.k }, getItem(k) { return mem.d[k] ?? null; }, setItem(k, v) { mem.d[k] = v; } };
  const drv = new S(drvMem, 'k'); drv.id = 'driver-1';
  await drv.saveProfile({ name: 'Jānis', phone: '+37120000002', car: 'Zils VW Golf' });
  eq((await drv.openRequests()).length, 1);
  await drv.offer(r.id, { eta_min: 5 }); await drv.offer(r.id, { eta_min: 5 });
  const offs = await pas.offersFor(r.id);
  eq(offs.length, 1, 'viens piedāvājums (dublikāts nav)'); eq(offs[0].phone, '', 'tālrunis vēl slēpts'); eq(offs[0].driver.car, 'Zils VW Golf');
  await pas.respond(offs[0].id, 'accepted');
  eq((await pas.offersFor(r.id))[0].phone, '+37120000002', 'pēc pieņemšanas pasažieris redz šofera tālruni');
  const mine = await drv.myOffers();
  eq(mine[0].status, 'accepted'); eq(mine[0].phone, '+37120000001', 'šoferis redz pasažiera tālruni');
  eq((await drv.openRequests()).length, 0, 'saskaņots vairs nav atvērto sarakstā');
  await drv.cancelOffer(mine[0].id);
  eq((await drv.openRequests()).length, 1, 'šoferis atcēla — pieprasījums atkal atvērts');
});

test('Y. Kopbraucieni: brauciena gaita, statusi, čats', async () => {
  const stage = G('rideStage'), ps = G('ridePassengerStatus'), ds = G('rideDriverStatus'), un = G('rideUnread');
  const now = Date.parse('2026-10-16T12:00:00Z'), fresh = new Date(now - 10000).toISOString(), old = new Date(now - 600000).toISOString();
  const req = { from_lat: 56.95, from_lng: 24.10, to_lat: 56.96, to_lng: 24.20, from_name: 'A', to_name: 'B' };
  eq(stage({ status: 'pending' }), 'pending'); eq(stage({ status: 'accepted', trip: '' }), 'matched'); eq(stage({ status: 'accepted', trip: 'onboard' }), 'onboard');
  ok(/drīz/.test(ps({ status: 'accepted', trip: '' }, req, now)));
  const s = ps({ status: 'accepted', trip: 'coming', drv_lat: 56.95, drv_lng: 24.12, drv_at: fresh }, req, now);
  ok(/brauc pie tevis · 1,2 km · ~\d+ min/.test(s), s);
  eq(ps({ status: 'accepted', trip: 'coming', drv_lat: 56.95, drv_lng: 24.12, drv_at: old }, req, now), 'Šoferis brauc pie tevis.', 'veca vieta — bez attāluma');
  ok(/klāt/.test(ps({ status: 'accepted', trip: 'arrived' }, req, now)));
  ok(/Līdz pasažierim/.test(ds({ status: 'accepted', trip: 'coming', request: req }, { lat: 56.95, lng: 24.11 }, now)));
  ok(/pēc adreses/.test(ds({ status: 'accepted', trip: 'coming', request: req, pas_lat: 1, pas_lng: 1, pas_at: old }, { lat: 56.95, lng: 24.11 }, now)));
  eq(un([{ id: 1, sender: 'me' }, { id: 2, sender: 'x' }, { id: 3, sender: 'x' }], 'me', 2), 1);
  // Demo krātuve: čats un gaita
  const mem = { d: {}, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = v; } };
  const S = G('LocalRideStore');
  const pas = new S(mem, 'k'); await pas.saveProfile({ name: 'Anna' });
  const r = await pas.createRequest({ ...req, depart_at: new Date().toISOString(), seats: 1, note: '' });
  const drv = new S(mem, 'k'); drv.id = 'drv'; await drv.saveProfile({ name: 'Jānis' });
  await drv.offer(r.id, { eta_min: 3 });
  const o = (await pas.offersFor(r.id))[0];
  await pas.send(o.id, 'Sveiki!'); await drv.send(o.id, 'Būšu pēc 5 min');
  eq((await drv.messages(o.id)).map(m => m.body).join('|'), 'Sveiki!|Būšu pēc 5 min');
  eq((await drv.messages(o.id, 1)).length, 1, 'tikai jaunākās');
  await drv.driverUpdate(o.id, { trip: 'coming', lat: 1, lng: 2 });
  ok(!(await pas.offersFor(r.id))[0].trip, 'kamēr nav pieņemts — gaita nemainās');
  await pas.respond(o.id, 'accepted');
  await drv.driverUpdate(o.id, { trip: 'coming', lat: 56.951, lng: 24.11 });
  const o2 = (await pas.offersFor(r.id))[0];
  eq(o2.trip, 'coming'); ok(o2.drv_at);
  await drv.driverUpdate(o.id, { trip: 'onboard' }); await drv.driverUpdate(o.id, { trip: 'done' });   // A03: pabeigt tikai pēc iekāpšanas
  eq((await pas.myRequests()).length, 0, 'pabeigts brauciens vairs nav aktīvo sarakstā');
});

test('R. Vietu kontakti: droši tālruņi, tikai https mājaslapas, pārbaudītas lietotnes', () => {
  const P = require('../places.js');
  eq(P.placePhone('26 123 456').tel, 'tel:+37126123456');
  eq(P.placePhone('+371 6700-0000; 29999999').label, '+371 6700 0000');
  eq(P.placePhone('0037120000000').tel, 'tel:+37120000000');
  ok(!P.placePhone('zvaniet*123#'));
  eq(P.placeWebsite('http://www.Neste.lv/lv').url, 'https://www.neste.lv/lv', 'http → https');
  eq(P.placeWebsite('circlek.lv').host, 'circlek.lv');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc', 'ftp://x.lv', 'https://u:p@x.lv', 'https://1.2.3.4/', 'https://x.lv:8080/', 'https://x.lv/"><b>', 'nav'])
    ok(!P.placeWebsite(bad), 'bloķē ' + bad);
  const els = [{ type: 'node', id: 1, lat: 56.95, lon: 24.1, tags: { amenity: 'fuel', brand: 'Neste', name: 'Neste Brīvības', phone: '+371 67 000 000', website: 'https://www.neste.lv/' } },
               { type: 'node', id: 2, lat: 56.951, lon: 24.1, tags: { amenity: 'fuel', name: 'Mazā DUS' } }];
  const ps = P.parsePlaces(els, 'fuel', 56.95, 24.1);
  eq(ps[0].ct, null, 'v133: degvielai ne tālruņa, ne saites');
  eq(ps[1].ct, null, 'nav kontaktu → nav pogu');
  const lidl = P.placeContacts({}, 'Lidl');
  ok(lidl.brandWeb && lidl.web.host === 'lidl.lv' && lidl.app === null, 'meklēšanā: zīmola vietne, bez lietotnes');
  // v133: owner's per-category table
  const tags = { phone: '+371 67 000 000', website: 'https://x.lv/' };
  const want = { fuel: '--', parking: '-w', ev: 'pw', food: 'pw', coffee: '--', grocery: '--', carwash: 'pw', pharmacy: 'pw',
    medical: 'pw', crisis: 'p-', hotel: 'pw', shopping: '--', park: '--' };
  for (const [cat, w] of Object.entries(want)) {
    const ct = P.placeContacts(tags, 'Vieta', cat);
    const got = (ct && ct.phone ? 'p' : '-') + (ct && ct.web ? 'w' : '-');
    eq(got, w, cat + ' kontakti');
    ok(!ct || ct.app === null, cat + ': bez lietotnes');
  }
  eq(Object.keys(P.PLACE_CONTACT_RULES).length, 13, 'visām 13 kategorijām ir noteikums');
  ok(P.placeContacts({ phone: '20000000' }, 'Elektrum', 'ev').app === null, 'EV — bez lietotnes');
  for (const b of P.PLACE_BRANDS) { ok(P.placeWebsite(b[2]), b[1] + ' vietne'); for (const v of Object.values(b[3])) ok(/^[\w.]+$/.test(v), b[1] + ' id'); }
  const m = P.mergePlaceDetails([{ id: 'node5', cat: 'coffee', name: 'Kafija', extra: [] }], [{ type: 'node', id: 5, tags: { 'contact:website': 'kafija.lv', 'contact:phone': '20000000' } }]);
  eq(m[0].ct, null, 'v133: kafijai kontaktus nerāda');
  const m2 = P.mergePlaceDetails([{ id: 'node6', cat: 'food', name: 'Ēstuve', extra: [] }], [{ type: 'node', id: 6, tags: { 'contact:website': 'estuve.lv', 'contact:phone': '20000000' } }]);
  eq(m2[0].ct.web.url, 'https://estuve.lv/'); eq(m2[0].ct.phone.label, '+371 2000 0000');
});

test('S. Vai drīkstu stāvēt: zīmes, laiki, noteikumi, OSM, atgādinājums', () => {
  const P = require('../parking.js'), T = require('../times.js');
  const base = { roadKnown: true, dirKnown: true, mly: true, osmOk: true, acc: 6 };
  const mon = h => new Date(`2026-10-19T${h}:00+03:00`);            // pirmdiena
  const c = T.parseCondition('Mo-Fr 07:00-19:00');
  // Zīmju veidi (Mapillary kodi, kas Rīgā tiešām sastopami)
  eq(P.parkSignKind('regulatory--no-stopping--g1'), 'no-stopping');
  eq(P.parkSignKind('regulatory--no-parking--g1'), 'no-parking');
  eq(P.parkSignKind('regulatory--no-parking-or-no-stopping--g1'), 'no-parking');
  eq(P.parkSignKind('regulatory--no-parking-bicycles-or-motorcycles--g1'), null, 'mopēdu zīme neattiecas uz auto');
  eq(P.parkSignKind('regulatory--end-of-prohibition--g1'), 'end');
  eq(P.parkSignKind('information--parking--g5'), 'parking');
  eq(P.parkSignKind('complementary--tow-away-zone--g1'), 'tow');
  // Laika aizliegums spēkā → sarkans, "drīkstēs no 19:00"
  let v = P.parkVerdict(Object.assign({ signs: [{ kind: 'no-parking', at: -30, cond: c, sure: true }] }, base), mon('12:00'));
  eq(v.state, 'no'); eq(v.headline, 'Nedrīksti stāvēt'); ok(/no 19:00/.test(v.sub), v.sub);
  // Pēc 19:00 → zaļš līdz rītdienas 07:00 + atgādinājums 15 min pirms
  v = P.parkVerdict(Object.assign({ signs: [{ kind: 'no-parking', at: -30, cond: c, sure: true }] }, base), mon('20:00'));
  eq(v.state, 'ok'); ok(/līdz rīt 07:00/.test(v.sub), v.sub);
  eq(v.remindAt.toISOString(), '2026-10-20T03:45:00.000Z');
  // Piektdienas vakarā — līdz pirmdienai
  v = P.parkVerdict(Object.assign({ signs: [{ kind: 'no-parking', at: -30, cond: c, sure: true }] }, base), new Date('2026-10-23T20:00:00+03:00'));
  ok(/pirmdien 07:00/.test(v.sub), v.sub);
  // Pastāvīgs "Apstāties aizliegts" → bez "drīkstēs no"
  v = P.parkVerdict(Object.assign({ signs: [{ kind: 'no-stopping', at: -12, sure: true }] }, base), mon('12:00'));
  eq(v.headline, 'Apstāties aizliegts'); ok(!v.from);
  // Beigu zīme starp aizliegumu un mašīnu atceļ aizliegumu
  v = P.parkVerdict(Object.assign({ signs: [{ kind: 'no-stopping', at: -60, sure: true }, { kind: 'end', at: -8 }] }, base), mon('12:00'));
  eq(v.state, 'ok');
  // Zīme priekšā (zona sākas pie zīmes) — tikai brīdinājums, ja tuvu
  v = P.parkVerdict(Object.assign({ signs: [{ kind: 'no-stopping', at: 5, sure: true }] }, base), mon('12:00'));
  eq(v.state, 'warn'); ok(v.reasons.some(r => /PIRMS/.test(r.text)));
  v = P.parkVerdict(Object.assign({ signs: [{ kind: 'no-stopping', at: 80, sure: true }] }, base), mon('12:00'));
  eq(v.state, 'ok', 'tāla zīme priekšā neietekmē');
  // Plāksnīte ir, laiks nav nolasīts — neizdomā, brīdina
  v = P.parkVerdict(Object.assign({ signs: [{ kind: 'no-parking', at: -20, timeUnknown: true, sure: true }] }, base), mon('12:00'));
  eq(v.state, 'warn'); eq(v.confidence, 'medium');
  // Nedroša piederība ielas pusei → brīdinājums, ne sarkans
  v = P.parkVerdict(Object.assign({ signs: [{ kind: 'no-parking', at: -20, sure: false }] }, base), mon('12:00'));
  eq(v.state, 'warn');
  // CSN attālumi: pāreja 4 m priekšā, pietura 10 m priekšā, krustojums
  v = P.parkVerdict(Object.assign({ signs: [], near: { crossingAt: 4 } }, base, { acc: 4 }), mon('12:00'));
  eq(v.state, 'no'); ok(v.reasons.some(r => /121\.5/.test(r.text)));
  v = P.parkVerdict(Object.assign({ signs: [], near: { stopAhead: 12 } }, base, { acc: 4 }), mon('12:00'));
  eq(v.state, 'no'); ok(/25 m/.test(v.reasons[0].text));
  v = P.parkVerdict(Object.assign({ signs: [], near: { junctionAhead: 14 } }, base, { acc: 10 }), mon('12:00'));
  eq(v.state, 'warn', 'krustojums tuvu, bet GPS ±10 m — brīdina');
  v = P.parkVerdict(Object.assign({ signs: [], near: { junctionAhead: 60, stopBehind: 40 } }, base), mon('12:00'));
  eq(v.state, 'ok');
  // Nav ceļa datu → "nevar pārbaudīt", nevis "drīkst"
  v = P.parkVerdict({ roadKnown: false, signs: [] }, mon('12:00'));
  eq(v.state, 'unknown');
  // OSM: ielas puses atzīmes (jaunā un vecā shēma), maksa, maksimālais laiks
  const o = P.parkOsmSide({ 'parking:right:restriction:conditional': 'no_stopping @ (Mo-Fr 07:00-10:00)', 'parking:both:fee': 'yes', 'parking:both:maxstay': '2 hours' }, 'right');
  ok(o.restrict.test(mon('08:00')) && !o.restrict.test(mon('12:00'))); eq(o.maxstay, 7200000);
  eq(P.parkOsmSide({ 'parking:right:restriction:conditional': 'no_stopping @ (Mo-Fr 07:00-10:00)' }, 'left'), null, 'otrā pusē nav');
  eq(P.parkOsmSide({ 'parking:condition:both': 'no_parking' }, 'left').restrict.kind, 'no-parking');
  v = P.parkVerdict(Object.assign({ signs: [], osm: o }, base), mon('12:00'));
  eq(v.headline, 'Drīkst, bet par maksu'); ok(/vēl 2 h/.test(v.sub), v.sub);
  v = P.parkVerdict(Object.assign({ signs: [], osm: o }, base), mon('08:00'));
  eq(v.headline, 'Apstāties aizliegts'); ok(/10:00/.test(v.sub), v.sub);
  // Stāvlaukums: privāts / ar darba laiku
  eq(P.parkVerdict({ roadKnown: false, area: { access: 'private' }, signs: [], osmOk: true, mly: true, dirKnown: true }, mon('12:00')).state, 'no');
  v = P.parkVerdict({ roadKnown: true, area: { name: 'Origo', fee: 'yes', oh: 'Mo-Su 06:00-23:00' }, signs: [{ kind: 'no-stopping', at: -5, sure: true }], osmOk: true, mly: true }, mon('12:00'));
  eq(v.state, 'warn', 'stāvlaukumā ielas zīmes neattiecas'); ok(/23:00/.test(v.sub), v.sub);
  // Kalendāra fails
  const ics = P.parkIcs({ start: new Date('2026-10-20T03:45:00Z'), end: new Date('2026-10-20T04:00:00Z'), title: 'Pārliec mašīnu', text: 'a, b; c', lat: 56.95, lng: 24.1 });
  ok(/DTSTART:20261020T034500Z/.test(ics) && /BEGIN:VALARM/.test(ics) && ics.includes('a\\, b\\; c') && /\r\n$/.test(ics));
  eq(P.pkMaxstay('90 min'), 5400000); eq(P.pkMaxstay('1:30'), 5400000); eq(P.pkMaxstay('kaut kas'), null);
});

test('T. Stāvēšana kartē: ielas puse, virziens, krustojums', () => {
  for (const f of ['parking.js', 'park-gl.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
      .replace(/if \(typeof module[\s\S]*?\n}\n?$/m, '').replace(/\(function parkWait\(\)[\s\S]*$/, '');
    vm.runInContext(src, ctx, { filename: f });
  }
  vm.runInContext('var distM = (a, b, c, d) => Math.hypot((c - a) * 111320, (d - b) * 111320 * Math.cos(a * Math.PI / 180)); var state = {}; var signs = null;', ctx);
  // Divvirzienu iela austrumi–rietumi (y=0), šķērsielas pie x=0 un x=200
  roadIndex.setSegments([...road(-300, 0, 300, 0, 'A'), ...road(0, -100, 0, 100, 'B'), ...road(200, -100, 200, 100, 'C')], COVER);
  const st = store();
  st.add(sign(60, -6, 'regulatory--no-stopping--g1', 270));    // dienvidu pusē, austrumu virzienam
  st.add(sign(60, 6, 'regulatory--no-parking--g1', 90));       // ziemeļu pusē, rietumu virzienam
  st.add(sign(-20, -6, 'regulatory--no-stopping--g1', 270));   // aiz krustojuma — neattiecas
  ctx.signs = st;
  const ctxAt = (x, y, dir) => { const q = LL(x, y); return G('parkContext')(q.lat, q.lng, dir, { elements: [] }, 6, true); };
  const V = c => G('parkVerdict')(c, new Date('2026-10-19T12:00:00+03:00'));
  let c = ctxAt(100, -4, 90);
  eq(c.side, 1); eq(Math.round(c.dir), 90);
  eq(c.signs.filter(x => x.kind === 'no-stopping').map(x => Math.round(x.at)).join(), '-40', 'tikai savā pusē un līdz krustojumam');
  eq(V(c).state, 'no');
  c = ctxAt(100, -4, null);                       // bez kursa — pēc ielas puses
  eq(Math.round(c.dir), 90); eq(V(c).state, 'no');
  c = ctxAt(100, 4, null);                        // ziemeļu pusē → brauc uz rietumiem; zīme x=60 ir priekšā
  eq(Math.round(c.dir), 270); eq(V(c).state, 'ok');
  c = ctxAt(40, -4, 90);                          // pirms zīmes
  eq(V(c).state, 'ok');
  eq(V(ctxAt(190, -4, 90)).state, 'no', 'zona no zīmes līdz krustojumam (130 m)');
  c = ctxAt(190, 4, null);                        // ziemeļu pusē, 10 m aiz krustojuma
  ok(Math.round(c.near.junctionBehind) === 10, String(c.near.junctionBehind));
  eq(V(c).state, 'warn');
  roadIndex.setSegments([], COVER);
});

test('U. Sagatavotie OSM dati: šūnas, stāvlaukums, pārejas', async () => {
  const { buildCells } = await import('../tools/build-osm.mjs');
  const json = { elements: [
    { type: 'node', lat: 56.95601, lon: 24.10001, tags: { highway: 'crossing' } },
    { type: 'node', lat: 56.97, lon: 24.30, tags: { highway: 'bus_stop' } },
    { type: 'way', tags: { highway: 'residential', name: 'Iela', 'parking:right:restriction': 'no_parking', surface: 'x' },
      geometry: [{ lat: 56.9499, lon: 24.0999 }, { lat: 56.9501, lon: 24.1001 }] },
    { type: 'way', tags: { amenity: 'parking', fee: 'yes', name: 'P1', surface: 'x' },
      geometry: [{ lat: 56.9550, lon: 24.0990 }, { lat: 56.9550, lon: 24.1010 }, { lat: 56.9570, lon: 24.1010 }, { lat: 56.9570, lon: 24.0990 }, { lat: 56.9550, lon: 24.0990 }] },
  ] };
  const { cells, count } = buildCells(json);
  eq(count.x, 1); eq(count.p, 1); eq(count.w, 1);
  eq(cells.size, 5, 'iela šķērso 4 šūnas + pietura citur');
  ok(!('surface' in cells.get('1138_481').w[0][0]), 'liekie tagi izmesti');
  // Lietotnes puse: šūnas no "servera" (bez Overpass)
  const files = { 'data/osm/index.json': { v: 1, cell: 0.05, osm: '2026-10-19T18:00:00Z', cells: [...cells.keys()] } };
  for (const [k, v] of cells) files['data/osm/c_' + k + '.json'] = v;
  ctx.fetch = async u => { const f = files[String(u).split('?')[0]]; return { ok: !!f, json: async () => JSON.parse(JSON.stringify(f)) }; };
  vm.runInContext('parkDataIndex = undefined; parkCellCache.clear(); parkOsmCache.clear();', ctx);
  const v = await G('parkLoadOsm')(56.956, 24.100);
  ok(v.local); eq(v.osm, '2026-10-19T18:00:00Z');
  ok(v.elements.some(e => e.type === 'node' && e.tags.highway === 'crossing'));
  ok(v.elements.some(e => e.type === 'way' && e.tags.amenity === 'parking' && !e.geometry && e.tags.fee === 'yes'), 'punkts stāvlaukumā');
  ok(!v.elements.some(e => e.tags.highway === 'bus_stop'), 'tālā pietura nav ielādēta');
  const v2 = await G('parkLoadOsm')(56.9500, 24.1000);
  ok(v2.elements.some(e => e.type === 'way' && e.tags['parking:right:restriction'] === 'no_parking'));
  eq(v2.elements.filter(e => e.type === 'way' && e.tags.highway).length, 1, 'iela no vairākām šūnām — vienreiz');
});

test('V. Sastrēgumi: anonīmi mērījumi, privātuma zonas, līmeņi, maršruta kavējums', () => {
  const T = require('../traffic.js');
  const lat0 = 56.95, lng0 = 24.10, cos = Math.cos(lat0 * Math.PI / 180);
  const at = x => ({ lat: lat0, lng: lng0 + x / (111320 * cos) });
  const C = new T.TrafficCollector();
  let t = 0;
  for (let i = 0; i <= 300; i++) C.add(Object.assign(at(i * 10), { t: t += 1000, kmh: 36, bearing: 90, acc: 5, cls: 3 }));
  const sent = C.ready(Object.assign({}, C.last, { t }));
  ok(sent.length > 40, 'mērījumi tiek atdoti: ' + sent.length);
  ok(sent.every(it => Object.keys(it).sort().join() === 'c,d,k,v'), 'tikai šūna, virziens, ātrums, klase — nekā cita');
  ok(sent.every(it => it.d === 2 && Math.abs(it.v - 36) < 2), 'virziens uz austrumiem, ~36 km/h');
  const xOf = c => (Number(c.split('_')[1]) + 0.5) / T.TR_CELL;
  const xs = sent.map(it => (xOf(it.c) - lng0) * 111320 * cos);
  ok(Math.min(...xs) > 380, 'pirmie 400 m netiek sūtīti (min ' + Math.round(Math.min(...xs)) + ' m)');
  // Apstāšanās > 10 min: pēdējie 400 m netiek sūtīti nekad
  for (let i = 0; i < 70; i++) C.add(Object.assign(at(3000), { t: t += 10000, kmh: 0, bearing: 90, acc: 5, cls: 3 }));
  const rest = C.ready(Object.assign(at(3000), { t }));
  const xr = rest.map(it => (xOf(it.c) - lng0) * 111320 * cos);
  ok(xr.every(x => x < 2600), 'pēdējie 400 m netiek sūtīti (max ' + Math.round(Math.max(...xr)) + ' m)');
  eq(C.queue.length, 0);
  // Līmeņi
  eq(T.trLevel(8, 50, 3), 3); eq(T.trLevel(30, 50, 3), 1); eq(T.trLevel(48, 50, 3), 0);
  eq(T.trLevel(5, null, 6), 0, 'maza iela bez vēstures — nevērtē');
  // Maršruta kavējums: 200 m sastrēgums 6 km/h uz galvenās ielas
  const jams = new Map();
  for (let x = 400; x < 600; x += 20) { const p = at(x); jams.set(T.trCell(p.lat, p.lng) + '|2', { kmh: 6, typical: 50, cls: 3 }); }
  const coords = [0, 1000].map(x => { const p = at(x); return [p.lng, p.lat]; });
  const d = T.trRouteDelay(coords, jams);
  ok(d.sec > 80 && d.sec < 150, 'kavējums ~1,5 min: ' + d.sec);
  eq(T.trRouteDelay(coords.slice().reverse(), jams).sec, 0, 'pretējā virzienā sastrēguma nav');
});

test('W. Kopbraucienu cena: griesti 300 €, ievade, komisija', async () => {
  const cap = G('rideFareCapCents'), parse = G('rideParsePrice'), money = G('rideMoney'), split = G('rideSplit');
  eq(cap({ from_lat: 56.95, from_lng: 24.1, to_lat: 56.951, to_lng: 24.1 }), 30000, 'griesti 300 € (arī īsam braucienam)');
  eq(parse('300'), 30000); eq(parse('50'), 5000);
  eq(parse('4,50'), 450); eq(parse(' 4 € '), 400); eq(parse('4.5'), 450); eq(parse(''), null);
  ok(Number.isNaN(parse('abc')) && Number.isNaN(parse('4,555')) && Number.isNaN(parse('-3')), 'nederīgas cenas');
  eq(money(450), '4,50 €'); eq(money(1000), '10,00 €');
  eq(JSON.stringify(split(1000)), '{"fee":100,"driver":900}', '10 € → šoferim 9 €, lietotnei 1 €');
  eq(JSON.stringify(split(455, 10)), '{"fee":46,"driver":409}');
  // Demo krātuve saglabā cenu piedāvājumā
  const S = G('LocalRideStore'); const mem = {};
  const st = new S({ getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = v; } });
  await st.init(); await st.saveProfile({ name: 'Šoferis', car: '' });
  await st.offer('req-1', { eta_min: 5, price_cents: 350 });
  eq(JSON.parse(mem[Object.keys(mem)[0]]).offers[0].price_cents, 350, 'cena saglabāta');
});

// ---------- Alternatīvie maršruti ----------
{
  const parseOsrmRoute = G('parseOsrmRoute'), pickAlternatives = G('pickAlternatives'), labelRoutes = G('labelRoutes');
  const routeLabelPoint = G('routeLabelPoint'), detourPoints = G('detourPoints');
  // Vienkāršs OSRM maršruts caur punktiem (metros); legs — punktu grupas (starppunkts = jauna grupa)
  const osrm = (legs, duration) => ({ distance: 0, duration, legs: legs.map((pts, li) => ({ steps: [
    { maneuver: { type: li === 0 ? 'depart' : 'depart' }, geometry: { coordinates: pts.map(([x, y]) => P(x, y)) } },
    { maneuver: { type: 'arrive' }, geometry: { coordinates: [P(...pts[pts.length - 1]), P(...pts[pts.length - 1])] } }] })) });
  const mk = (legs, dur) => { const r = parseOsrmRoute(osrm(legs, dur)); r.distance = r.cum[r.cum.length - 1]; return r; };
  const A = mk([[[0, 0], [3000, 0]]], 300);                       // taisni
  const B = mk([[[0, 0], [0, 800], [3000, 800], [3000, 0]]], 380); // apkārt ziemeļos
  const C = mk([[[0, 0], [10, 3], [3000, 5]]], 310);              // gandrīz tas pats, kas A
  const D = mk([[[0, 0], [0, 6000], [3000, 6000], [3000, 0]]], 1500); // pārāk garš
  test('alternatīvas: atšķirīgos atstāj, līdzīgos un pārāk garos izmet', () => {
    const out = pickAlternatives([B, C, A, D], 3);
    eq(out.length, 2); ok(out[0] === A && out[1] === B, 'A ātrākais, tad B');
  });
  test('alternatīva ar starppunktu: starp-"ieradies" soļa nav', () => {
    const r = mk([[[0, 0], [1500, 800]], [[1500, 800], [3000, 0]]], 400);
    eq(r.steps.filter(s => s.maneuver.type === 'arrive').length, 1);
    eq(r.steps.filter(s => s.maneuver.type === 'depart').length, 1);
    eq(r.steps[r.steps.length - 1].maneuver.type, 'arrive');
  });
  test('alternatīva, kas brauc turp un atpakaļ, netiek piedāvāta', () => {
    const E = mk([[[0, 0], [1500, 0], [1500, 900], [1500, 0], [3000, 0]]], 420);
    const F = mk([[[0, 0], [0, 400], [1500, 400], [1500, 1400], [1500, 400], [3000, 400], [3000, 0]]], 450);
    const out = pickAlternatives([A, F], 3);
    eq(out.length, 1); void E;
  });
  test('nosaukumi: ātrākais, īsākais, mazāk sastrēgumu', () => {
    const a = { duration: 600, distance: 9000, jamSec: 300 }, b = { duration: 700, distance: 7000, jamSec: 0 }, c = { duration: 650, distance: 9500, jamSec: 0 };
    const l = labelRoutes([a, b, c]);
    eq(l[2], 'Ātrākais'); eq(l[1], 'Īsākais'); eq(l[0], 'Alternatīva');
    const l2 = labelRoutes([{ duration: 600, distance: 9000, jamSec: 400 }, { duration: 650, distance: 9800, jamSec: 100 }, { duration: 1500, distance: 9900, jamSec: 0 }]);
    eq(l2[1], 'Ātrākais'); eq(l2[2], 'Mazāk sastrēgumu');
  });
  test('uzraksts alternatīvai — tās atšķirīgajā daļā', () => {
    const p = routeLabelPoint(B, [A]);
    ok(p[1] > P(0, 600)[1], 'uzraksts ziemeļu daļā');
  });
  test('apkārtceļu starppunkti abās pusēs', () => {
    const v = detourPoints(LL(0, 0), LL(5000, 0));
    eq(v.length, 4); ok(v[0].lat > LAT0 && v[1].lat < LAT0, 'viens ziemeļos, otrs dienvidos');
  });
}

// ---------- F1: konts un piekrišana ----------
{
  const CzAuth = G('CzAuth'), parse = G('czParseAuthReturn'), errText = G('czAuthErrorText');
  const mem = (init = {}) => { const m = { ...init }; return { m, getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } }; };
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = claims => 'h.' + b64(claims) + '.s';
  const consent = JSON.stringify({ terms: G('CZ_TERMS_VERSION'), privacy: G('CZ_PRIVACY_VERSION'), at: 'x' });
  const fakeFetch = (handler) => { const calls = []; const f = async (url, opts = {}) => { calls.push({ url, method: opts.method || 'GET', body: opts.body }); const [st, body] = handler(url, opts) || [200, {}]; return { ok: st < 400, status: st, text: async () => JSON.stringify(body), json: async () => body }; }; f.calls = calls; return f; };
  const cfg = { url: 'https://x.supabase.co', anonKey: 'sb_publishable_test' };
  const anonTok = jwt({ sub: 'anon-1', is_anonymous: true, exp: 9e9 });

  test('F1: atverot bez sesijas konts netiek veidots (nav neviena pieprasījuma)', async () => {
    const f = fakeFetch(() => [500, {}]); const st = mem({ 'cz.consent': consent });
    const a = new CzAuth(cfg, { storage: st, fetch: f });
    eq(await a.token(), null); eq(a.hasSession(), false); eq(f.calls.length, 0);
    const S = G('SupabaseRideStore'); const store = new S(cfg, st, a); await store.init();
    eq(f.calls.length, 0, 'store.init neko nesūta'); eq(store.hasAccount(), false);
  });
  test('F1: bez piekrišanas noteikumiem anonīmu kontu neveido', async () => {
    const f = fakeFetch(() => [200, {}]); const a = new CzAuth(cfg, { storage: mem(), fetch: f });
    let code = null; try { await a.token({ create: true }); } catch (e) { code = e.code; }
    eq(code, 'consent'); eq(f.calls.length, 0);
  });
  test('F1: ar piekrišanu, atverot „Kopā”, izveido vienu anonīmu kontu', async () => {
    const f = fakeFetch(u => /signup/.test(u) ? [200, { access_token: anonTok, refresh_token: 'r1', expires_in: 3600, user: { id: 'anon-1' } }] : [201, {}]);
    const st = mem({ 'cz.consent': consent }); const a = new CzAuth(cfg, { storage: st, fetch: f });
    const S = G('SupabaseRideStore'); const store = new S(cfg, st, a);
    await store.ensureAccount();
    eq(f.calls.filter(c => /signup/.test(c.url)).length, 1); eq(store.id, 'anon-1'); eq(a.isAnon, true);
    ok(JSON.parse(st.m['cz.auth.session']).refresh_token === 'r1', 'sesija saglabāta');
    ok(f.calls.some(c => /user_consents/.test(c.url) && /"kind":"terms"/.test(c.body)), 'piekrišana nosūtīta serverim');
    await a.token({ create: true });
    eq(f.calls.filter(c => /signup/.test(c.url)).length, 1, 'otru kontu neveido');
  });
  test('F1: vecās sesijas (kopbraucienu un sastrēgumu) tiek pārņemtas, nevis izmestas', () => {
    const st = mem({ 'cz.rides.session': JSON.stringify({ access_token: anonTok, refresh_token: 'old-r', expires_at: 1, user_id: 'anon-1' }), 'cz.traffic.session': JSON.stringify({ token: jwt({ sub: 'tr-9' }), refresh: 'tr-r', exp: 1 }) });
    const a = new CzAuth(cfg, { storage: st, fetch: fakeFetch(() => [500, {}]) });
    eq(a.userId, 'anon-1', 'kopbraucienu identitāte saglabāta'); ok(st.m['cz.rides.session'], 'vecā atslēga neaiztikta');
    const st2 = mem({ 'cz.traffic.session': JSON.stringify({ token: jwt({ sub: 'tr-9' }), refresh: 'tr-r', exp: 1 }) });
    eq(new CzAuth(cfg, { storage: st2, fetch: fakeFetch(() => [500, {}]) }).userId, 'tr-9', 'ja ir tikai sastrēgumu sesija — pārņem to');
  });
  test('F1: Magic Link — anonīmam kontam piesaista e-pastu (ID nemainās), citādi pieslēgšanās saite', async () => {
    const f = fakeFetch(() => [200, {}]);
    const st = mem({ 'cz.auth.session': JSON.stringify({ access_token: anonTok, refresh_token: 'r', expires_at: Date.now() + 3600e3, user_id: 'anon-1' }) });
    const a = new CzAuth(cfg, { storage: st, fetch: f });
    eq((await a.sendLink('Ilze@Piemers.lv', 'https://app/')).mode, 'link');
    const c = f.calls[0]; ok(/\/auth\/v1\/user\?redirect_to=https%3A%2F%2Fapp%2F/.test(c.url) && c.method === 'PUT' && /ilze@piemers\.lv/.test(c.body), 'PUT /user ar e-pastu');
    const f2 = fakeFetch(() => [200, {}]); const a2 = new CzAuth(cfg, { storage: mem(), fetch: f2 });
    eq((await a2.sendLink('a@b.lv', 'https://app/')).mode, 'signin'); ok(/\/otp\?redirect_to=/.test(f2.calls[0].url), 'POST /otp');
    let code = null; try { await a2.sendLink('nav-epasts', 'x'); } catch (e) { code = e.code; } eq(code, 'invalid_email');
  });
  test('F1: e-pasts jau pieder citam kontam — kļūda tiek atpazīta', async () => {
    const f = fakeFetch(() => [422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' }]);
    const a = new CzAuth(cfg, { storage: mem({ 'cz.auth.session': JSON.stringify({ access_token: anonTok, refresh_token: 'r', expires_at: Date.now() + 3600e3 }) }), fetch: f });
    let e1 = null; try { await a.sendLink('x@y.lv', 'u'); } catch (e) { e1 = e; }
    eq(e1.code, 'email_exists'); eq(errText(e1.code), 'Šis e-pasts jau pieder citam kontam.');
  });
  test('F1: atgriešanās no saites — sesija, kļūdas un nederīga saite', async () => {
    const ok1 = parse('#access_token=' + jwt({ sub: 'u-2', email: 'a@b.lv', is_anonymous: false }) + '&refresh_token=rr&expires_in=3600&type=magiclink');
    eq(ok1.type, 'magiclink'); eq(ok1.session.refresh_token, 'rr');
    const bad = parse('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    eq(bad.error, 'otp_expired'); ok(/vairs nav derīga/.test(errText(bad.error)), 'saprotams teksts latviski');
    eq(parse('#foo=1'), null);
  });
  test('F1: pieslēdzoties esošam kontam, anonīmā konta dati tiek pārcelti ar kodu', async () => {
    const f = fakeFetch(u => /account_transfer_start/.test(u) ? [200, 'kods123'] : /account_transfer_claim/.test(u) ? [200, { ok: true, requests: 2, offers: 1, messages: 3 }] : [200, {}]);
    const st = mem({ 'cz.consent': consent, 'cz.auth.session': JSON.stringify({ access_token: anonTok, refresh_token: 'r', expires_at: Date.now() + 3600e3, user_id: 'anon-1' }) });
    const a = new CzAuth(cfg, { storage: st, fetch: f });
    await a.signInOther('ilze@piemers.lv', 'https://app/');
    ok(JSON.parse(st.m['cz.auth.transfer']).code === 'kods123' && st.m['cz.auth.prev'], 'kods un iepriekšējā sesija saglabāti');
    const res = await a.handleReturn('#access_token=' + jwt({ sub: 'perm-7', email: 'ilze@piemers.lv', is_anonymous: false }) + '&refresh_token=pr&expires_in=3600&type=magiclink', '');
    eq(a.userId, 'perm-7'); eq(a.isAnon, false); eq(res.switched, true); eq(res.transfer.requests, 2);
    ok(f.calls.some(c => /account_transfer_claim/.test(c.url) && /kods123/.test(c.body)), 'kods nosūtīts');
    ok(!st.m['cz.auth.transfer'] && !st.m['cz.auth.prev'], 'pēc veiksmīgas pārcelšanas notīrīts');
  });
  test('F1: ja pārcelšana neizdodas — iepriekšējo kontu var atjaunot', async () => {
    const f = fakeFetch(u => /account_transfer_start/.test(u) ? [200, 'k'] : /account_transfer_claim/.test(u) ? [200, { ok: false, reason: 'expired' }] : [200, {}]);
    const st = mem({ 'cz.auth.session': JSON.stringify({ access_token: anonTok, refresh_token: 'r', expires_at: Date.now() + 3600e3, user_id: 'anon-1' }) });
    const a = new CzAuth(cfg, { storage: st, fetch: f });
    await a.signInOther('x@y.lv', 'u');
    await a.handleReturn('#access_token=' + jwt({ sub: 'perm-7', email: 'x@y.lv', is_anonymous: false }) + '&refresh_token=pr&expires_in=3600', '');
    eq(a.hasPrevious(), true); eq(a.restorePrevious(), true); eq(a.userId, 'anon-1');
  });
  test('F1: izrakstīšanās un konta dzēšana notīra lokālo sesiju', async () => {
    const f = fakeFetch(() => [204, {}]);
    const st = mem({ 'cz.auth.session': JSON.stringify({ access_token: jwt({ sub: 'p', email: 'a@b.lv', is_anonymous: false }), refresh_token: 'r', expires_at: Date.now() + 3600e3 }), 'cz.rides.session': '{}', 'cz.traffic.session': '{}' });
    const a = new CzAuth(cfg, { storage: st, fetch: f });
    await a.signOut();
    ok(!st.m['cz.auth.session'] && !st.m['cz.rides.session'] && !st.m['cz.traffic.session'], 'visas sesijas dzēstas'); eq(a.hasSession(), false);
  });
  test('F1: servera slepenā atslēga nav nevienā pārlūka failā', () => {
    for (const f of fs.readdirSync(path.join(__dirname, '..')).filter(n => /\.(js|html)$/.test(n))) {
      const t = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      ok(!/sb_secret_[A-Za-z0-9]|SUPABASE_SERVICE_ROLE_KEY|sk_(test|live)_[A-Za-z0-9]{8}/.test(t), 'slepena atslēga failā ' + f);
      for (const tok of t.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g) || []) {
        const role = (JSON.parse(Buffer.from(tok.split('.')[1], 'base64').toString()) || {}).role;
        ok(role !== 'service_role', 'service_role JWT failā ' + f);
      }
    }
  });
}

// ---------- F10: kopīgi ziņojumi uz ceļa ----------
{
  const CzAuth = G('CzAuth'), ReportsApi = G('ReportsApi');
  const mem = (init = {}) => { const m = { ...init }; return { m, getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } }; };
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const tok = 'h.' + b64({ sub: 'anon-7', is_anonymous: true, exp: 9e9 }) + '.s';
  const consent = JSON.stringify({ terms: G('CZ_TERMS_VERSION'), privacy: G('CZ_PRIVACY_VERSION'), at: 'x' });
  const cfg = { url: 'https://x.supabase.co', anonKey: 'sb_publishable_test' };
  const ff = handler => { const calls = []; const f = async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers || {}, body: opts.body });
    const res = handler(url, opts); if (res === 'net') throw new TypeError('Failed to fetch');
    const [st, body] = res || [200, {}];
    return { ok: st < 400, status: st, text: async () => JSON.stringify(body), json: async () => body }; }; f.calls = calls; return f; };
  const signup = u => /signup/.test(u) ? [200, { access_token: tok, refresh_token: 'r', expires_in: 3600, user: { id: 'anon-7' } }] : null;
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'reports.sql'), 'utf8');

  test('F10: servera derīgums (report_ttl) sakrīt ar ziņošanas pogām; katrai pogai ir derīgums', () => {
    const T = G('ALERT_TYPES');
    const srv = Object.fromEntries([...sql.matchAll(/when '([a-z-]+)'\s+then (\d+)/g)].map(m => [m[1], +m[2]]));
    const rep = Object.keys(T).filter(k => T[k].report);
    eq(rep.length, 20, 'ziņošanas pogu skaits');
    // v124: the 5 community types take their lifetime from report_types (coins-1.sql), the rest from report_ttl
    const coins = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'coins-1.sql'), 'utf8');
    const rt = Object.fromEntries([...coins.matchAll(/\('([a-z-]+)',\s+'[^']+',\s+'[a-z-]+',\s+(\d+),/g)].map(m => [m[1], +m[2]]));
    eq(Object.keys(rt).sort().join(), 'accident,camera-mobile,jam,obstacle,police', 'report_types');
    for (const k of rep) eq(rt[k] != null ? rt[k] : srv[k], T[k].ttl, 'derīgums ' + k);
    eq(Object.keys(srv).length, rep.length, 'serverī nav lieku veidu');
    eq(T.police.ttl, 45); eq(T['camera-mobile'].ttl, 60); eq(T.accident.ttl, 60); eq(T.jam.ttl, 20); eq(T.obstacle.ttl, 30); eq(T.roadworks.ttl, 1440);
  });
  test('F10: SQL — RLS, tieši rakstīt nevar, sarakstu var lasīt bez konta, ziņot — tikai ar kontu', () => {
    ok(/alter table public\.reports enable row level security/.test(sql) && /alter table public\.report_votes enable row level security/.test(sql), 'RLS');
    ok(!/create policy/i.test(sql), 'nav politiku — tikai funkcijas');
    ok(/grant execute on function public\.report_list\([^)]*\) to anon, authenticated/.test(sql), 'saraksts arī anon');
    for (const fn of ['report_create', 'report_vote', 'report_delete']) {
      ok(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon`).test(sql), fn + ' nav anon');
      ok(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to authenticated;`).test(sql), fn + ' authenticated');
    }
    ok(/revoke all on function public\.report_vote_apply\([^)]*\) from public, anon, authenticated/.test(sql), 'iekšējā funkcija nav pieejama');
    const list = sql.slice(sql.indexOf('function public.report_list'), sql.indexOf('$$;', sql.indexOf('function public.report_list')));
    ok(!/returns table \([^)]*user_id/.test(list) && !/select r\.user_id/.test(list), 'report_list neatdod user_id');
    ok(/n >= 10 then raise exception 'rate_limit'/.test(sql), 'limits 10 stundā');
    ok(/g >= 2/.test(sql) && /primary key \(report_id, user_id\)/.test(sql), '2 dažādi „vairs nav”');
    ok(/owner = me then raise exception 'own_report'/.test(sql), 'par savu nebalso');
    ok(/2 \* ttl/.test(sql), 'pagarina ne vairāk kā 2×');
    ok(/<= 150/.test(sql), 'dublikāti 150 m');
  });
  test('F10: ziņojot bez konta — izveido anonīmu kontu un sūta ar sesiju; kļūdas — saprotamā valodā', async () => {
    const f = ff(u => signup(u) || (/report_create/.test(u) ? [200, { id: 'r1', merged: false }] : [201, {}]));
    const a = new CzAuth(cfg, { storage: mem({ 'cz.consent': consent }), fetch: f });
    const api = new ReportsApi(a);
    const res = await api.create('police', 56.95, 24.1, 91.6);
    eq(res.id, 'r1');
    const c = f.calls.find(x => /report_create/.test(x.url));
    ok(c && c.headers.Authorization === 'Bearer ' + tok, 'ar sesiju');
    const b = JSON.parse(c.body); eq(b.p_type, 'police'); eq(b.p_heading, 92); eq(b.p_minutes, null);
    const f2 = ff(u => signup(u) || (/report_create/.test(u) ? [400, { code: 'P0001', message: 'rate_limit' }] : [201, {}]));
    const api2 = new ReportsApi(new CzAuth(cfg, { storage: mem({ 'cz.consent': consent }), fetch: f2 }));
    let code = null; try { await api2.create('police', 56.95, 24.1, null); } catch (e) { code = e.code; }
    eq(code, 'rate_limit'); ok(/Pārāk daudz ziņojumu/.test(G('reportErrorText')(code)));
    const f3 = ff(u => signup(u) || (/rpc/.test(u) ? 'net' : [201, {}]));
    const api3 = new ReportsApi(new CzAuth(cfg, { storage: mem({ 'cz.consent': consent }), fetch: f3 }));
    code = null; try { await api3.create('police', 56.95, 24.1, null); } catch (e) { code = e.code; }
    eq(code, 'network'); ok(/Nav savienojuma/.test(G('reportErrorText')(code)));
    const api4 = new ReportsApi(new CzAuth(cfg, { storage: mem(), fetch: ff(() => [200, {}]) }));
    code = null; try { await api4.create('police', 56.95, 24.1, null); } catch (e) { code = e.code; }
    eq(code, 'consent', 'bez piekrišanas neko nesūta');
    for (const k of ['own_report', 'outside_latvia', 'not_found', 'no_location', 'vote_limit']) ok(/[ā-ž]/i.test(G('reportErrorText')(k)), k);
  });
  test('F10: saraksts — bez konta konts netiek veidots, ziņotāja ID neatdod', async () => {
    const rows = [{ id: 'u1', type: 'police', lat: 56.95, lng: 24.1, heading: 90, created_at: '2026-10-23T10:00:00Z', expires_at: '2026-10-23T11:00:00Z', still_count: 2, mine: false, my_vote: null }];
    const f = ff(u => /report_list/.test(u) ? [200, rows] : [500, {}]);
    const a = new CzAuth(cfg, { storage: mem({ 'cz.consent': consent }), fetch: f });
    const list = await new ReportsApi(a).list({ min_lat: 56.9, min_lng: 24, max_lat: 57, max_lng: 24.2 });
    eq(f.calls.length, 1, 'tikai saraksta pieprasījums'); ok(!f.calls[0].headers.Authorization, 'bez sesijas — bez Authorization');
    eq(a.hasSession(), false, 'konts netika izveidots');
    eq(list[0].id, 'rep:u1'); eq(list[0].source, 'shared'); eq(list[0].still, 2); eq(list[0].mine, false); eq(list[0].title, 'Policija');
    ok(!('user_id' in list[0]), 'nav user_id');
    ok(/apstiprināja 2/.test(G('reportInfo')(list[0], Date.parse('2026-10-23T10:12:00Z'))) && /pirms 12 min/.test(G('reportInfo')(list[0], Date.parse('2026-10-23T10:12:00Z'))));
  });
  test('F10: apgabals — nedaudz plašāks par ekrānu, Latvijas robežās', () => {
    const bb = G('reportBBox')({ s: 56.9, w: 24.0, n: 57.0, e: 24.2 });
    ok(bb.min_lat < 56.9 && bb.max_lat > 57 && bb.min_lng < 24 && bb.max_lng > 24.2);
    const all = G('reportBBox')({ s: 50, w: 10, n: 65, e: 40 });
    eq(all.min_lat, 55.6); eq(all.max_lat, 58.1); eq(all.min_lng, 20.9); eq(all.max_lng, 28.3);
    eq(G('reportBBox')({ s: 59, w: 24, n: 60, e: 25 }), null, 'ārpus Latvijas — neko neprasa');
    const d = G('reportDur'); eq(d(30), '30 min'); eq(d(60), '1 h'); eq(d(90), '1,5 h'); eq(d(1440), '24 h'); eq(d(43200), '30 dienas');
  });
  test('F10: vecie ierīces ziņojumi — augšupielādē tikai aktīvos (≥ 5 min), līdz 10, ar atlikušo laiku', () => {
    const now = Date.parse('2026-10-23T12:00:00Z');
    const mk = (i, left) => ({ id: 'user:' + i, source: 'user', type: 'police', lat: 56.9, lng: 24.1, heading: 10.4, createdAt: now - i * 1000, expiresAt: now + left * 60000 });
    const list = [mk(1, 30), mk(2, 2), mk(3, -5), ...Array.from({ length: 12 }, (_, i) => mk(10 + i, 40)), { source: 'osm', type: 'roadworks' }];
    const t = G('reportsToMigrate')(list, now);
    eq(t.length, 10); eq(t[0].minutes, 30); eq(t[0].heading, 10);
    ok(t.every(x => x.minutes >= 5), 'tikai aktīvie');
    eq(G('reportsToMigrate')(null, now).length, 0);
  });
  test('F10: lietotnē ziņojumi vairs netiek glabāti ierīcē un kļūdas nerāda statusa joslā aiz loga', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
    const fnSrc = name => { const i = app.indexOf('function ' + name + '('); return app.slice(i, app.indexOf('\n}\n', i)); };
    ok(/alerts = new AlertStore\(null\)/.test(app), 'AlertStore bez lokālās krātuves');
    ok(!/setStatus/.test(fnSrc('reportAlert')), 'reportAlert neizmanto setStatus');
    ok(/reportSheetMsg\(reportErrorText/.test(fnSrc('reportAlert')), 'kļūda logā');
    ok(/reportsApi\.create/.test(fnSrc('reportAlert')) && !/alerts\.add\(makeReport/.test(app), 'sūta uz serveri, nesaglabā lokāli');
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    ok(/id="reportMsg"/.test(html) && /reports\.js\?v=/.test(html) && !/ziņojumi redzami tikai šajā ierīcē/.test(html));
  });
}

// ---------- F14: maksājumu atmaksa ----------
{
  const fn = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'ride-pay', 'index.ts'), 'utf8');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'rides-8-refund.sql'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'rides-ui.js'), 'utf8');
  test('F14: atmaksa — Stripe Refund ar reverse_transfer, refund_application_fee un idempotences atslēgu', () => {
    ok(/stripe\('refunds', \{[\s\S]*?reverse_transfer: 'true', refund_application_fee: 'true'/.test(fn), 'refund parametri');
    ok(/refundKey\(oid, st\)/.test(fn) && /`refund-\$\{oid\}-\$\{st\.refunded\}-\$\{st\.failed\}`/.test(fn) && /'Idempotency-Key': idem/.test(fn), 'Idempotency-Key refund-<id>-<atmaksāts>-<neizdevušās> (A05)');
    ok(/if \(st\.full\) \{/.test(fn) && /Šis brauciens jau ir atmaksāts/.test(fn) && /if \(st\.pending > 0\) return result\(st, true\);/.test(fn), 'dubulta atmaksa atteikta (arī, kamēr atmaksa apstrādē — A05)');
  });
  test('F14: tiesības — šoferis pēc pieslēgtā lietotāja; automātiski tikai atceltam pirms iekāpšanas', () => {
    ok(/const isDriver = o\.driver_id === uid/.test(fn) && /Atmaksāt var tikai šī brauciena šoferis/.test(fn), 'šoferis pēc uid');
    ok(/\['', 'coming', 'arrived'\]\.includes\(o\.trip\)/.test(fn) && /o\.status === 'cancelled' \|\| o\.request\.status === 'cancelled'/.test(fn), 'atcelts pirms iekāpšanas');
    ok(!/body\.(driver_id|user_id|uid)/.test(fn), 'lietotāja ID neņem no klienta datiem');
    ok(/o\.trip in \('', 'coming', 'arrived'\)/.test(sql), 'kandidāti — pirms iekāpšanas');
  });
  test('F14: datubāze — statuss refunded, ID, laiks, iemesls; tieši mainīt nevar', () => {
    for (const c of ['status text', 'refund_id text', 'refunded_at timestamptz', 'refund_reason text', 'refund_cents int']) ok(sql.includes(c), c);
    ok(/'cancelled_before_pickup', 'driver_refund', 'stripe_dashboard'/.test(sql), 'iemesli');
    ok(/Maksājuma statusu mainīt nevar/.test(sql) && /create trigger ride_payment_guard before update/.test(sql), 'aizsardzība');
    ok(!/create or replace function public\.ride_payment_mark/.test(sql), 'vecā (authenticated) funkcija vairs netiek veidota');
  });
  test('F14: saskarne — „Atmaksāt” tikai samaksātam un neatmaksātam, ar apstiprinājumu; ziņas kartītē / uznirstošas', () => {
    ok(/if \(!\(ok && p && p\.paid && \(ri\.state === 'none' \|\| ri\.state === 'partial'\)\)\) return line;/.test(ui), 'poga tikai samaksātam (un neatmaksātam / daļēji atmaksātam — A05)');
    ok(/Atmaksāt pasažierim \$\{rideMoney\(amount\)\}\? Šo nevar atsaukt\./.test(ui), 'apstiprinājums');
    ok(/Nauda \$\{sum\} atmaksāta uz tavu karti\. Bankā tā parādīsies 5–10 darba dienu laikā\./.test(ui), 'pasažiera ziņa');
    const i = ui.indexOf('function ridesRefundBtn'), j = ui.indexOf('function ridesRefundSeenList');
    ok(i > 0 && !/setStatus/.test(ui.slice(i, j)), 'atmaksas kodā nav setStatus');
    ok(/ridesRefundAfterCancel\(acc\)/.test(ui) && /ridesRefundAfterCancel\(o\)/.test(ui), 'atcelšana izsauc atmaksu');
    ok(/pay\('refund', \{ offer_id: o\.id, auto: true \}\)/.test(ui), 'tā pati servera darbība');
  });
}

// ---------- F15: dalīšanās ar ātrumu ----------
{
  const tg = fs.readFileSync(path.join(__dirname, '..', 'traffic-gl.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'traffic-2-helpers.sql'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  test('F15: jautājums pirmajā navigācijā — vienreiz, „Nē” respektē, abas pogas vienādas', () => {
    const sn = app.slice(app.indexOf('function startNav('), app.indexOf('\n}\n', app.indexOf('function startNav(')));
    ok(/trafficOffer\(\)/.test(sn), 'startNav jautā');
    const off = tg.slice(tg.indexOf('async function trafficOffer'), tg.indexOf('function trAskConsent'));
    ok(/trPref\('cz\.traffic\.share', ''\) !== ''\) return/.test(off), 'atbildēts (arī „Nē”) — vairs nejautā');
    ok(/czConsentOk\(\)\) return/.test(off) && /trServerChoice\(\)/.test(off), 'pēc noteikumiem; atceras arī no konta');
    ok(/Palīdzi citiem — anonīmi dalies ar braukšanas ātrumu sastrēgumu kartei\?/.test(tg), 'virsraksts');
    ok(/data-a="no">Nē<\/button><button type="button" class="btn tr-c-btn" data-a="yes">Jā</.test(tg) && /class="btn tr-c-btn" data-a="no"/.test(tg), 'pogas vienādas');
    ok(/28 dienas/.test(tg) && /izslēgt iestatījumos/.test(tg), 'privātuma skaidrojums');
    ok(!/setStatus/.test(tg), 'ziņas nav statusa joslā');
    ok(/if \(yes\) await a\.token\(\{ create: true \}\)/.test(tg), '„Jā” → anonīmā sesija (F1)');
  });
  test('F15: iestatījumu slēdzis iestatījumu augšā, ar paskaidrojumu un skaitītāju', () => {
    const i = html.indexOf('id="settings"'), j = html.indexOf('id="trafficRows"'), k = html.indexOf('id="masterSwitch"');
    ok(i > 0 && k > i && j > k, 'v131: sastrēgumi — otrā grupa pēc „Braukšana” (svarīgākais pirmais)');
    ok(/id="trafficShare"/.test(html) && /id="trHelpersSet"/.test(html) && /id="routeHelpers"/.test(html));
  });
  test('F15: „Šobrīd palīdz” — RPC atdod tikai skaitli, lasīt var bez konta', () => {
    ok(/returns int/.test(sql) && /select count\(\*\)::int from public\.traffic_quota where last_at > now\(\) - interval '15 minutes'/.test(sql));
    ok(/grant execute on function public\.traffic_helpers\(\) to anon, authenticated/.test(sql));
    ok(/last_at = now\(\)/.test(sql), 'traffic_report pieraksta laiku');
    const f = new Function(tg.slice(tg.indexOf('function trHelpersText'), tg.indexOf('async function trHelpersLoad')) + '; return trHelpersText;')();
    eq(f(0), 'Šobrīd neviens nepalīdz — esi pirmais, kas palīdz!'); eq(f(1), 'Šobrīd palīdz: 1 braucējs');
    eq(f(12), 'Šobrīd palīdz: 12 braucēji'); eq(f(11), 'Šobrīd palīdz: 11 braucēji'); eq(f(21), 'Šobrīd palīdz: 21 braucējs');
  });
  test('F15: stāvot uz vietas mērījumi netiek veidoti', () => {
    const T = require('../traffic.js'); const C = new T.TrafficCollector();
    const lat0 = 56.95, lng0 = 24.10, cos = Math.cos(lat0 * Math.PI / 180); let t = 0;
    for (let i = 0; i <= 120; i++) C.add({ lat: lat0, lng: lng0 + i * 10 / (111320 * cos), t: t += 1000, kmh: 36, bearing: 90, acc: 5, cls: 3 });
    const before = C.queue.length;
    for (let i = 0; i < 300; i++) C.add({ lat: lat0, lng: lng0 + 1200 / (111320 * cos), t: t += 1000, kmh: 0, bearing: 90, acc: 5, cls: 3 });
    ok(C.queue.length <= before + 1, 'stāvot nav jaunu mērījumu: ' + before + ' → ' + C.queue.length);
  });
}

// ---------- F4: barjeras un privāti ceļi maršrutā ----------
{
  const routeBarriers = G('routeBarriers'), barrierQuery = G('barrierQuery'), barrierAtDestination = G('barrierAtDestination');
  const barrierDetourPoints = G('barrierDetourPoints'), barrierEntryPoint = G('barrierEntryPoint'), nearestOnRoute = G('nearestOnRoute');
  const R = makeRoute([[0, 0], [400, 0], [400, 300]]);           // 700 m: 400 m uz austrumiem, tad 300 m uz ziemeļiem
  const node = (x, y, tags, id = 1) => { const q = LL(x, y); return { type: 'node', id, lat: q.lat, lon: q.lng, tags }; };
  const way = (pts, tags, id = 9) => ({ type: 'way', id, tags, geometry: pts.map(([x, y]) => { const q = LL(x, y); return { lat: q.lat, lon: q.lng }; }) });
  test('F4: barjera uz maršruta līnijas tiek atrasta, 30 m sānis — netiek', () => {
    const b = routeBarriers(R, [node(200, 0, { barrier: 'lift_gate' })]);
    eq(b.length, 1); eq(b[0].kind, 'barrier'); eq(b[0].type, 'lift_gate'); ok(Math.abs(b[0].along - 200) < 1, 'along ' + b[0].along);
    eq(routeBarriers(R, [node(200, 30, { barrier: 'lift_gate' })]).length, 0, '30 m sānis');
    eq(routeBarriers(R, [node(200, 6, { barrier: 'bollard' })]).length, 0, 'stabiņš gar ietvi 6 m sānis');
    eq(routeBarriers(R, [node(200, 0, { barrier: 'kerb' }), node(250, 0, { barrier: 'cycle_barrier' }, 2)]).length, 0, 'apmale u.c. — nav barjera automašīnai');
    for (const t of ['gate', 'swing_gate', 'sliding_gate', 'bollard']) eq(routeBarriers(R, [node(100, 0, { barrier: t })]).length, 1, t);
  });
  test('F4: lift_gate ar access=yes/permissive/destination — netiek', () => {
    for (const v of ['yes', 'permissive', 'destination']) {
      eq(routeBarriers(R, [node(200, 0, { barrier: 'lift_gate', access: v })]).length, 0, 'access=' + v);
      eq(routeBarriers(R, [node(200, 0, { barrier: 'lift_gate', motor_vehicle: v })]).length, 0, 'motor_vehicle=' + v);
      eq(routeBarriers(R, [node(200, 0, { barrier: 'lift_gate', motorcar: v })]).length, 0, 'motorcar=' + v);
    }
    eq(routeBarriers(R, [node(200, 0, { barrier: 'gate', access: 'private' })]).length, 1, 'access=private — barjera');
    eq(routeBarriers(R, [node(200, 0, { barrier: 'gate', access: 'no', motorcar: 'yes' })]).length, 0, 'konkrētākā atzīme svarīgāka');
    eq(routeBarriers(R, [node(200, 0, { barrier: 'entrance' })]).length, 0, 'entrance bez vārtu atzīmes');
    eq(routeBarriers(R, [node(200, 0, { barrier: 'entrance', access: 'private' })]).length, 1, 'entrance ar access=private');
  });
  test('F4: way ar access=private, pa kuru maršruts iet — tiek; šķērsots vai gājēju celiņš — netiek', () => {
    const b = routeBarriers(R, [way([[100, 0], [400, 0]], { highway: 'service', access: 'private' })]);
    eq(b.length, 1); eq(b[0].kind, 'private'); ok(Math.abs(b[0].along - 100) < 6, 'along ' + b[0].along);
    eq(routeBarriers(R, [way([[200, -50], [200, 50]], { highway: 'service', access: 'private' })]).length, 0, 'tikai šķērso');
    eq(routeBarriers(R, [way([[100, 0], [400, 0]], { highway: 'footway', access: 'private' })]).length, 0, 'gājēju celiņš');
    eq(routeBarriers(R, [way([[100, 0], [400, 0]], { highway: 'residential', motor_vehicle: 'no' })]).length, 1, 'motor_vehicle=no');
    eq(routeBarriers(R, [way([[100, 0], [400, 0]], { highway: 'service', access: 'private', motor_vehicle: 'destination' })]).length, 0, 'destination');
    eq(routeBarriers(R, [way([[400, 250], [400, 300], [420, 320]], { highway: 'service', service: 'driveway', access: 'private' })]).length, 0, 'piebrauktuve galamērķī');
  });
  test('F4: barjera pēdējos 30 m pirms galamērķa — netiek', () => {
    eq(routeBarriers(R, [node(400, 280, { barrier: 'lift_gate' })]).length, 0, '20 m līdz galam');
    eq(routeBarriers(R, [node(400, 250, { barrier: 'lift_gate' })]).length, 1, '50 m līdz galam — tiek');
  });
  test('F4: vairāki stabiņi vienā vietā — viens brīdinājums; secība pēc attāluma', () => {
    const b = routeBarriers(R, [node(300, 0, { barrier: 'bollard' }, 3), node(302, 0, { barrier: 'bollard' }, 4), node(100, 0, { barrier: 'gate' }, 5)]);
    eq(b.length, 2); eq(b[0].id, 5); eq(b[1].type, 'bollard');
  });
  test('F4: galamērķis aiz barjeras, ieeja un apbraukšanas punkti', () => {
    const near = routeBarriers(R, [node(400, 200, { barrier: 'lift_gate' })])[0], far = routeBarriers(R, [node(100, 0, { barrier: 'lift_gate' })])[0];
    ok(barrierAtDestination(R, near) && !barrierAtDestination(R, far), 'pie galamērķa ≤ 400 m');
    const e = barrierEntryPoint(R, near), on = nearestOnRoute(R, e.lat, e.lng);
    ok(on.off < 1 && Math.abs(on.along - (near.along - 15)) < 1, 'ieeja 15 m pirms barjeras uz maršruta');
    const v = barrierDetourPoints(R, far);
    eq(v.length, 4);
    for (const p of v) { const d = nearestOnRoute(R, p.lat, p.lng).off; ok(d > 150 && d < 320, 'sānis ' + d); }
  });
  test('F4: „līdz ieejai” — tas pats maršruts, nogriezts pirms barjeras (apbraukšana saglabājas)', () => {
    const routeTruncate = G('routeTruncate');
    const RR = Object.assign(makeRoute([[0, 0], [400, 0], [400, 300]]), { distance: 700, duration: 70,
      steps: [{ maneuver: { type: 'depart' }, _start: 0 }, { maneuver: { type: 'turn', modifier: 'left' }, _start: 1 }, { maneuver: { type: 'arrive' }, _start: 2 }] });
    const t = routeTruncate(RR, 585);
    ok(Math.abs(t.cum[t.cum.length - 1] - 585) < 0.01 && Math.abs(t.distance - 585) < 0.01 && Math.abs(t.duration - 58.5) < 0.01);
    const end = t.coords[t.coords.length - 1], q = P(400, 185);
    ok(Math.abs(end[0] - q[0]) < 1e-7 && Math.abs(end[1] - q[1]) < 1e-7, 'beidzas 585 m');
    eq(t.steps.length, 3); eq(t.steps[2].maneuver.type, 'arrive'); eq(t.steps[2]._start, t.coords.length - 1);
    const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
    const i = app.indexOf('function barrierToEntry'), f = app.slice(i, app.indexOf('\n}\n', i));
    ok(/routeTruncate\(r, Math\.max\(0, bar\.along - 15\)\)/.test(f) && !/osrmFetch/.test(f), 'nogriež pašreizējo maršrutu');
  });
  test('F4: Overpass vaicājums — viens visiem maršrutiem, gar līniju', () => {
    const q = barrierQuery([R, makeRoute([[0, 0], [0, 500]])]);
    ok(/^\[out:json\]\[timeout:25\]/.test(q) && /out body geom;$/.test(q));
    eq((q.match(/node\(around:/g) || []).length, 2, 'abi maršruti');
    ok(/way\.w\["access"~"\^\(private\|no\)\$"\]/.test(q) && /lift_gate/.test(q));
    // Taisns 2 km posms ar punktu ik 10 m → vaicājumā tikai gala punkti; līkums saglabājas
    const pts = []; for (let x = 0; x <= 2000; x += 10) pts.push([x, 0]); pts.push([2000, 300]);
    eq(G('routeAroundLine')(makeRoute(pts)).split(',').length, 6, 'vienkāršota līnija: 3 punkti');
    const long = makeRoute([[0, 0], [20000, 0]]), parts = G('routeCheckParts')(long);
    eq(parts.length, 2, 'garš maršruts — sākums un gals');
    ok(Math.abs(parts[0].coords[1][0] - P(3000, 0)[0]) < 1e-6 && Math.abs(parts[1].coords[0][0] - P(17000, 0)[0]) < 1e-6, 'pa 3 km');
    eq(G('routeCheckParts')(R).length, 1, 'īss — viss');
  });
  test('F4: brīdinājums kartītē, nevis setStatus; rezultāts pārbaudīts pret aktuālo maršrutu', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
    const i = app.indexOf('// ---------- F4:'), j = app.indexOf('async function selectDestination');
    ok(i > 0 && j > i, 'F4 kods atrasts');
    const f4 = app.slice(i, j);
    ok(!/setStatus/.test(f4), 'F4 kodā nav setStatus');
    ok(/state\.nav\.routes !== routes \|\| state\.nav\.dest !== dest/.test(f4), 'vecs rezultāts nepārraksta jaunu');
    ok(/fetchOverpass\(q, BARRIER_WAIT_MS\)/.test(f4) && /BARRIER_WAIT_MS = 45000/.test(f4) && /timed out/.test(f4), 'Overpass caur fetchOverpass ar taimautu');
    ok(/catch \{ return; \}/.test(f4), 'Overpass neatbild — klusi');
    ok(/barriersForPreview\(routes, dest\)/.test(app) && !/barriersForPreview/.test(app.slice(app.indexOf('async function reroute'), app.indexOf('// Testa režīmā'))), 'tikai priekšskatījumā, ne reroute');
    for (const fn of ['function cancelPreview', 'function endNav']) { const k = app.indexOf(fn); ok(/clearBarriers\(\)/.test(app.slice(k, app.indexOf('\n}\n', k))), fn + ' aizvāc marķierus'); }
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    ok(/id="routeTraffic"[^\n]*\n\s*<div class="route-barrier" id="routeBarrier" hidden><\/div>/.test(html), '#routeBarrier pie #routeTraffic');
    eq(html, fs.readFileSync(path.join(__dirname, '..', 'index-gl.html'), 'utf8'), 'index.html = index-gl.html');
  });
}

// ---------- F7: ātruma ierobežojums bez maršruta ----------
{
  const decideSpeedLimit = G('decideSpeedLimit'), isOverspeed = G('isOverspeed'), SpeedLimitHold = G('SpeedLimitHold'), speedSignKind = G('speedSignKind');
  const sp = (x, y, n, face) => sign(x, y, `regulatory--maximum-speed-limit-${n}--g1`, face, 'speed');
  const run = (st, from, to, y = 0, h = 90, step = 20) => { for (let x = from; h === 90 ? x <= to : x >= to; x += h === 90 ? step : -step) drive(st, x, y, h); };
  test('F7: pēc zīmes 30 garām pabraukšanas ierobežojums paliek 30 arī 300 m tālāk', () => {
    roadIndex.setSegments(road(-200, 0, 900, 0, 'A'), COVER);
    const st = store(); st.add(sp(100, -7, 30, 270));
    run(st, 0, 60);
    eq(st.speedMemory(), null, 'pirms zīmes — vēl nav');
    run(st, 80, 420);
    ok(st.speedMemory() && st.speedMemory().limit === 30, 'pēc 300 m: ' + JSON.stringify(st.speedMemory() && st.speedMemory().limit));
    const r = decideSpeedLimit({ sign: st.speedMemory().limit, osm: { limit: 50 }, urban: true });
    eq(r.limit, 30); eq(r.source, 'sign'); eq(r.approx, false);
  });
  test('F7: nogriežoties uz citu ceļu, iepriekšējā zīme vairs nav spēkā; taisni (cits kartes fragments) — paliek', () => {
    roadIndex.setSegments([...road(-200, 0, 500, 0, 'A'), ...road(500, 0, 900, 0, 'A2'), ...road(500, 0, 500, 400, 'B')], COVER);
    const st = store(); st.add(sp(100, -7, 30, 270));
    run(st, 0, 480);
    ok(st.speedMemory() && st.speedMemory().limit === 30, 'uz A');
    run(st, 520, 700);
    ok(st.speedMemory() && st.speedMemory().limit === 30, 'taisni uz A2 — paliek');
    const st2 = store(); st2.add(sp(100, -7, 30, 270));
    run(st2, 0, 480);
    ok(st2.speedMemory() && st2.speedMemory().limit === 30, 'pirms nogriešanās');
    drive(st2, 500, 30, 0);
    ok(st2.speedMemory(), 'viens mērījums citā ceļā (iespējams GPS lēciens) — vēl paliek');
    for (let y = 50; y <= 200; y += 20) drive(st2, 500, y, 0);
    eq(st2.speedMemory(), null, 'nogriezies uz B');
  });
  test('F7: pretējā virziena zīme neietekmē; ierobežojuma beigas un jauna zīme', () => {
    roadIndex.setSegments(road(-200, 0, 900, 0, 'A'), COVER);
    const st = store(); st.add(sp(100, 7, 30, 90));          // otrā pusē, skatās uz austrumiem (braucējiem uz rietumiem)
    run(st, 0, 400);
    eq(st.speedMemory(), null, 'pretējā virziena zīme');
    const st2 = store(); st2.add(sp(100, -7, 30, 270)); st2.add(sign(300, -7, 'regulatory--end-of-maximum-speed-limit-30--g1', 270, 'other'));
    run(st2, 0, 200); ok(st2.speedMemory() && st2.speedMemory().limit === 30);
    run(st2, 220, 420); eq(st2.speedMemory(), null, 'pēc beigu zīmes');
    const st3 = store(); st3.add(sp(100, -7, 30, 270)); st3.add(sp(300, -7, 70, 270));
    run(st3, 0, 420); eq(st3.speedMemory().limit, 70, 'jaunā zīme');
    const gen = sp(100, -7, 30, 270); gen.wayStart = true;  // lietotnes uzlikta OSM ceļa sākuma zīme — nav fiziska zīme
    const st4 = store(); st4.add(gen); run(st4, 0, 300); eq(st4.speedMemory(), null, 'wayStart neņem');
  });
  test('F7: apdzīvotas vietas zīme nosaka noklusējumu un atceļ iepriekšējo zīmi', () => {
    roadIndex.setSegments(road(-200, 0, 900, 0, 'A'), COVER);
    const st = store(); st.add(sp(100, -7, 70, 270)); st.add(sign(300, -7, 'information--end-of-built-up-area--g1', 270, 'other'));
    run(st, 0, 420);
    eq(st.speedMemory(), null); ok(st.settlement && st.settlement.urban === false, 'ārpus apdzīvotas vietas');
    eq(speedSignKind({ value: 'information--built-up-area--g1', cat: 'other' }).kind, 'urban');
    eq(speedSignKind({ cat: 'other', kind: 'city', title: 'Apdzīvotas vietas sākums' }).kind, 'urban');
    eq(speedSignKind({ value: 'information--built-up-area--g2', cat: 'other' }).kind, 'urban', 'Mapillary g2');
    eq(speedSignKind({ value: 'regulatory--end-of-speed-limit-zone--g1', cat: 'other' }).kind, 'end');
    eq(speedSignKind({ value: 'information--living-street--g1', cat: 'other' }).limit, 20, 'dzīvojamā zona');
    eq(speedSignKind({ value: 'information--end-of-living-street--g1', cat: 'other' }).kind, 'end');
    eq(speedSignKind({ value: 'regulatory--no-entry--g1', cat: 'other' }), null);
  });
  test('F7: nav zīmes un OSM maxspeed → 50 ~ (pilsēta) / 90 ~ (ārpus)', () => {
    const u = decideSpeedLimit({ urban: true, cls: 'primary' }); eq(u.limit, 50); eq(u.approx, true); eq(u.source, 'default');
    const r = decideSpeedLimit({ urban: false, cls: 'primary' }); eq(r.limit, 90); eq(r.approx, true);
    eq(decideSpeedLimit({ cls: 'minor' }).limit, 50, 'nezināms, maza iela → 50');
    eq(decideSpeedLimit({ cls: 'primary' }), null, 'nezināms, liels ceļš → nerāda');
    const o = decideSpeedLimit({ osm: { limit: 70 }, urban: true }); eq(o.limit, 70); eq(o.source, 'osm'); eq(o.approx, false);
    const i = decideSpeedLimit({ osm: { limit: 50, implicit: true } }); eq(i.limit, 50); eq(i.approx, true, 'LV:urban — aptuveni');
    eq(decideSpeedLimit({ living: true }).limit, 20);
  });
  test('F7: pārsniegšana — 75 pie 50 → brīdina; ātrums nav zināms → nē', () => {
    eq(isOverspeed(75, { limit: 50 }), true); eq(isOverspeed(75, { limit: 50, approx: true }), false, 'v128: aptuvens (noklusējums) — nebrīdina');
    eq(isOverspeed(null, { limit: 50 }), false); eq(isOverspeed(53, { limit: 50 }), false, '+3 pielaide');
    eq(isOverspeed(75, { limit: 50 }, false), false, 'brīdinājums izslēgts'); eq(isOverspeed(75, null), false);
  });
  test('F7: aizture pret mirgošanu — ~5 s vai ~100 m', () => {
    const h = new SpeedLimitHold(), a = LL(0, 0), b = LL(50, 0), c = LL(160, 0);
    eq(h.update({ limit: 50 }, 0, a.lat, a.lng).limit, 50);
    eq(h.update(null, 3000, b.lat, b.lng).limit, 50, '3 s, 50 m — vēl rāda');
    eq(h.update(null, 6000, b.lat, b.lng), null, 'pēc 5 s');
    h.update({ limit: 30 }, 7000, a.lat, a.lng);
    eq(h.update(null, 8000, c.lat, c.lng), null, 'pēc 100 m');
  });
  test('F7: updateLimit strādā bez navigācijas, testa ātrums no iestatījumiem, notikumi', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
    const fn = name => { const i = app.indexOf('function ' + name + '('); return app.slice(i, app.indexOf('\n}\n', i)); };
    const ul = fn('updateLimit'), rs = fn('resolveSpeedLimit');
    ok(/resolveSpeedLimit\(\)/.test(ul) && !/state\.nav\.active/.test(ul), 'updateLimit nav atkarīgs no navigācijas');
    ok(/isOverspeed\(state\.me\.speedKmh, res, state\.warn\)/.test(ul) && /speedHold\.update/.test(ul));
    ok(/'speedlimitchange'/.test(ul) && /'overspeed'/.test(ul) && !/setStatus/.test(ul + rs), 'notikumi, nav setStatus');
    ok(/signs\.speedMemory/.test(rs) && /lastRouteSignBefore/.test(rs) && /decideSpeedLimit/.test(rs));
    ok(/onFix\(la, lo, state\.testSpeed, hd, 300\)/.test(app), 'klikšķis — testa ātrums un kurss');
    ok(/LIMIT_MATCH_M = 20/.test(app) && /\["maxspeed:type"\]/.test(app) && /"living_street"/.test(app));
    ok(/classList\.toggle\('has-limit'/.test(ul), 'nākamās zīmes kartīte neaizsedz plāksnīti');
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    ok(/id="testSpeed"/.test(html) && /class="speedo-unit"/.test(html) && /speedlimit\.js\?v=\d+/.test(html));
  });
}

// ---------- F9: ziņas nav paslēptas aiz atvērta loga ----------
{
  const ui = fs.readFileSync(path.join(__dirname, '..', 'rides-ui.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
  const fnOf = (src, name) => { const i = src.indexOf('function ' + name + '('); return i < 0 ? '' : src.slice(i, src.indexOf('\n}\n', i)); };
  test('F9: maksājumu kartītēs (connect / checkout) kļūdas kartītē, nevis setStatus', () => {
    const drv = fnOf(ui, 'ridesPayDriverCard'), pas = fnOf(ui, 'ridesPassengerPay');
    ok(drv && !/setStatus/.test(drv), 'ridesPayDriverCard bez setStatus');
    ok(/ridesSay\('connect', msg, 'Ieraksti savu e-pastu\.'/.test(drv) && /aria-invalid/.test(drv) && /email\.focus\(\)/.test(drv), 'e-pasta kļūda pie lauka, fokuss');
    ok(/removeAttribute\('aria-invalid'\); ridesSay\('connect', msg, ''\)/.test(drv), 'sāk rakstīt — ziņa pazūd');
    ok(/Neizdevās atvērt pieslēgšanu/.test(drv) && /email, msg\);/.test(drv) && /if \(!email\) box\.append\(msg\)/.test(drv), 'ziņa zem e-pasta lauka (vai pie pogas)');
    ok(pas && !/setStatus/.test(pas) && /ridesSay\('pay:' \+ o\.id, msg, err\.message \|\| 'Neizdevās atvērt maksājumu\.'\)/.test(pas), 'maksājuma kļūda kartītē (F11)');
  });
  test('F9: ziņa kartītē saglabājas pēc loga pārzīmēšanas', () => {
    const c = {};
    const R = { cardMsg: null };
    const fakeEl = () => ({ textContent: '', className: '', hidden: true, scrollIntoView() {} });
    const say = new Function('rides', fnOf(ui, 'ridesSay') + '\n}; return ridesSay;')(R);
    const el = fakeEl();
    say('connect', el, 'Ieraksti savu e-pastu.', true, true);
    eq(el.hidden, false); eq(el.className, 'r-msg bad'); eq(R.cardMsg.connect.text, 'Ieraksti savu e-pastu.');
    say('connect', el, ''); eq(el.hidden, true); eq(R.cardMsg.connect, undefined);
  });
  test('F9: step() pogas, „Brauciens pabeigts”, publicēts, saskaņots, Stripe atgriešanās — uznirstošā ziņa', () => {
    const card = fnOf(ui, 'ridesMyOfferCard');
    ok(card && !/setStatus/.test(card), 'ridesMyOfferCard (step) bez setStatus');
    ok(/ridesToast\(rideErrorText\(err\), true\)/.test(card) && /ridesToast\('Brauciens pabeigts\. Paldies!'\)/.test(card));
    ok(/ridesToast\('Pieprasījums publicēts — šoferi to redz\.'\)/.test(ui) && /ridesToast\('Brauciens saskaņots!'\)/.test(ui));
    const ret = fnOf(ui, 'ridesPayReturn');
    ok(ret && !/setStatus/.test(ret) && ret.indexOf('ridesOpen(true)') < ret.indexOf('ridesToast(msg'), 'ridesPayReturn: logs atveras, ziņa virs tā');
    ok(/if \(rides\.open\) ridesToast\(msg\)/.test(ui), 'jaunumi atvērtā logā — uznirstoši');
    eq((ui.match(/setStatus\(/g) || []).length, 1, 'rides-ui.js: palicis tikai v91 „Paņemšu” (ziņa jau kartītē); jaunumi aizvērtam logam — czToast (v123)');
  });
  test('F9: testa slēdzis, Mapillary atslēga (vienreiz), maršruts neatrasts — czToast', () => {
    ok(/czToast\(state\.testMode \?/.test(app) && !/setStatus\(state\.testMode/.test(app), 'testa slēdzis');
    ok(/if \(!state\.mlyBadShown\) \{ state\.mlyBadShown = true; czToast\('Mapillary atslēga nav derīga/.test(app) && !/setStatus\('Mapillary atslēga/.test(app), 'Mapillary — vienreiz');
    ok(/czToast\('Maršrutu neizdevās atrast\. Pamēģini vēlreiz\.', true\)/.test(app) && !/setStatus\('Maršrutu neizdevās/.test(app));
    // F2: onGpsError un startGps ziņas tagad iet caur vienu gpsShow() izsaukumu (5 → 4)
    const left = (app.match(/setStatus\([^)]*\)/g) || []).filter(x => !/^setStatus\(text(, force = false)?\)$/.test(x));
    // A07: +2 — kartes ielādes kļūdas (MapLibre modulis neielādējās / nav WebGL2) arī ir kartes statuss
    eq(left.length, 5, 'app-gl.js: tikai kartes statuss (zīmju skaits, GPS problēma, centrēšana, karte neielādējās ×2; „GPS darbojas” vairs nerāda — v123): ' + left.join(' | '));
  });
}

// ---------- F11: „Maksāt ar karti” tikai, ja šoferis pieslēdzis maksājumus ----------
{
  const ui = fs.readFileSync(path.join(__dirname, '..', 'rides-ui.js'), 'utf8');
  const fn = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'ride-pay', 'index.ts'), 'utf8');
  const fnOf = (src, name) => { const i = src.indexOf('function ' + name + '('); return i < 0 ? '' : src.slice(i, src.indexOf('\n}\n', i)); };
  test('F11: poga paslēpta, ja šoferis nav gatavs', () => {
    const pas = fnOf(ui, 'ridesPassengerPay');
    const i = pas.indexOf('if (drvOk === false)'), j = pas.indexOf('\n', i);
    ok(i > 0, 'skaidras naudas zars');
    const branch = pas.slice(i, j);
    ok(/Šoferis pieņem tikai skaidru naudu/.test(branch) && !/ridesTestNote|r-pay-btn/.test(branch), 'skaidrā nauda — bez pogas un testa kartes teksta');
    ok(/return rEl\('div', \{ class: 'r-pay-wrap' \}, box, msg\)/.test(branch), 'ziņa (409) paliek kartītē');
    ok(pas.indexOf('if (drvOk === false)') < pas.indexOf("text: 'Maksāt ar karti'") && /Pārbaudu kartes maksājumus…/.test(pas), 'kamēr nav zināms — poga nav redzama');
    ok(/err\.status === 409 && \/Šoferis\/\.test\(err\.message \|\| ''\)\) \{ rides\.payDrvOk\[o\.id\] = false; ridesRender\(true\)/.test(pas), '409 → pārslēdzas uz skaidru naudu');
    ok(/rides\.payDrvOk = Object\.assign\(\{\}, rides\.payDrvOk, j\.drv \|\| \{\}\)/.test(fnOf(ui, 'ridesPayRefresh')), 'klients saglabā drv');
    ok(/rides\.payDrvOk = \{\}; rides\.payDrvTries = \{\}/.test(ui), 'iziešanā no konta notīra');
    const st = fn.slice(fn.indexOf("case 'status'"), fn.indexOf("case 'refund'"));
    ok(/rpc\/ride_driver_acct/.test(st) && /driverAccount\(acct\)/.test(st) && /ownerOk\(acct, a\.owner, o\.driver_id\)/.test(st), 'serveris: ride_driver_acct + Stripe gatavība + īpašnieks');
    ok(/o\.request\.user_id !== uid/.test(st) && /json\(\{ pay: out, drv,/.test(st) && !/drv\[o\.id\] = acct/.test(st), 'tikai pasažierim, tikai true/false');
  });
}

// ---------- F13: brauciena kopsavilkums, vērtējumi, ziņošana, vēsture ----------
test('F13: pēc „pabeigts” abi redz kopsavilkumu; otrreiz vērtēt nevar; vidējais; vēsture abām lomām', async () => {
  const S = G('LocalRideStore'), pending = G('rideSummaryPending'), rt = G('rideRatingText'), pt = G('ridePayText');
  const mem = { d: {}, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = v; } };
  const pas = new S(mem, 'k'); await pas.saveProfile({ name: 'Anna' });
  const drv = new S(mem, 'k'); drv.id = 'drv'; await drv.saveProfile({ name: 'Jānis', car: 'Zils VW' });
  const req = { from_lat: 56.95, from_lng: 24.10, to_lat: 56.96, to_lng: 24.20, from_name: 'Centrs', to_name: 'Āgenskalns', seats: 1, note: '' };
  const r = await pas.createRequest({ ...req, depart_at: new Date().toISOString() });
  await drv.offer(r.id, { eta_min: 3, price_cents: 450 });
  const o = (await pas.offersFor(r.id))[0];
  await pas.respond(o.id, 'accepted');
  let err = null; try { await pas.rate(o.id, 5); } catch (e) { err = e; }
  ok(err && /pabeigtu/.test(err.message), 'pirms pabeigšanas vērtēt nevar');
  await drv.driverUpdate(o.id, { trip: 'onboard' }); await drv.driverUpdate(o.id, { trip: 'done' });
  eq((await pas.myRequests()).length, 0); eq((await drv.myOffers()).length, 0, 'aktīvajos vairs nav');
  // kopsavilkums abiem
  const hp = await pas.myHistory(), hd = await drv.myHistory();
  eq(hp.length, 1); eq(hp[0].role, 'passenger'); eq(hp[0].status, 'done'); eq(hp[0].other_name, 'Jānis'); eq(hp[0].other_car, 'Zils VW'); eq(hp[0].price_cents, 450);
  eq(hd.length, 1); eq(hd[0].role, 'driver'); eq(hd[0].other_name, 'Anna'); eq(hd[0].other_id, pas.id);
  eq(pending(hp, []).length, 1, 'pasažierim kopsavilkums'); eq(pending(hd, [], 'driver').length, 1, 'šoferim kopsavilkums');
  eq(pending(hp, [o.id]).length, 0, 'aizvērts — vairs nerāda'); eq(pending(hd, [], 'passenger').length, 0, 'lomas filtrs');
  eq(pending(hp, [], null, Date.now() + 4 * 86400000).length, 0, 'pēc 3 dienām pats vairs nerāda');
  eq(pt(hp[0]), 'Skaidrā naudā vai nav samaksāts'); eq(pt(hp[0], { paid: true }), 'Samaksāts ar karti');
  ok(/^↩ Atmaksāts 4,50/.test(pt({ ...hp[0], pay_status: 'refunded', refund_cents: 450 })), pt({ ...hp[0], pay_status: 'refunded', refund_cents: 450 }));
  // vērtējumi
  await pas.rate(o.id, 5, '  Lielisks šoferis ');
  err = null; try { await pas.rate(o.id, 1); } catch (e) { err = e; }
  ok(err && err.code === 'duplicate', 'atkārtots vērtējums noraidīts');
  err = null; try { await drv.rate(o.id, 9); } catch (e) { err = e; }
  ok(err && /1 līdz 5/.test(err.message), 'zvaigznes 1–5');
  await drv.rate(o.id, 4);
  const stranger = new S(mem, 'k'); stranger.id = 'x';
  err = null; try { await stranger.rate(o.id, 1); } catch (e) { err = e; }
  ok(err && /dalībnieks/.test(err.message), 'svešais vērtēt nevar');
  eq((await pas.myRating(o.id)).comment, 'Lielisks šoferis');
  const hp2 = await pas.myHistory();
  eq(hp2[0].my_stars, 5); eq(pending(hp2, []).length, 0, 'novērtēts — kopsavilkums vairs nav jārāda');
  // otrs brauciens ar to pašu šoferi → vidējais
  const r2 = await pas.createRequest({ ...req, depart_at: new Date(Date.now() + 60000).toISOString() });
  await drv.offer(r2.id, { eta_min: 2 }); const o2 = (await pas.offersFor(r2.id))[0];
  await pas.respond(o2.id, 'accepted'); await drv.driverUpdate(o2.id, { trip: 'onboard' }); await drv.driverUpdate(o2.id, { trip: 'done' });
  await pas.rate(o2.id, 4);
  const sum = await pas.ratingSummary(['drv', pas.id, 'nav']);
  eq(sum.drv.avg, 4.5); eq(sum.drv.count, 2); eq(sum.drv.rides, 2); eq(sum[pas.id].avg, 4); eq(sum.nav.count, 0);
  eq(rt(sum.drv), '★ 4,5 · 2 braucieni'); eq(rt({ avg: 4.66, count: 12, rides: 21 }), '★ 4,7 · 21 brauciens'); eq(rt(null), 'Vēl nav vērtējumu'); eq(rt(sum.nav), 'Vēl nav vērtējumu');
  // atcelts brauciens: vēsturē abām lomām kā „atcelts”, vērtēt nevar, ziņot var
  const r3 = await pas.createRequest({ ...req, depart_at: new Date(Date.now() + 120000).toISOString() });
  await drv.offer(r3.id, { eta_min: 2 }); const o3 = (await pas.offersFor(r3.id))[0];
  await pas.respond(o3.id, 'accepted'); await drv.cancelOffer(o3.id);
  await pas.setRequestStatus(r3.id, 'cancelled');
  const r4 = await pas.createRequest({ ...req, depart_at: new Date(Date.now() + 180000).toISOString() });
  await pas.setRequestStatus(r4.id, 'cancelled');
  const hp3 = await pas.myHistory(), hd3 = await drv.myHistory();
  eq(hp3.map(h => h.status).join(), 'cancelled,cancelled,done,done', 'jaunākie augšā'); eq(hp3[0].offer_id, null, 'neviens nepieņēma');
  eq(hd3.map(h => h.role + ':' + h.status).join(), 'driver:cancelled,driver:done,driver:done');
  err = null; try { await pas.rate(o3.id, 1); } catch (e) { err = e; }
  ok(err && /pabeigtu/.test(err.message), 'atceltu nevērtē');
  await pas.reportUser(o3.id, 'no_show', 'Neatbrauca');
  ok((await pas.myHistory()).find(h => h.offer_id === o3.id).reported, 'ziņojums saglabājies');
  err = null; try { await pas.reportUser(o3.id, 'nezinams'); } catch (e) { err = e; }
  ok(err && /iemeslu/.test(err.message));
  err = null; try { await stranger.reportUser(o3.id, 'other'); } catch (e) { err = e; }
  ok(err && /dalībnieks/.test(err.message), 'svešais ziņot nevar');
});

test('F13: UI — kopsavilkums, vēsture, ziņas kartītē (nevis statusa joslā), SQL drošība', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'rides-ui.js'), 'utf8');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'rides-9-ratings.sql'), 'utf8');
  const fnOf = (src, name) => { const i = src.indexOf('function ' + name + '('); return i < 0 ? '' : src.slice(i, src.indexOf('\n}\n', i)); };
  for (const f of ['ridesSummaryCard', 'ridesRateForm', 'ridesReportForm', 'ridesHistoryView', 'ridesHistoryLoad']) {
    ok(fnOf(ui, f), f); ok(!/setStatus\(/.test(fnOf(ui, f)), f + ' — bez setStatus');
  }
  ok(/rideSummaryPending\(rides\.history, rides\.summarySeen, 'passenger'\)/.test(fnOf(ui, 'ridesNeedView')), 'pasažierim kopsavilkums augšā');
  ok(/rideSummaryPending\(rides\.history, rides\.summarySeen, 'driver'\)/.test(fnOf(ui, 'ridesDriveView')), 'šoferim kopsavilkums augšā');
  ok(/ridesHistoryAddLocal\(rideHistoryFromOffer\(o, r, 'driver'/.test(fnOf(ui, 'ridesMyOfferCard')), 'šoferim uzreiz pēc „pabeigts”');
  ok(/'aria-label': n \+ \(n === 1 \? ' zvaigzne' : ' zvaigznes'\) \+ ' no 5'/.test(fnOf(ui, 'ridesStars')), 'zvaigznes ar aria-label');
  ok(/ridesCardMsg\('rate:'/.test(fnOf(ui, 'ridesRateForm')) && /ridesCardMsg\('report:'/.test(fnOf(ui, 'ridesReportForm')), 'ziņas kartītē');
  ok(/'cz\.rides\.summarySeen'/.test(ui) && /slice\(-50\)/.test(fnOf(ui, 'ridesSummarySeen')), 'aizvērtie localStorage');
  ok(/rides\.historyView, rides\.historyOpen/.test(fnOf(ui, 'ridesViewSig')), 'ridesViewSig ietver jauno stāvokli');
  ok(/Mani braucieni/.test(fnOf(ui, 'ridesAccountBar')), '„Mani braucieni” joslā');
  ok(/rideRatingText\(sum\)/.test(fnOf(ui, 'ridesPerson')) && /o\.driver_id\),/.test(fnOf(ui, 'ridesRequestCard')), 'vērtējums piedāvājuma kartītē');
  ok(!/create table if not exists public\.reports\b/.test(sql) && /public\.user_reports/.test(sql), 'tabula user_reports');
  ok(/unique \(offer_id, rater_id\)/.test(sql) && /check \(stars between 1 and 5\)/.test(sql) && /char_length\(comment\) <= 200/.test(sql));
  ok(/public\.is_offer_party\(offer_id\)/.test(sql), 'RLS — is_offer_party');
  ok(/new\.rated_id := pas/.test(sql) && /new\.reported_id := drv/.test(sql), 'otru pusi aizpilda triggeris');
  ok(/>= 10 then/.test(sql), '≤ 10 ziņojumi dienā');
  const claim = sql.slice(sql.indexOf('function public.account_transfer_claim'), sql.indexOf('function public.delete_my_account'));
  ok(/update ride_ratings set rater_id = me where rater_id = src/.test(claim) && /update ride_ratings set rated_id = me/.test(claim)
     && /update user_reports set reporter_id = me/.test(claim) && /update user_reports set reported_id = me/.test(claim), 'pārcelšana pārceļ vērtējumus un ziņojumus');
  ok(claim.indexOf('update ride_ratings') < claim.indexOf('delete from auth.users'), 'pirms anonīmā konta dzēšanas');
  const del = sql.slice(sql.indexOf('function public.delete_my_account'));
  ok(/delete from ride_ratings where rater_id = me or rated_id = me/.test(del) && /delete from user_reports where reporter_id = me/.test(del), 'konta dzēšana');
  ok(!/service_role/.test(sql));
});

// ---------- F2: atrašanās vieta liegta — saprotama ziņa, instrukcijas, bez tehniskā teksta ----------
{
  const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const fnOf = (src, name) => { const i = src.indexOf('function ' + name + '('); return i < 0 ? '' : src.slice(i, src.indexOf('\n}\n', i)); };
  test('F2: liegta atrašanās vieta → latviska ziņa, „Kā ieslēgt?”, ziņu nepārraksta; zīmju skaits tikai ar ?dev=1', () => {
    // ziņu teksti un kļūdu kodi (izpilda gpsKind / gpsErrorText atsevišķā kontekstā)
    const c = vm.createContext({});
    vm.runInContext(app.slice(app.indexOf('const GPS_TEXT'), app.indexOf('// Ziņa statusa joslā')), c);
    const txt = code => vm.runInContext(`gpsErrorText({ code: ${code} })`, c);
    eq(txt(1), 'Atrašanās vieta nav atļauta. Ieslēdz to pārlūka iestatījumos.');
    eq(txt(2), 'Neizdevās noteikt atrašanās vietu. Pārbaudi, vai ierīcē ir ieslēgta atrašanās vieta (GPS).');
    eq(txt(3), 'Atrašanās vietu neizdevās noteikt laikā. Mēģinām vēlreiz…');
    eq(vm.runInContext('GPS_TEXT.unsupported', c), 'Šis pārlūks neatbalsta atrašanās vietas noteikšanu.');
    // bloķēšana: setStatus bez force neko nemaina
    const el = { textContent: 'x' }, c2 = vm.createContext({ $: () => el });
    vm.runInContext(app.slice(app.indexOf('let statusLock'), app.indexOf('// F2/F6: izstrādātāja režīms')), c2);
    vm.runInContext("statusLock = true; setStatus('Zīmes: 5'); ", c2); eq(el.textContent, 'x', 'bloķēts');
    vm.runInContext("setStatus('GPS', true)", c2); eq(el.textContent, 'GPS', 'force');
    vm.runInContext("statusLock = false; setStatus('Zīmes: 5')", c2); eq(el.textContent, 'Zīmes: 5');
    const show = fnOf(app, 'gpsShow');
    ok(/statusLock = kind === 'denied' \|\| kind === 'unsupported'/.test(show) && /\$\('gpsHelpBtn'\)\.hidden = kind !== 'denied'/.test(show), 'liegts → bloķē un rāda pogu');
    ok(/if \(state\.nav\.active \|\| !CZ_DEV\) return;/.test(fnOf(app, 'showCounts')), 'zīmju skaits tikai ?dev=1');
    ok(/gpsClear\(\)/.test(fnOf(app, 'onPosition')) && /syncBottombar\(\)/.test(fnOf(app, 'onPosition')) && !/GPS darbojas/.test(fnOf(app, 'onPosition')), 'vieta → ziņa un josla pazūd (v123: bez „GPS darbojas”)');
    ok(/kind === 'timeout' && !gpsRetryTimer/.test(fnOf(app, 'onGpsError')) && /startGps\(\)/.test(fnOf(app, 'onGpsError')), 'TIMEOUT → mēģina vēlreiz');
    const perm = fnOf(app, 'gpsWatchPermission');
    ok(/!navigator\.permissions/.test(perm) && /st\.onchange/.test(perm) && /gpsClear\(\); startGps\(\);/.test(perm) && /\.catch\(/.test(perm), 'permissions onchange (ja ir)');
    ok(/if \(gpsState === 'denied'\) \{ openGpsHelp\(\); return; \}/.test(app), 'poga „Es” liegtā stāvoklī atver instrukcijas');
    ok(/czToast\('Atrašanās vieta joprojām nav atļauta/.test(fnOf(app, 'gpsRetry')), '„Mēģināt vēlreiz” — ja joprojām liegts, czToast');
    ok(/id="gpsHelpBtn"[^>]*hidden>Kā ieslēgt\?/.test(html) && /id="gpsSheet" class="sheet/.test(html) && /id="gpsRetry"[^>]*>Mēģināt vēlreiz/.test(html), 'HTML: poga, logs');
    for (const d of ['android', 'ios', 'desktop']) ok(html.includes(`data-dev="${d}"`), 'instrukcija ' + d);
    eq(html, fs.readFileSync(path.join(__dirname, '..', 'index-gl.html'), 'utf8'), 'index.html = index-gl.html');
  });
}

// ---------- F3: meklēšanas rezultāti latviski ----------
test('F3: Photon ar lang=default; Latvijā valsti nerāda, ārzemēs — latviski; drošības tabula', () => {
  const P = require('../places.js');
  const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
  eq(P.PHOTON_LANG, 'default', 'lang=lv serveris neatbalsta (400)');
  ok(/&lang=\$\{PHOTON_LANG\}/.test(app) && /cachedJson\('photon-lv'/.test(app), 'meklēšanas pieprasījums ar lang + jauna kešatmiņa');
  ok(P.buildPhotonPlacesUrl('fuel', 56.95, 24.1, 5).includes('&lang=default'), 'vietas tuvumā arī latviski');
  const F = (props, c = [24.1, 56.95]) => P.photonSearchItem({ properties: props, geometry: { coordinates: c } });
  const tur = F({ name: 'Turība', street: 'Elijas iela', city: 'Rīga', country: 'Latvija', countrycode: 'LV' });
  eq(tur.name, 'Turība'); eq(tur.sub, 'Elijas iela, Rīga');
  const riga = F({ name: 'Rīga', country: 'Latvija', countrycode: 'LV' });
  eq(riga.name, 'Rīga'); eq(riga.sub, '', 'bez „Latvija”');
  const ogreEn = F({ name: 'Ogre', country: 'Latvia', countrycode: 'LV' });
  eq(ogreEn.sub, '', 'arī angliskā „Latvia” nerādās');
  const rigaEn = F({ name: 'Brīvības iela 1', city: 'Riga', country: 'Latvia', countrycode: 'LV' });
  eq(rigaEn.sub, 'Rīga', 'drošības tabula: Riga → Rīga');
  const tal = F({ name: 'Tallinn', country: 'Eesti', countrycode: 'EE' });
  eq(tal.sub, 'Igaunija', 'ārzemēs valsts latviski');
  eq(F({ name: 'X', country: 'Ísland', countrycode: 'IS' }).sub, 'Ísland', 'nezināma valsts — kā atnāk');
  eq(F({ street: 'Elijas iela', housenumber: '17', city: 'Rīga', countrycode: 'LV' }).name, 'Elijas iela 17');
});

// ---------- F5: pēc „Atcelt” meklēšanas lauks tukšs ----------
test('F5: cancelPreview notīra lauku, paslēpj ×, aizver ieteikumus, nesāk jaunu meklēšanu', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
  const i = app.indexOf('function cancelPreview('), fn = app.slice(i, app.indexOf('\n}\n', i));
  ok(/\$\('searchInput'\)\.value = ''; \$\('clearSearch'\)\.hidden = true; \$\('results'\)\.hidden = true;/.test(fn), 'lauks, ×, saraksts');
  ok(/clearTimeout\(searchTimer\); searchSeq\+\+; lastResults = \[\];/.test(fn), 'gaidošā / nepabeigtā meklēšana atcelta');
  ok(/state\.nav\.dest = null/.test(fn), 'galamērķis notīrīts');
  ok(!/runSearch|searchPhoton|dispatchEvent/.test(fn), 'jauns pieprasījums netiek sūtīts');
  eq((app.match(/cancelPreview\(\)/g) || []).length, 2, 'izsauc tikai × un „Atcelt” (navigācijas sākšana to neizsauc)');
  ok(/\$\('cancelRoute'\)\.addEventListener\('click', cancelPreview\)/.test(app));
});

// ---------- F6: izstrādātāja iestatījumi paslēpti ----------
test('F6: testa režīms un Mapillary atslēga tikai izstrādātājam (?dev=1 / 7 pieskārieni), saglabājas, izslēdzot testa režīms izslēgts', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const box = html.slice(html.indexOf('<div id="devBox"'), html.indexOf('Izslēgt izstrādātāja režīmu'));
  ok(/<div id="devBox" class="dev-box" hidden>/.test(html), 'bloks pēc noklusējuma paslēpts');
  ok(box.includes('id="testSwitch"') && box.includes('id="testSpeedRow"') && box.includes('id="mlyToken"'), 'abi iestatījumi blokā');
  eq((html.match(/id="testSwitch"/g) || []).length, 1); eq((html.match(/id="mlyToken"/g) || []).length, 1);
  // czDevInit: ?dev=1 saglabā, ?dev=0 dzēš, bez parametra — no localStorage
  const fnOf = n => { const i = app.indexOf('function ' + n + '('); return app.slice(i, app.indexOf('\n}\n', i) + 2); };
  const run = (search, stored, throws) => {
    const mem = { devMode: stored };
    const ls = { getItem: k => { if (throws) throw new Error('x'); return mem[k] ?? null; }, setItem: (k, v) => { if (throws) throw new Error('x'); mem[k] = v; }, removeItem: k => { delete mem[k]; } };
    const c = vm.createContext({ location: { search }, localStorage: ls });
    vm.runInContext(fnOf('czDevInit'), c);
    return [vm.runInContext('czDevInit()', c), mem.devMode ?? null];
  };
  eq(JSON.stringify(run('', undefined)), '[false,null]', 'parasti — izslēgts');
  eq(JSON.stringify(run('?dev=1', undefined)), '[true,"1"]', '?dev=1 ieslēdz un saglabā');
  eq(JSON.stringify(run('', '1')), '[true,"1"]', 'pēc pārlādes bez parametra — joprojām ieslēgts');
  eq(JSON.stringify(run('?x=1&dev=0', '1')), '[false,null]', '?dev=0 izslēdz');
  eq(JSON.stringify(run('?dev=1', undefined, true)), '[true,null]', 'localStorage kļūda — nesalūzt');
  // 7 pieskārieni 3 s laikā; 6 — nekas
  const tapsSrc = fnOf('wireDevTaps');
  const tap = (n, gap) => { let handler, on = 0, t = 0; const c = vm.createContext({ $: () => ({ addEventListener: (e, h) => { handler = h; } }), Date: { now: () => t }, setDevMode: () => { on++; }, get CZ_DEV() { return false; } });
    vm.runInContext(tapsSrc, c); vm.runInContext('wireDevTaps()', c); for (let i = 0; i < n; i++) { t += gap; handler(); } return on; };
  eq(tap(7, 300), 1, '7 ātri pieskārieni → ieslēdz'); eq(tap(6, 300), 0, '6 → nekas'); eq(tap(7, 600), 0, 'pārāk lēni (>3 s) → nekas');
  const apply = fnOf('applyDevMode');
  ok(/\$\('devBox'\)\.hidden = !CZ_DEV/.test(apply) && /state\.testMode = false; \$\('testSwitch'\)\.checked = false; stopSimulation\(\)/.test(apply), 'izslēdzot — testa režīms izslēgts');
  ok(/czToast\(on \? 'Izstrādātāja režīms ieslēgts'/.test(fnOf('setDevMode')) && /localStorage\.removeItem\('devMode'\)/.test(fnOf('setDevMode')), 'paziņojums, saglabāšana');
  ok(/\$\('testSwitch'\)\.checked = state\.testMode;/.test(app), 'testa režīms nesākas ieslēgts');
  ok(/mlyToken: store\.get\('mlyToken', ''\) \|\| mlyPublicToken\(\)/.test(app), 'Mapillary atslēga — kā līdz šim (paslēpta, bet lietota)');
});

// ---------- F12: šoferis redz, ka piedāvājums noraidīts ----------
test('F12: noraidīts / cits šoferis izvēlēts → kartīte 10 min ar „Labi”; SQL responded_at', async () => {
  const S = G('LocalRideStore'), recent = G('rideDeclinedRecent'), txt = G('rideDeclinedText');
  const mem = { d: {}, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = v; } };
  const pas = new S(mem, 'k'); await pas.saveProfile({ name: 'Anna' });
  const d1 = new S(mem, 'k'); d1.id = 'd1'; await d1.saveProfile({ name: 'Jānis' });
  const d2 = new S(mem, 'k'); d2.id = 'd2'; await d2.saveProfile({ name: 'Pēteris' });
  const d3 = new S(mem, 'k'); d3.id = 'd3'; await d3.saveProfile({ name: 'Ilze' });
  const req = { from_lat: 56.95, from_lng: 24.1, to_lat: 56.96, to_lng: 24.2, from_name: 'A', to_name: 'B', seats: 1, note: '', depart_at: new Date().toISOString() };
  const r = await pas.createRequest(req);
  await d1.offer(r.id, { eta_min: 3 }); await d2.offer(r.id, { eta_min: 4 }); await d3.offer(r.id, { eta_min: 5 });
  const offs = await pas.offersFor(r.id);
  await pas.respond(offs.find(o => o.driver_id === 'd3').id, 'declined');               // tieši noraidīts
  await pas.respond(offs.find(o => o.driver_id === 'd2').id, 'accepted');               // izvēlas citu → d1 noraidīts automātiski
  const m1 = await d1.myOffers(), m3 = await d3.myOffers();
  eq(m1.length, 1, 'noraidītais vēl šofera sarakstā'); eq(m1[0].status, 'declined'); ok(m1[0].responded_at, 'laiks');
  eq(m3[0].status, 'declined');
  const now = Date.parse(m1[0].responded_at);
  eq(recent(m1, [], {}, now + 60000).length, 1, 'redzams'); eq(recent(m1, [], {}, now + 11 * 60000).length, 0, 'pēc 10 min pazūd');
  eq(recent(m1, [m1[0].id], {}, now + 60000).length, 0, '„Labi” → pazūd');
  eq(recent([{ id: 'x', status: 'declined' }], [], {}, now).length, 0, 'bez laika (veci) — nerāda');
  eq(recent([{ id: 'x', status: 'declined' }], [], { x: now - 5000 }, now).length, 1, 'lietotne pamanīja pāreju — rāda');
  eq(recent([{ id: 'p', status: 'pending', responded_at: m1[0].responded_at }], [], {}, now).length, 0);
  eq(txt(m1[0]), 'Pasažieris izvēlējās citu šoferi'); eq(txt({ request: { status: 'cancelled' } }), 'Pasažieris atsauca braucienu');
  eq((await d2.myOffers())[0].status, 'accepted', 'izvēlētais šoferis — kā līdz šim');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'rides-ui.js'), 'utf8');
  const fnOf = n => { const i = ui.indexOf('function ' + n + '('); return ui.slice(i, ui.indexOf('\n}\n', i)); };
  const card = fnOf('ridesDeclinedCard');
  ok(/r-card r-declined/.test(card) && /text: 'Labi'/.test(card) && /rideDeclinedText\(o\)/.test(card) && !/setStatus|ridesChatBtn|cancelOffer/.test(card), 'kartīte: teksts + tikai „Labi”');
  ok(/'cz\.rides\.declOk'/.test(fnOf('ridesDeclinedOk')) && /try \{ localStorage\.setItem/.test(fnOf('ridesDeclinedOk')), '„Labi” — localStorage');
  ok(/for \(const o of declined\) wrap\.append\(ridesDeclinedCard\(o\)\)/.test(fnOf('ridesDriveView')), 'šofera sarakstā');
  ok(/ridesDeclinedList\(\)\.map\(o => o\.id\)/.test(fnOf('ridesViewSig')), 'pārzīmē, kad pazūd');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'rides-10-declined.sql'), 'utf8');
  ok(/add column if not exists responded_at timestamptz/.test(sql) && /new\.status in \('accepted', 'declined'\)/.test(sql) && /new\.responded_at := old\.responded_at/.test(sql), 'SQL: laiku liek datubāze');
});

// ---------- F16: statistika ----------
test('F16: LocalRideStore.myStats — lomas, atceltie, tukšs konts', async () => {
  const S = G('LocalRideStore'), empty = G('rideStatsEmpty');
  const mem = { d: {}, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = v; } };
  const pas = new S(mem, 'k'); await pas.saveProfile({ name: 'Anna' });
  const drv = new S(mem, 'k'); drv.id = 'drv'; await drv.saveProfile({ name: 'Jānis' });
  const st0 = await pas.myStats();
  ok(empty(st0), 'tukšs konts'); eq(st0.driver_done + st0.passenger_done + st0.km_approx + st0.carried, 0, 'nulles');
  const req = { from_lat: 56.95, from_lng: 24.10, to_lat: 56.95, to_lng: 24.20, from_name: 'A', to_name: 'B', seats: 2, note: '', depart_at: new Date().toISOString() };
  const r = await pas.createRequest(req); await drv.offer(r.id, { eta_min: 3 });
  const o = (await pas.offersFor(r.id))[0]; await pas.respond(o.id, 'accepted'); await drv.driverUpdate(o.id, { trip: 'onboard' }); await drv.driverUpdate(o.id, { trip: 'done' });
  const r2 = await pas.createRequest({ ...req, seats: 1 }); await drv.offer(r2.id, { eta_min: 3 });
  const o2 = (await pas.offersFor(r2.id))[0]; await pas.respond(o2.id, 'accepted'); await drv.cancelOffer(o2.id);
  const sp = await pas.myStats(), sd = await drv.myStats();
  eq(sp.passenger_done, 1, 'pasažierim pabeigts'); eq(sp.driver_done, 0); eq(sp.passenger_cancelled, 1, 'atcelts atsevišķi');
  eq(sd.driver_done, 1, 'šoferim pabeigts'); eq(sd.passenger_done, 0); eq(sd.driver_cancelled, 1); eq(sd.carried, 2, 'pārvesti 2 cilvēki');
  ok(sd.km_approx >= 7 && sd.km_approx <= 10, 'aptuveni km ' + sd.km_approx); ok(!empty(sd));
  eq(await pas.isAdmin(), false, 'demo — admin nav');
});
test('F16: UI, SQL un ride-pay — īpašnieks tikai pēc servera pārbaudes', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'rides-ui.js'), 'utf8');
  const fnOf = n => { const i = ui.indexOf('function ' + n + '('); return ui.slice(i, ui.indexOf('\n}\n', i)); };
  ok(/rides\.isAdmin \? rEl\('button'[^)]*'Statistika \(īpašniekam\)'/.test(ui), 'admin poga tikai ar rides.isAdmin');
  ok(/rides\.isAdmin = rides\.store\.isAdmin \? await rides\.store\.isAdmin\(\) : false/.test(ui), 'isAdmin no servera');
  ok(/text: 'Mana statistika', onclick: ridesOpenStats/.test(fnOf('ridesAccountBar')), '„Mana statistika” konta joslā');
  for (const f of ['ridesMyStatsView', 'ridesAdminView', 'ridesOpenStats', 'ridesOpenAdmin']) ok(fnOf(f) && !/setStatus/.test(fnOf(f)), f + ' bez setStatus');
  ok(/r-msg bad/.test(fnOf('ridesMyStatsView')) && /r-msg bad/.test(fnOf('ridesAdminView')), 'kļūda logā');
  ok(/Vēl nav braucienu\./.test(fnOf('ridesMyStatsView')) && /aptuveni/.test(fnOf('ridesMyStatsView')), 'tukšs / aptuveni');
  ok(/Komisija \(aptuveni/.test(fnOf('ridesAdminView')), 'aptuvenā komisija, ja Stripe nav');
  ok(/rides\.statsView, rides\.myStats/.test(fnOf('ridesViewSig')), 'ridesViewSig');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'stats-f16.sql'), 'utf8');
  const fn = name => { const i = sql.indexOf('function public.' + name + '('); return sql.slice(i, sql.indexOf('$$;', sql.indexOf('$$', i) + 2)); };
  ok(/if not is_app_admin\(\) then raise exception 'forbidden'/.test(fn('admin_stats')), 'admin_stats pārbauda is_app_admin');
  ok(/revoke all on function public\.admin_stats\(\) from public, anon;/.test(sql) && /revoke all on function public\.my_stats\(\) from public, anon;/.test(sql), 'revoke no anon');
  ok(/alter table public\.app_admins enable row level security;/.test(sql) && !/create policy[^;]*app_admins/.test(sql), 'app_admins bez politikām');
  ok(/declare me uuid := auth\.uid\(\)/.test(fn('my_stats')) && /if me is null then return null;/.test(fn('my_stats')), 'my_stats — auth.uid()');
  ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(sql.replace("'[TAVS E-PASTS]'", '')), 'repozitorijā nav e-pasta');
  ok(/delete from user_stat_counters where user_id = me;/.test(fn('delete_my_account')) && /insert into user_stat_counters \(user_id, kind, n\) select me, kind, n from user_stat_counters where user_id = src/.test(fn('account_transfer_claim')), 'dzēšana / pārcelšana');
  ok(/if n >= 10 then raise exception 'rate_limit'/.test(fn('report_create')) && /if n >= 60 then raise exception 'vote_limit'/.test(fn('report_vote')) && /q\.n \+ cnt > 1500/.test(fn('traffic_report')), 'limiti nemainīti');
  ok(/prev is distinct from 'still'/.test(fn('report_vote')), 'atkārtots „vēl ir” neskaitās');
  const rp = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'ride-pay', 'index.ts'), 'utf8');
  const c = rp.slice(rp.indexOf("case 'admin_stats'"), rp.indexOf("case 'refund_sync'"));
  ok(c.indexOf("rpc/is_app_admin") > 0 && c.indexOf("rpc/is_app_admin") < c.indexOf("stripe('application_fees"), 'ride-pay: is_app_admin pirms Stripe');
  ok(/if \(isAdmin !== true\) throw new Fail\('Nav piekļuves', 403\)/.test(c), '403');
});

// ---------- F17: maksājuma statusu raksta tikai ride-pay ----------
test('F17: ride_payment_mark — tikai service_role, lietotājs no JWT, pārlūks nesauc', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'rides-11-paymark.sql'), 'utf8');
  const fn = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'ride-pay', 'index.ts'), 'utf8');
  ok(/drop function if exists public\.ride_payment_mark\(uuid, text, text, text, int\);/.test(sql), 'vecā funkcija dzēsta');
  ok(/function public\.ride_payment_mark\(p_user_id uuid, oid uuid,/.test(sql), 'lietotāja ID parametrā');
  ok(/security definer set search_path = public, pg_temp/.test(sql), 'search_path');
  ok(!/auth\.uid\(\)/.test(sql.slice(sql.indexOf('create or replace function public.ride_payment_mark'), sql.indexOf('revoke all'))), 'neizmanto auth.uid()');
  ok(/o\.driver_id = p_user_id or r\.user_id = p_user_id/.test(sql), 'pārbauda dalībnieku');
  ok(/revoke all on function public\.ride_payment_mark\(uuid, uuid, text, text, text, int\) from public, anon, authenticated;/.test(sql) &&
     /grant execute on function public\.ride_payment_mark\(uuid, uuid, text, text, text, int\) to service_role;/.test(sql), 'tikai service_role');
  ok(/old\.status = 'paid' and new\.session_id is distinct from old\.session_id/.test(sql), 'samaksātai rindai sesiju nemaina');
  const m = fn.slice(fn.indexOf('const mark = '), fn.indexOf('// ---------- Atmaksa (F14)'));
  const mp = fn.slice(fn.indexOf('async function markPay'), fn.indexOf('const SYNC_MAX'));
  ok(/markPay\(uid, oid,/.test(m) && /sdb\('rpc\/ride_payment_mark'/.test(mp) && /p_user_id: userId/.test(mp) && /apikey: SRK/.test(fn.slice(fn.indexOf('async function sdb'))), 'mark — servisa atslēga + uid no JWT');
  ok(/const uid: string = \(await ur\.json\(\)\)\.id;/.test(fn) && /'\/auth\/v1\/user'/.test(fn), 'uid no /auth/v1/user');
  ok(!/[^s]db\('rpc\/ride_payment_mark'/.test(fn), 'ar lietotāja JWT nesauc');
  ok(!/json\([^)]*SRK/.test(fn) && (fn.match(/SRK/g) || []).length <= 6, 'atslēga atbildē nenonāk');
  ok(/if \(i\.paid && r\.status === 'created'\) await mark\(r\.offer_id, 'paid'\)/.test(fn), 'paid tikai pēc Stripe');
  ok(/if \(r\.status === 'failed' \|\| r\.status === 'canceled'\)[\s\S]{0,700}if \(st2\.full\) await mark\(oid, 'refunded', r\.id/.test(fn), 'refunded tikai pēc veiksmīgas un pilnas atmaksas (A05)');
  for (const f of fs.readdirSync(path.join(__dirname, '..')).filter(f => /\.(js|html)$/.test(f))) {
    const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/^\s*\/\/.*$/gm, '');   // komentāri (piem. brīdinājums rides-config.js) neskaitās
    ok(!/ride_payment_mark|service_role|SERVICE_ROLE/i.test(code), f + ': nesauc / nav atslēgas');
  }
});

// ---------- F18: kartes nosaukumi latviski ----------
test('F18: kartes stila nosaukumi — name:lv / name, ceļu un māju numuri neskarti', () => {
  const b = require(path.join(__dirname, '..', 'basemap-gl.js'));
  const omt = ['case', ['has', 'name:nonlatin'], ['concat', ['get', 'name:latin'], '\n', ['get', 'name:nonlatin']], ['coalesce', ['get', 'name_en'], ['get', 'name']]];
  const mk = () => ({ layers: [
    { id: 'label_city', type: 'symbol', layout: { 'text-field': JSON.parse(JSON.stringify(omt)) } },
    { id: 'water', type: 'symbol', layout: { 'text-field': '{name_en}' } },
    { id: 'shield', type: 'symbol', layout: { 'text-field': ['to-string', ['get', 'ref']] } },
    { id: 'housenum', type: 'symbol', layout: { 'text-field': '{housenumber}' } },
    { id: 'house3d', type: 'fill-extrusion', layout: {} },
    { id: 'bg', type: 'background' },
  ] });
  for (const theme of ['colorful', 'dark', 'light']) {
    const st = b.tuneStyle(mk(), theme), L = id => st.layers.find(l => l.id === id);
    eq(JSON.stringify(L('label_city').layout['text-field']), JSON.stringify(b.LABEL_LV), theme + ': pilsēta latviski');
    eq(JSON.stringify(L('water').layout['text-field']), JSON.stringify(b.LABEL_LV), theme + ': ūdens latviski');
    eq(JSON.stringify(L('shield').layout['text-field']), JSON.stringify(['to-string', ['get', 'ref']]), theme + ': ceļa numurs neskarts');
    eq(L('housenum').layout['text-field'], '{housenumber}', theme + ': mājas numurs neskarts');
    ok(!L('house3d'), theme + ': bez 3D');
  }
  ok(JSON.stringify(b.LABEL_LV) === JSON.stringify(['coalesce', ['get', 'name:lv'], ['get', 'name'], ['get', 'name:latin'], ['get', 'name_en']]), 'secība name:lv → name → latin → en');
  const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
  ok((app.match(/await loadBasemapStyle\(/g) || []).length >= 2 && /map\.setStyle\(bm\.style/.test(app), 'katra stila maiņa iet caur loadBasemapStyle → tuneStyle');
});

// ---------- v121: kartes stili — tikai tumšā (T1) un gaišā (G1); spraudas zīmes ----------
test('v121: divi kartes stili, zīmes pēc stila, spraudas smaile notikuma vietā', () => {
  const b = require(path.join(__dirname, '..', 'basemap-gl.js'));
  eq(Object.keys(b.BASEMAP_STYLES).join(), 'dark,light', 'tikai Tumša un Vienkārša gaiša');
  eq(b.BASEMAP_STYLES.dark.label, 'Tumša'); eq(b.BASEMAP_STYLES.light.label, 'Vienkārša gaiša');
  for (const old of ['auto', 'colorful', 'classic', undefined, 'xyz']) {
    eq(b.normBasemap(old, true), 'dark', String(old) + ' → tumšā (tumšs sistēmas režīms)');
    eq(b.normBasemap(old, false), 'light', String(old) + ' → gaišā');
  }
  eq(b.normBasemap('dark', false), 'dark'); eq(b.normBasemap('light', true), 'light');
  const A = require(path.join(__dirname, '..', 'alerts.js'));
  for (const type of Object.keys(A.ALERT_TYPES)) {
    const d = A.alertSvg(type, 144, 'dark'), l = A.alertSvg(type, 144, 'light');
    ok(d !== l, type + ': tumšais un gaišais atšķiras');
    if (type === 'rail') {   // v144: St Andrew's cross, standalone (no pin), centred at (32, 26)
      ok(/viewBox="-4 -10 72 72"/.test(d) && /translate\(32 26\)/.test(d) && !/32 61/.test(d), 'rail: Andreja krusts bez spraudas, centrā');
      ok(A.ALERT_STANDALONE.has('rail') && A.ALERT_STANDALONE_ICONS.includes('alert:rail'), 'rail: enkurs centrā (standalone)');
      const sgr = fs.readFileSync(path.join(__dirname, '..', 'signs-gl.js'), 'utf8');
      ok(/'icon-anchor': \['case', \['in', \['get', 'icon'\], \['literal', \['alert:traffic-light', 'alert:rail'\]\]\], 'center'/.test(sgr), 'rail: zīmju slānī enkurs centrā');
    } else if (type !== 'traffic-light') {
      ok(/viewBox="-4 -10 72 72"/.test(d) && /viewBox="-4 -10 72 72"/.test(l), type + ': vienāds laukums');
      ok(/32 61/.test(d) && /32 61/.test(l), type + ': smaile līdz (32, 61)');
    }
  }
  for (const t of ['police', 'police-hidden']) ok(A.alertSvg(t, 64, 'light').includes('M32 2.5l20 6.8'), t + ': vairogs');
  // v138: radars are an eye — red iris on the dark map, blue on the light map; tip still at (32, 61)
  for (const t of ['camera-fixed', 'camera-mobile']) {
    const d = A.alertSvg(t, 64, 'dark'), l = A.alertSvg(t, 64, 'light');
    ok(d.includes('M8 52Q50 10 92 52Q50 94 8 52Z') && !d.includes('M18 3h28'), t + ': acs, ne ceļazīme');
    ok(d.includes('fill="#e2303a"') && !d.includes('fill="#2f7be0"'), t + ': tumšajā — sarkanā acs');
    ok(l.includes('fill="#2f7be0"') && !l.includes('fill="#e2303a"'), t + ': gaišajā — zilā acs');
    ok(/translate\(32 24\.5\)/.test(d) && /32 61/.test(d), t + ': centrs (32; 24,5) — riņķi ap aci; smaile (32, 61)');
  }
  // v139: road works = worker with orange hard hat + sunglasses inside the round pin
  for (const th of ['dark', 'light']) {
    const r = A.alertSvg('roadworks', 64, th);
    ok(/clip-path="url\(#rwc\)"/.test(r) && r.includes('M24 40C24 20 36 10 50 10') && r.includes('#ffa53a') && r.includes('M31 48h38'), th + ': ceļa darbi — strādnieks ar oranžu ķiveri un brillēm');
    ok(/32 61/.test(r) && r.includes('cx="32" cy="28" r="23"') && r.includes('M29.8 48L32 61'), th + ': v140 — lielāks aplis, īsāka adata; smaile vietā');
  }
  for (const f of ['index.html', 'index-gl.html']) ok(/alerts\.js\?v=14\d/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')), f + ': alerts.js ≥ v140');
  // v141: traffic lights half size — the traffic-light check must come BEFORE ['has', 'pin'] (alerts mode: all signs have pin)
  const sg141 = fs.readFileSync(path.join(__dirname, '..', 'signs-gl.js'), 'utf8');
  const sfn = new Function(sg141.slice(sg141.indexOf('const TRAFFIC_LIGHT_SCALE'), sg141.indexOf('\n}', sg141.indexOf('function signsIconSize')) + 2) + '; return signsIconSize;')();
  const ev = (e, props) => {           // tiny evaluator for case / == / get / has / match
    if (!Array.isArray(e)) return e;
    const [op, ...a] = e;
    if (op === 'get') return props[a[0]];
    if (op === 'has') return a[0] in props;
    if (op === '==') return ev(a[0], props) === ev(a[1], props);
    if (op === 'case') { for (let i = 0; i + 1 < a.length; i += 2) if (ev(a[i], props)) return ev(a[i + 1], props); return ev(a[a.length - 1], props); }
    if (op === 'match') { const v = ev(a[0], props); for (let i = 1; i + 1 < a.length; i += 2) if (a[i] === v) return ev(a[i + 1], props); return ev(a[a.length - 1], props); }
    throw new Error(op);
  };
  const e16 = sfn(1)[6];              // stop at zoom 16
  eq(ev(e16, { icon: 'alert:traffic-light', pin: 1 }), 0.5, 'brīdinājumu režīmā luksofors — puse no spraudas izmēra');
  eq(ev(e16, { icon: 'alert:police', pin: 1 }), 1, 'citas spraudas — nemainītas');
  eq(ev(e16, { icon: 'alert:traffic-light', rel: 'mine' }), 0.475, 'zīmju režīmā luksofors — uz pusi mazāks');
  eq(ev(e16, { icon: 'x', rel: 'mine' }), 0.95, 'citas zīmes — nemainītas');
  const ap141 = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
  const afn = new Function('const TRAFFIC_LIGHT_SCALE = 0.5;' + ap141.slice(ap141.indexOf('function alertIconSize'), ap141.indexOf('\n}', ap141.indexOf('function alertIconSize')) + 2) + '; return alertIconSize;')();
  eq(ev(afn(1)[6], { icon: 'alert:traffic-light' }), 0.5, 'alerts slānī luksofors arī uz pusi mazāks');
  for (const f of ['index.html', 'index-gl.html']) {
    const h = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    ok(/signs-gl\.js\?v=(14[1-9]|1[5-9]\d)/.test(h) && /app-gl\.js\?v=(14[1-9]|1[5-9]\d)/.test(h), f + ': v141');
    ok(/app-gl\.js\?v=(14[3-9]|1[5-9]\d)/.test(h), f + ': v143');
    ok(/alerts\.js\?v=144/.test(h) && /signs-gl\.js\?v=(14[4-9]|1[5-9]\d)/.test(h) && /app-gl\.js\?v=(14[4-9]|1[5-9]\d)/.test(h), f + ': v144');
    ok(/signs-gl\.js\?v=(14[5-9]|1[5-9]\d)/.test(h) && /app-gl\.js\?v=(14[5-9]|1[5-9]\d)/.test(h), f + ': v145');
  }
  {
    // v145: traffic restrictions hidden from the map (alerts mode), still in the data for the "next ahead" card
    const sg145 = fs.readFileSync(path.join(__dirname, '..', 'signs-gl.js'), 'utf8');
    ok(/if \(this\.hideOnMap\) for \(let i = list\.length - 1; i >= 0; i--\) if \(this\.hideOnMap\(list\[i\]\.s\)\) list\.splice\(i, 1\);/.test(sg145) &&
       sg145.indexOf('this.hideOnMap(list[i].s)') < sg145.indexOf('src.setData({\n      type: \'FeatureCollection\',\n      features: list.map'), 'v145: paslēptās zīmes nenonāk kartes slānī (arī punktos)');
    const ap145 = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
    ok(/signs\.hideOnMap = s => alertTypeForSign\(s\) === 'restriction';/.test(ap145) && /signs\.hideOnMap = null;/.test(ap145), 'v145: brīdinājumu režīmā ierobežojumi kartē nerādās');
    ok(/t === 'restriction' \? describeRestriction/.test(ap145), 'v145: kartīte „pēc N m” ierobežojumu joprojām rāda');
  }
  {
    // v146: Android app (Capacitor) — native background GPS; in the browser nothing changes
    const ap146 = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
    const grab = name => ap146.slice(ap146.indexOf('function ' + name), ap146.indexOf('\n}', ap146.indexOf('function ' + name)) + 2);
    const nativeGeo = new Function('window', grab('nativeGeo') + '; return nativeGeo;');
    eq(nativeGeo(undefined)(), null, 'pārlūkā (nav Capacitor) — parastais GPS');
    eq(nativeGeo({ Capacitor: { isNativePlatform: () => false, registerPlugin: () => ({}) } })(), null, 'Capacitor tīmeklī — parastais GPS');
    const plug = {}; let asked = null;
    eq(nativeGeo({ Capacitor: { isNativePlatform: () => true, registerPlugin: n => { asked = n; return plug; } } })(), plug, 'Android lietotnē — telefona GPS');
    eq(asked, 'BackgroundGeolocation');
    const toPos = new Function(grab('nativeLocToPos') + '; return nativeLocToPos;')();
    const p = toPos({ latitude: 56.95, longitude: 24.1, accuracy: 6, speed: 13.9, bearing: 270, altitude: 10, time: 123 });
    ok(p.coords.latitude === 56.95 && p.coords.longitude === 24.1 && p.coords.speed === 13.9 && p.coords.heading === 270 && p.coords.accuracy === 6 && p.timestamp === 123, 'telefona vieta → tas pats formāts kā pārlūkā');
    ok(/const BG = nativeGeo\(\);\n  if \(BG\) return startNativeGps\(BG, onDenied\);/.test(ap146), 'startGps lieto telefona GPS, ja ir');
    ok(/backgroundMessage: 'Navigācija un brīdinājumi darbojas arī ar izslēgtu ekrānu\.'/.test(ap146), 'GPS arī ar izslēgtu ekrānu (paziņojums latviski)');
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mobile', 'capacitor.config.json'), 'utf8'));
    ok(cfg.server.url === 'https://growlab.cc' && cfg.android.useLegacyBridge === true && cfg.appId === 'cc.growlab.celazimes', 'Android lietotne atver growlab.cc; fonā neapstājas pēc 5 min');
    const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'android.yml'), 'utf8');
    ok(/tag_name: android-test/.test(wf) && /files: mobile\/cela-zimes\.apk/.test(wf) && /assembleDebug/.test(wf), 'GitHub pats uzbūvē APK un ieliek to lapā android-test');
    const ps = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'scripts', 'patch-android.js'), 'utf8');
    ok(/FOREGROUND_SERVICE_LOCATION/.test(ps) && /POST_NOTIFICATIONS/.test(ps) && !/ACCESS_BACKGROUND_LOCATION/.test(ps), 'atļaujas: priekšplāna serviss ar atrašanās vietu, bez „vienmēr” atļaujas');
    for (const f of ['index.html', 'index-gl.html'])
      ok(/app-gl\.js\?v=(14[6-9]|1[5-9]\d)/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')), f + ': v146');
  }
  // v142: icons ↔ dots — happens after about half the zoom-out, and the animation is twice as fast
  ok(/const MARKER_IN_ZOOM = 15\.6;/.test(ap141) && /const MARKER_OUT_ZOOM = 15\.2;/.test(ap141), 'v143: punkti parādās vēl agrāk (15,2 / 15,6)');
  ok(/zoom: driving \? \(v > 80 \? 15\.8/.test(ap141), 'v143: braucot ātri (15,8) — ikonas joprojām redzamas (slieksnis zemāk)');
  ok(/2, 3 \* r, 12, 3\.8 \* r, 60, 4\.8 \* r/.test(ap141) && /9, \['case', \['has', 'point_count'\], cl, 2\.1 \* r\]/.test(ap141), 'v143: punkti mazāki');
  ok(/'circle-radius': RZ\(9, \['case', cluster, \['interpolate', \['linear'\], \['get', 'point_count'\], 2, 7\.5, 10, 9, 40, 11\], aheadCase\(4\.6, 4\.2, 3\.6\)\]/.test(ap141), 'v143: radaru punkti — tāda paša izmēra');
  ok(/pop: \{ ms: 170,/.test(ap141) && /morph: \{ ms: 280,/.test(ap141), 'v142: pāreja 2× ātrāka (170 / 280 ms)');
  ok(/const RADAR_ICON_FROM = 14\.6, RADAR_ICON_FULL = 15\.6;/.test(ap141) && /coreFade = v => RZ\(RADAR_ICON_FROM \+ 0\.7, v, RADAR_ICON_FULL \+ 0\.3, 0\)/.test(ap141), 'v142: radari pāriet tajā pašā attālumā');
  for (const t of Object.keys(A.ALERT_SPECIAL)) ok(!/r="33"/.test(A.alertSvg(t, 64, 'dark')), t + ': attēlā nekustīgu gredzenu nav (tie kustas atsevišķā slānī)');
  ok(A.alertSvg('accident', 64, 'dark').includes('fill="#0a0f17"') && A.alertSvg('accident', 64, 'light').includes('<circle cx="32" cy="25" r="21" fill="#fff"'), 'T1 tumša mala, G1 balta mala');
  A.setAlertTheme('dark'); const ud = A.alertDataUrl('jam'); A.setAlertTheme('light'); const ul = A.alertDataUrl('jam');
  ok(ud !== ul, 'kešatmiņa atsevišķi katram stilam');
  eq(A.ALERT_ICON_ANCHOR, 'bottom'); eq(JSON.stringify(A.ALERT_ICON_OFFSET), '[0,0.5]');
  const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8'), sg = fs.readFileSync(path.join(__dirname, '..', 'signs-gl.js'), 'utf8');
  ok(!/bottom-left|-5\.5, 4\.75/.test(app + sg), 'vecais burbuļa enkurs vairs netiek lietots');
  ok((app.match(/setAlertTheme\(bm\.theme === 'dark'/g) || []).length === 2, 'zīmju stils mainās kopā ar kartes stilu (starts un maiņa)');
  ok(/normBasemap\(store\.get\('basemap'/.test(app), 'agrākā izvēle pārvēršas par tumšo / gaišo');
  // v121b: kustīgi gredzeni ap policiju un radariem
  ok(/installPulseLayer\(\);/.test(app) && /function pulseAnimate\(/.test(app), 'gredzenu slānis un animācija');
  ok(/prefers-reduced-motion: reduce/.test(app) && /if \(pulse\.raf \|\| pulseStill\(\)/.test(app), 'samazināta kustība — gredzeni stāv');
  ok(/it\.type === 'police' \|\| it\.type === 'police-hidden'/.test(app) && /kind: 'camera'/.test(app), 'gredzeni policijai un radariem, citām zīmēm nav');
  ok(/PULSE_HEAD_PX = 18\.25/.test(app) && /'circle-translate': tr/.test(app), 'gredzenu centrs — zīmes galvā, nevis smailē');
  ok(/document\.hidden/.test(app.slice(app.indexOf('function pulseAnimate'), app.indexOf('function pulseAnimate') + 600)), 'fonā animācija apstājas');
});

// ---------- v122: viens apaļš ātruma rādītājs, iela apakšējā joslā, „Centrēt” ----------
test('v122: apaļajā aplī mans ātrums (pārsniedzot — sarkans, pulsē), iela un „Centrēt” navigācijas joslā', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'style-gl.css'), 'utf8');
  const fn = name => { const i = app.indexOf('function ' + name + '('); return app.slice(i, app.indexOf('\n}\n', i)); };
  for (const f of ['index.html', 'index-gl.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const bar = html.slice(html.indexOf('id="bottombar"'), html.indexOf('</footer>'));
    ok(!/speedBox|km\/h/.test(bar), f + ': apakšējā joslā ātruma vairs nav');
    ok(/id="limitBadge"[^>]*>\s*<span id="speedValue"/.test(html), f + ': ātrums apaļajā aplī');
    ok((html.match(/id="speedValue"/g) || []).length === 1, f + ': tikai viens ātruma rādītājs');
    ok(/id="streetBox"/.test(bar) && /id="streetName"/.test(bar), f + ': iela joslā');
    ok(/id="recenterBtn"/.test(bar) && /Centrēt/.test(bar) && /id="recenterMeta"/.test(bar), f + ': „Centrēt” + laiks/attālums');
  }
  const ul = fn('updateLimit');
  ok(/classList\.toggle\('over', over\)/.test(ul) && /renderSpeedo\(state\.me\.speedKmh, res, over\)/.test(ul), 'pārsniedzot — klase over + spidometrs');
  ok(/\.limit-badge\.over \.speedo-limit \{ animation: speedo-warn/.test(css) && /@keyframes speedo-warn/.test(css), 'v129: zīme pulsē');
  ok(/prefers-reduced-motion: reduce\) \{ \.limit-badge\.over \.speedo-limit \{ animation: none/.test(css), 'samazināta kustība — bez animācijas');
  // iela: pašreizējais maršruta posms
  ok(/let cur = route\.steps\[0\]/.test(fs.readFileSync(path.join(__dirname, '..', 'nav.js'), 'utf8')), 'routeProgress atdod pašreizējo posmu (cur)');
  ok(/\$\('streetName'\)\.textContent = navStreetName\(p\.cur\)/.test(app), 'iela atjaunojas braucot');
  const nsn = new Function('const roadNameAt = () => "";\n' + fn('navStreetName') + '\n}\nreturn navStreetName;')();
  eq(nsn({ name: 'Kaplavas iela' }), 'Kaplavas iela'); eq(nsn({ name: '', ref: 'A2' }), 'A2'); eq(nsn({}), 'Ceļš bez nosaukuma'); eq(nsn({ name: 'Brīvības iela;Brīvības gatve' }), 'Brīvības iela');
  ok(/function roadNameAt\(/.test(app) && /transportation_name/.test(fn('roadNameAt')), 'bez nosaukuma — iela no kartes');
  // „Centrēt”: redzams tikai navigācijā, kad karte pabīdīta
  const sr = fn('syncRecenter');
  ok(/moved = nav && !state\.follow/.test(sr) && /btn\.hidden = !moved/.test(sr) && /\$\('etaBox'\)\.hidden = !nav \|\| moved/.test(sr), 'pabīdot — Centrēt; citādi iela + ierašanās laiks');
  ok(/Object\.defineProperty\(state, 'follow'/.test(app) && /if \(ch\) syncRecenter\(\)/.test(app), 'reaģē uz katru „sekot man” maiņu');
  ok(/\$\('recenterBtn'\)\.addEventListener\('click', \(\) => \{ state\.follow = true; if \(state\.me\) followCamera\(800\)/.test(app), 'Centrēt atgriež kameru pie manis');
  ok(/\$\('recenterMeta'\)\.textContent = \$\('etaMeta'\)\.textContent/.test(app), 'zem Centrēt — min · km');
});

// ---------- v123: bez „GPS darbojas” joslas; „Es” → „Centrēt”, kad karte aizvilkta ----------
test('v123: statusa josla tikai GPS problēmai; poga „Es” paslēpta, „Centrēt” parādās aizvelkot karti', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'style-gl.css'), 'utf8');
  const fn = name => { const i = app.indexOf('function ' + name + '('); return app.slice(i, app.indexOf('\n}\n', i)); };
  for (const f of ['index.html', 'index-gl.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    ok(/id="centerBtn"[^>]*hidden/.test(html), f + ': poga „Es” paslēpta');
    ok(/id="recenterPill"[^>]*hidden[\s\S]{0,600}Centrēt/.test(html), f + ': „Centrēt” poga (sākumā paslēpta)');
  }
  ok(/\.fab\[hidden\] \{ display: none/.test(css) && /\.recenter-pill\[hidden\] \{ display: none/.test(css), 'paslēptās pogas tiešām nav redzamas');
  const sb = fn('syncBottombar');
  ok(/bar\.hidden = previewing \|\| !\(state\.nav && state\.nav\.active\) && !gpsProblem/.test(sb), 'josla: navigācijā vai ar GPS problēmu');
  ok(!/GPS darbojas/.test(app), '„GPS darbojas” vairs netiek rādīts');
  ok(/syncBottombar\(\)/.test(fn('gpsShow')) && /syncBottombar\(\)/.test(fn('endNav')) && /syncBottombar\(\)/.test(fn('cancelPreview')), 'josla atjaunojas pie GPS maiņas, navigācijas beigās un atceļot maršrutu');
  const sr = fn('syncRecenter');
  ok(/pill\.hidden = nav \|\| state\.follow \|\| !state\.me \|\| document\.documentElement\.classList\.contains\('previewing'\)/.test(sr), '„Centrēt” tikai bez navigācijas, kad karte nesekot un vieta zināma');
  ok(/\$\('recenterPill'\)\.addEventListener\('click', \(\) => \{ state\.follow = true; if \(state\.me\) followCamera\(800\)/.test(app), '„Centrēt” atgriež kameru');
  ok(/map\.on\(ev, e => \{ if \(e\.originalEvent\) state\.follow = false; \}\)/.test(app), 'aizvelkot ar pirkstu — sekot izslēdzas');
});

// ---------- v124: Ziņot (5 veidi), jautājums JĀ/NĒ, Garāža, citi braucēji ----------
test('v124: ziņošanas veidi = report_types; jautājuma noteikumi (300 m, 1 km, ne pirms pagrieziena)', () => {
  const C = G('REPORT_TYPE_CONFIG'), PK = G('REPORT_PICKER'), T = G('ALERT_TYPES'), block = G('reportAskBlock');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'coins-1.sql'), 'utf8');
  eq(PK.join(), 'police,camera-mobile,jam,accident,obstacle', 'izvēlē tikai 5 veidi');
  for (const m of sql.matchAll(/\('([a-z-]+)',\s+'([^']+)',\s+'[a-z-]+',\s+(\d+),\s+'([^']+)',\s+\d+,\s+(\d+)\)/g)) {
    const [, id, label, min, q, dist] = m, c = C[id];
    ok(c, id + ' ir klientā');
    eq(c.label, label, id + ' nosaukums'); eq(c.ttl, +min, id + ' derīgums'); eq(c.question, q, id + ' jautājums'); eq(c.askDistance, +dist, id + ' attālums');
    eq(T[id].label, label, id + ' nosaukums kartē'); eq(T[id].ttl, +min, id + ' ttl kartē');
    ok(c.ask && c.reward === 10 && c.askOnce, id + ': jautā, 10 monētas, vienreiz');
  }
  const it = { id: 'rep:1', rid: '1', type: 'police', source: 'shared', mine: false, myVote: null };
  const ctx = (o = {}) => Object.assign({ asked: new Set(), odo: 5000, lastAskOdo: null, toTurn: null, speedKmh: 50, busy: false }, o);
  eq(block({ it, dist: 280 }, ctx()), '', '280 m priekšā — jautā');
  eq(block({ it, dist: 450 }, ctx()), 'distance', 'par tālu');
  eq(block({ it, dist: 20 }, ctx()), 'distance', 'jau garām');
  eq(block({ it: { ...it, type: 'jam' }, dist: 200 }, ctx()), 'distance', 'sastrēgums — tikai iebraucot (150 m)');
  eq(block({ it: { ...it, type: 'jam' }, dist: 120 }, ctx()), '', 'sastrēgums 120 m');
  eq(block({ it: { ...it, mine: true }, dist: 200 }, ctx()), 'mine', 'savu nejautā');
  eq(block({ it: { ...it, myVote: 'still' }, dist: 200 }, ctx()), 'voted', 'jau atbildēts');
  eq(block({ it, dist: 200 }, ctx({ asked: new Set(['rep:1']) })), 'asked', 'vienreiz par ziņojumu');
  eq(block({ it, dist: 200 }, ctx({ busy: true })), 'busy', 'viens jautājums vienlaikus');
  eq(block({ it, dist: 200 }, ctx({ toTurn: 180 })), 'turn', 'ne pirms pagrieziena');
  eq(block({ it, dist: 200 }, ctx({ toTurn: 600 })), '', 'pagrieziens tālu');
  eq(block({ it, dist: 200 }, ctx({ lastAskOdo: 4400 })), 'gap', 'ne biežāk kā reizi ~1 km');
  eq(block({ it, dist: 200 }, ctx({ lastAskOdo: 3900 })), '', 'pēc 1,1 km — atkal drīkst');
  eq(block({ it, dist: 200 }, ctx({ speedKmh: 2 })), 'speed', 'tikai braucot');
  eq(block({ it: { ...it, type: 'pothole' }, dist: 200 }, ctx()), 'type', 'veidam bez jautājuma — nejautā');
  eq(block({ it: { ...it, source: 'osm' }, dist: 200 }, ctx()), 'none', 'tikai lietotāju ziņojumi');
  const r = G('reportFromRow')({ id: 'x', type: 'police', lat: 1, lng: 2, created_at: '2026-11-01T10:00:00Z', expires_at: '2026-11-01T10:45:00Z', confidence: 0.8, pending: true });
  ok(r.confidence === 0.8 && r.pending === true, 'confidence un pending no servera');
});

test('v124: ReportsApi.confirm — sūta pierādījumus; gps_suspect = kļūda; bez coins SQL — vecā atzīme bez monētām', async () => {
  const CzAuth = G('CzAuth'), ReportsApi = G('ReportsApi'), errText = G('reportErrorText');
  const mem = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
  const consent = JSON.stringify({ terms: G('CZ_TERMS_VERSION'), privacy: G('CZ_PRIVACY_VERSION'), at: 'x' });
  const sess = JSON.stringify({ access_token: 'eyJ0.eyJzdWIiOiJ1MSJ9.x', refresh_token: 'r', expires_at: Date.now() + 3600e3, user_id: 'u1' });
  const mk = handler => { const calls = []; const f = async (url, o = {}) => { calls.push({ url, body: o.body }); const [st, b] = handler(url) || [200, {}];
    return { ok: st < 400, status: st, text: async () => JSON.stringify(b), json: async () => b }; }; f.calls = calls; return f; };
  const cfg = { url: 'https://x.supabase.co', anonKey: 'anon' };
  let f = mk(u => /report_confirm/.test(u) ? [200, { coins: 10, balance: 130, hidden: false }] : [201, {}]);
  let api = new ReportsApi(new CzAuth(cfg, { storage: mem({ 'cz.consent': consent, 'cz.auth.session': sess }), fetch: f }));
  const res = await api.confirm('r1', 'yes', { lat: 56.9, lng: 24.1, heading: 91.6, speedKmh: 54, accuracy: 8, mock: false });
  eq(res.coins, 10);
  const b = JSON.parse(f.calls.find(c => /report_confirm/.test(c.url)).body);
  eq(b.p_answer, 'yes'); eq(b.p_heading, 92); eq(b.p_speed_kmh, 54); eq(b.p_accuracy, 8); eq(b.p_mock, false); eq(b.p_lat, 56.9);
  f = mk(u => /report_confirm/.test(u) ? [200, { error: 'gps_suspect' }] : [201, {}]);
  api = new ReportsApi(new CzAuth(cfg, { storage: mem({ 'cz.consent': consent, 'cz.auth.session': sess }), fetch: f }));
  let code = null; try { await api.confirm('r1', 'no', {}); } catch (e) { code = e.code; }
  eq(code, 'gps_suspect', 'atgrieztā kļūda');
  f = mk(u => /report_confirm/.test(u) ? [404, { message: 'Could not find the function' }] : /report_vote/.test(u) ? [200, { still: 2, hidden: false }] : [201, {}]);
  api = new ReportsApi(new CzAuth(cfg, { storage: mem({ 'cz.consent': consent, 'cz.auth.session': sess }), fetch: f }));
  const old = await api.confirm('r1', 'no', {});
  ok(old.legacy && old.coins === 0, 'vecā atzīme');
  eq(JSON.parse(f.calls.find(c => /report_vote/.test(c.url)).body).p_vote, 'gone', 'NĒ = vairs nav');
  for (const c of ['already_answered', 'not_nearby', 'not_driving', 'wrong_direction', 'poor_gps', 'gps_suspect', 'need_account', 'not_enough', 'already_owned', 'not_owned'])
    ok(errText(c) !== errText('???'), c + ' — saprotams teksts');
  f = mk(() => [200, {}]);
  api = new ReportsApi(new CzAuth(cfg, { storage: mem({ 'cz.consent': consent }), fetch: f }));
  eq(await api.wallet(), null, 'bez konta maciņu neprasa un kontu neveido');
  eq(f.calls.length, 0);
});

test('v124: Garāža — 8 tēli kā serverī, retums pēc cenas, kartīšu stāvokļi; lapsa kartē taisni, bultiņa griežas', () => {
  const c2 = vm.createContext({ console, Math, Map, Set, JSON, Number, String, Array, Object, encodeURIComponent });
  for (const f of ['skins.js', 'garage.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/if \(typeof module[\s\S]*$/m, ''), c2);
  const g = n => vm.runInContext(n, c2);
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'coins-1.sql'), 'utf8');
  const srv = [...sql.matchAll(/\('([a-z]+)',\s+'([^']+)',\s+(\d+),\s+'skins\/\1\.svg',\s+'skins\/\1-map\.svg'/g)].map(m => [m[1], m[2], +m[3]]);
  eq(srv.length, 8, 'serverī 8 tēli');
  const def = g('SKINS_DEFAULT').filter(s => s.character === 'fox');
  eq(def.map(s => s.id + ':' + s.name + ':' + s.price).join(), srv.map(s => s.join(':')).join(), 'klienta saraksts = serveris');
  eq(def.map(s => s.price).join(), '200,300,350,400,450,500,600,800', 'lētākie pirmie');
  eq(def.map(s => s.rarity).join(), 'common,common,common,rare,rare,rare,epic,epic', 'retums');
  for (const [id] of srv) {
    ok(g('skinShopSvg')(id).startsWith('<svg'), id + ' attēls');
    eq(fs.readFileSync(path.join(__dirname, '..', 'skins', id + '.svg'), 'utf8'), g('skinShopSvg')(id), id + '.svg sakrīt ar skins.js');
    eq(fs.readFileSync(path.join(__dirname, '..', 'skins', id + '-map.svg'), 'utf8'), g('skinMapSvg')(id), id + '-map.svg sakrīt');
  }
  const st = g('garageCardState'), vik = def.find(s => s.id === 'viking');
  eq(st(vik, null), 'locked', 'bez konta — slēgts');
  eq(st(vik, { balance: 120, owned: [] }), 'locked');
  eq(st(vik, { balance: 400, owned: [] }), 'buy');
  eq(st(vik, { balance: 0, owned: ['viking'], equipped: null }), 'owned');
  eq(st(vik, { balance: 0, owned: ['viking'], equipped: 'viking' }), 'equipped');
  const gj = fs.readFileSync(path.join(__dirname, '..', 'garage.js'), 'utf8');
  ok(/`\$\{garageCoins\(bal\)\} \/ \$\{garageCoins\(s\.price\)\}`/.test(gj) && /'Slēgts'|>Slēgts</.test(gj), '„Slēgts” ar „120 / 300”');
  ok(/'Pirkt'/.test(gj) && /'Izmantot'/.test(gj) && /gr-check/.test(gj), 'Pirkt / Izmantot / ✓');
  ok(/Pirkt „\$\{s\.name\}”\?/.test(gj) && /ridesOpenAccount/.test(gj), 'apstiprinājums; bez konta — konta izveide');
  ok(!/balance\s*[-+]?=/.test(gj.replace(/garage\.wallet\.balance = n/, '')), 'klients pats atlikumu nemaina (tikai rāda servera vērtību)');
  const pj = fs.readFileSync(path.join(__dirname, '..', 'presence.js'), 'utf8');
  ok(/rotate\(\$\{\(h \|\| 0\) - /.test(pj) && /map\.on\('rotate', presenceRotateAll\)/.test(pj), 'bultiņa griežas pēc virziena un kartes');
  ok(!/pr-fox[^\n]*rotate/.test(pj) && /PRESENCE_ICON_PX = 48/.test(pj), 'lapsa ~48 px netiek griezta');
  const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
  ok(!/skin/i.test(app.slice(app.indexOf('function createMeMarker('), app.indexOf('\n}\n', app.indexOf('function createMeMarker(')))), 'pats redzi savu zaļo bultiņu');
});

test('v124: citi braucēji — tikai ar „Palīdzēt citiem” (jaunā versija), braucot, noapaļoti, bez ID; privātums atjaunots', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'coins-2-presence.sql'), 'utf8');
  ok(/alter table public\.user_presence enable row level security/.test(sql) && !/create policy/i.test(sql), 'RLS, tikai funkcijas');
  ok(/kind = 'speed_share'/.test(sql) && /version >= '2026-11-01'/.test(sql), 'tikai ar jaunāko piekrišanu');
  ok(/p_speed_kmh < 15/.test(sql) && /delete from user_presence where user_id = me/.test(sql), 'apstājoties — dzēš uzreiz');
  ok(/interval '2 minutes'/.test(sql) && /interval '10 minutes'/.test(sql), '2 min redzams, 10 min dzēš');
  ok(/round\(p_lat::numeric \* 5000\) \/ 5000/.test(sql), 'noapaļots ~20 m');
  const nb = sql.slice(sql.indexOf('function public.presence_nearby'), sql.indexOf('$$;', sql.indexOf('function public.presence_nearby')));
  ok(!/returns table \([^)]*user_id/.test(nb) && /user_id is distinct from auth\.uid\(\)/.test(nb), 'neatdod ID, neatdod mani');
  ok(/revoke all on function public\.presence_update\([^)]*\) from public, anon/.test(sql) && /grant execute on function public\.presence_nearby\([^)]*\) to anon, authenticated/.test(sql), 'tiesības');
  const tr = fs.readFileSync(path.join(__dirname, '..', 'traffic-gl.js'), 'utf8');
  ok(/TR_SHARE_VERSION = '2026-11-01'/.test(tr) && /const trShareCurrent = /.test(tr) && /Garāžas tēlu/.test(tr), 'piekrišanas teksts un versija');
  ok(/presenceStop\(\)/.test(tr), 'izslēdzot — noņem no kartes uzreiz');
  const pj = fs.readFileSync(path.join(__dirname, '..', 'presence.js'), 'utf8');
  ok(/trShareCurrent\(\)/.test(pj) && /!state\.testMode/.test(pj) && /PRESENCE_MIN_KMH = 15/.test(pj), 'sūta tikai ar piekrišanu, braucot, ne testa režīmā');
  eq(G('CZ_PRIVACY_VERSION'), '2026-11-01', 'privātuma versija');
  const pr = fs.readFileSync(path.join(__dirname, '..', 'privacy.html'), 'utf8');
  ok(/Versija 2026-11-01/.test(pr) && /monētu atlikums/.test(pr) && /uzticamības rādītājs/.test(pr) && /Tava vieta citu kartē/.test(pr), 'privātuma politika');
  for (const f of ['index.html', 'index-gl.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    ok(/id="garageBtn"[\s\S]{0,700}Garāža[\s\S]{0,200}id="garageBal"/.test(html), f + ': poga „Garāža” ar atlikumu');
    ok(/id="garageSheet"/.test(html) && /id="garageGrid"/.test(html), f + ': Garāžas logs');
    for (const s of ['skins-art.js', 'skins.js', 'garage.js', 'presence.js']) ok(html.indexOf(s) > 0 && html.indexOf(s) < html.indexOf('app-gl.js'), f + ': ' + s);
  }
  const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
  ok(/for \(const type of REPORT_PICKER\)/.test(app), 'izvēlē REPORT_PICKER');
  ok(/REPORT_PROMPT_MS = 7000/.test(app) && /mk\('JĀ', 'yes', 'yes'\); mk\('NĒ', 'no', 'no'\)/.test(app), 'JĀ / NĒ, 7 s');
  ok(/mock: !!state\.testMode/.test(app), 'testa režīmā — bez monētām');
  ok(/it\.pending && !it\.mine\) reportsState\.pending\.set/.test(app), 'neapstiprinātos nezīmē, bet par tiem jautā');
  ok(!/reportAskStill|reportPassed/.test(app), 'vecais „Vēl ir?” pēc garāmbraukšanas noņemts');
});


test('v125: Garāža — 8 tēli × 10 dizaini (lapsām 8), „Mythic”, filtrs; katalogs = SQL = faili; bez valstu karogiem', () => {
  const c2 = vm.createContext({ console, Math, Map, Set, JSON, Number, String, Array, Object, encodeURIComponent, localStorage: { getItem: () => null, setItem() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'skins-art.js'), 'utf8'), c2);
  for (const f of ['skins.js', 'garage.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/if \(typeof module[\s\S]*$/m, ''), c2);
  const g = n => vm.runInContext(n, c2);
  const all = g('SKINS_DEFAULT'), CH = g('SKIN_CHARS'), rar = g('skinRarity');
  eq(all.length, 78, '8 lapsas + 7 × 10');
  eq(new Set(all.map(s => s.id)).size, 78, 'unikāli id');
  for (const ch of ['bear', 'cat', 'panda', 'penguin', 'owl', 'bunny', 'raccoon']) {
    const set = all.filter(s => s.character === ch);
    ok(CH[ch], ch + ' nosaukums');
    eq(set.map(s => s.rarity).join(), 'common,common,common,rare,rare,rare,epic,epic,mythic,mythic', ch + ': 3 / 3 / 2 / 2');
    eq(set.map(s => s.price).join(), '200,250,300,400,450,500,650,750,1200,1500', ch + ' cenas');
  }
  eq(rar(999), 'epic'); eq(rar(1000), 'mythic'); eq(g('SKIN_RARITY_LABEL').mythic, 'Mythic');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'coins-3-skins.sql'), 'utf8');
  const rows = [...sql.matchAll(/\('([a-z-]+)', '([^']+)', (\d+), '([a-z]+)', '(?:skins\/\1\.svg|skins-art\.js#\1)', '(?:skins\/\1-map\.svg|skins-art\.js#\1)', \d+\)/g)].map(m => m.slice(1, 5).join(':'));
  eq(rows.join(), all.map(s => [s.id, s.name, s.price, s.character].join(':')).join(), 'SQL rindas = klienta katalogs');
  ok(/price >= 1000 then 'mythic'/.test(sql) && /drop function if exists public\.skins_list\(\)/.test(sql) && /grant execute on function public\.skins_list\(\) to anon, authenticated/.test(sql), 'SQL: mythic, skins_list ar tēlu');
  for (const s of all.filter(x => x.character === 'fox')) for (const f of [s.id + '.svg', s.id + '-map.svg'])
    ok(fs.existsSync(path.join(__dirname, '..', 'skins', f)), 'fails skins/' + f);
  for (const s of all.filter(x => x.character !== 'fox')) ok(/^<svg[\s\S]*<\/svg>$/.test(g('skinArtSvg')(s.id)), s.id + ' — zīmējums');
  ok(g('skinDataUrl')('bear-karalis').startsWith('data:image/svg+xml'), 'citi tēli — zīmēti pārlūkā (skins-art.js)');
  ok(g('skinDataUrl')('chef').startsWith('data:image/svg+xml'), 'lapsas — zīmētas');
  eq(g('skinDataUrl')('nav-tada'), '', 'nezināms tēls — nekas');
  const costumes = fs.readFileSync(path.join(__dirname, '..', 'tools', 'skins', 'costumes.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'tools', 'skins', 'sets.js'), 'utf8');
  const art = fs.readFileSync(path.join(__dirname, '..', 'skins-art.js'), 'utf8');
  ok(art.includes(fs.readFileSync(path.join(__dirname, '..', 'tools', 'skins', 'sets.js'), 'utf8').split('\n').slice(2, 6).join('\n')), 'skins-art.js uzģenerēts no tools/skins (node tools/skins/build.js)');
  ok(!/flag|#9e1b32|Latvij/.test(art), 'arī pārlūka failā nav karogu');
  ok(!/flag|#9e1b32|Latvij/.test(costumes), 'nav valstu karogu (lietotne visai pasaulei)');
  ok(!/Astronauts/.test(costumes) && /Dziļjūras nirējs/.test(costumes), 'pandas astronauts nomainīts');
  const vis = g('garageVisible');
  eq(vis(all, 'panda', null).length, 10); eq(vis(all, 'fox', null).length, 8); eq(vis(all, 'all', null).length, 78);
  eq(vis(all, 'mine', { owned: ['chef', 'owl-fenikss'] }).map(s => s.id).join(), 'chef,owl-fenikss', '„Mani”');
  const css = fs.readFileSync(path.join(__dirname, '..', 'style-gl.css'), 'utf8');
  ok(/\.gr-card\.rar-mythic/.test(css) && /\.gr-chip\.on/.test(css), 'CSS');
  for (const f of ['index.html', 'index-gl.html']) ok(/id="garageChars"/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')), f + ': filtrs');
});


test('v131: iestatījumi — Braukšana / Sastrēgumi / Izskats / Konts un privātums / Par lietotni, 1 pieskāriens, bottom sheet', () => {
  for (const f of ['index.html', 'index-gl.html']) {
    const h = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const set = h.slice(h.indexOf('id="settings"'), h.indexOf('</section>', h.indexOf('id="settings"')));
    const groups = ['Braukšana', 'Sastrēgumi', 'Izskats', 'Konts un privātums', 'Par lietotni'];
    let at = 0;
    for (const g of groups) { const x = set.indexOf('<h3 class="set-h">' + g + '</h3>'); ok(x > at, f + ': grupa ' + g + ' pareizā secībā'); at = x; }
    for (const id of ['settingsTitle', 'closeSettings', 'trafficRows', 'trafficShare', 'trafficShow', 'trHelpersSet', 'masterSwitch', 'catList', 'warnSwitch',
      'arrowColors', 'markerAnim', 'markerAnimTest', 'basemapSelect', 'accountBtn', 'devBox', 'testSwitch', 'testSpeedRow', 'testSpeed', 'testSpeedVal', 'mlyToken', 'mlySave', 'mlyNote', 'devOff'])
      ok(h.includes('id="' + id + '"'), f + ': ' + id + ' saglabāts');
    ok(set.indexOf('id="devBox"') > set.indexOf('<h3 class="set-h">Par lietotni</h3>'), f + ': izstrādātājam — pašā apakšā');
    ok(/Dalīties ar ātrumu anonīmi<\/b><small>Tikai ātrums un aptuvenā vieta, bez vārda\. Glabājas 28 dienas\.<\/small>/.test(set) && /<summary>Vairāk<\/summary>/.test(set), f + ': īsa rinda + „Vairāk”');
    ok(/href="terms\.html" target="_blank"/.test(set) && /href="privacy\.html" target="_blank"/.test(set) && /Lietošanas noteikumi/.test(set) && /Privātuma politika/.test(set), f + ': noteikumi un privātums — rindas');
    ok(/<summary>.*Datu avoti/.test(set), f + ': datu avoti atverami');
    ok((set.match(/class="set-ic"/g) || []).length >= 10, f + ': ikonas');
    ok(/class="set-grab"/.test(set), f + ': vilkšanas rokturis');
    const form = h.slice(h.indexOf('id="searchForm"'), h.indexOf('</form>'));
    ok(/id="settingsBtn"/.test(form), f + ': iestatījumi ar 1 pieskārienu — meklēšanas joslā');
    ok(!/id="fabMore"|id="toggleSigns"/.test(h), f + ': v132 — ⋯ un „Zīmes/Brīdin.” poga noņemta (dublēja galveno slēdzi)');
    ok(/style-gl\.css\?v=13[2-9]/.test(h) && /app-gl\.js\?v=1[3-9]\d/.test(h), f + ': versijas ≥ v132');
    ok(/<a id="call112" class="call-112" href="tel:112" hidden>/.test(h) && /Zvanīt 112/.test(h) && /places\.js\?v=133/.test(h), f + ': v133 — poga „Zvanīt 112”');
    ok(!/[A-Za-z]{4,} (settings|Settings)/.test(set.replace(/<[^>]+>/g, '')), f + ': bez angļu teksta');
  }
  const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
  ok(/\$\('call112'\)\.hidden = catId !== 'crisis'/.test(app), 'v133: 112 rāda tikai ārkārtas kategorijā');
  ok(!/toggleSigns|fabMore/.test(app) && /setBtn\.classList\.toggle\('dot', !state\.signsOn\)/.test(app), 'v132: sarkanais punkts uz iestatījumu pogas, kad brīdinājumi izslēgti');
  ok(/segmentize\(sel\); segmentize\(\$\('markerAnim'\)\);/.test(app), 'kartes stils un animācija — segmentu pogas');
  const seg = app.slice(app.indexOf('function segmentize('), app.indexOf('function toggleSettings('));
  ok(/select\.dispatchEvent\(new Event\('change'/.test(seg) && /select\.addEventListener\('change', sync\)/.test(seg), 'sinhronizē abos virzienos (store un applyBasemap kā līdz šim)');
  const ws = app.slice(app.indexOf('function wireSettingsSheet('), app.indexOf('\n}\n', app.indexOf('function wireSettingsSheet(')));
  ok(/e\.key === 'Escape'/.test(ws) && /dy > 90\) toggleSettings\(false\)/.test(ws), 'aizveras ar Esc un velkot uz leju');
  ok(/\$\('catList'\)\.hidden = alertsMode;/.test(app), 'zīmju saraksts brīdinājumu režīmā paslēpts (loģika nemainīta)');
  const css = fs.readFileSync(path.join(__dirname, '..', 'style-gl.css'), 'utf8');
  ok(/\.set-sheet \.switch \{ width: 52px; height: 32px;/.test(css), 'slēdži 52 × 32');
  ok(/\.set-seg button \{ min-height: 44px;/.test(css) && /\.set-seg button\.on \{ background: var\(--accent\); color: #fff;/.test(css), 'segmenti ≥ 44 px, aktīvais akcenta krāsā');
  ok(/\.set-sheet \.color-swatch \{ position: relative; width: 42px; height: 42px; \}/.test(css) && /color-swatch\[aria-pressed="true"\]::after/.test(css), 'krāsas ≥ 40 px ar ķeksīti');
  ok(/\.set-row \{ min-height: 56px;/.test(css), 'rindas ≥ 56 px');
});

test('v127: nobraucot no maršruta — pārrēķina no manas vietas uz priekšu (ar virzienu), arī ar vāju GPS', async () => {
  const off = G('isOffRoute'), rb = G('routeBearingAt'), req = G('requestRoute');
  ok(off(60, 10, 0, 50), '60 m prom ar labu GPS — nobraucis');
  ok(!off(30, 10, 5, 50), '30 m, tas pats virziens — vēl uz maršruta (GPS kļūda)');
  ok(off(30, 10, 90, 40), 'blakus ielā citā virzienā — nobraucis');
  ok(!off(30, 10, 90, 5), 'stāvot virziens neskaitās');
  ok(off(80, 50, null, 30), 'vājš GPS (50 m) — 80 m prom skaitās (agrāk neskaitījās nemaz)');
  ok(!off(60, 50, null, 30), 'vājš GPS — 60 m vēl var būt kļūda');
  ok(!off(300, 150, null, 30), 'ļoti neprecīzs GPS — nevērtē');
  const route = { coords: [[24.1, 56.95], [24.1, 56.96]], cum: [0, 1113] };
  ok(Math.abs(rb(route, { idx: 0 }) - 0) < 1, 'maršruta virziens uz ziemeļiem');
  const urls = [];
  const old = vm.runInContext('typeof fetch', ctx);
  ctx.fetch = async u => { urls.push(u); return { ok: true, json: async () => ({ code: 'Ok', routes: [{ distance: 100, duration: 10, legs: [{ steps: [
    { geometry: { coordinates: [[24.1, 56.95], [24.1, 56.951]] }, maneuver: { type: 'depart' } },
    { geometry: { coordinates: [[24.1, 56.951], [24.1, 56.951]] }, maneuver: { type: 'arrive' } }] }] }] }) }; };
  await req({ lat: 56.95, lng: 24.1 }, { lat: 56.96, lng: 24.1 }, { bearing: 371.4 });
  ok(/&bearings=11,60;/.test(urls[0]), 'pieprasījumā braukšanas virziens (normalizēts)');
  await req({ lat: 56.95, lng: 24.1 }, { lat: 56.96, lng: 24.1 });
  ok(!/bearings/.test(urls[1]), 'bez virziena — parasts maršruts');
  delete ctx.fetch;
  const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
  const rr = app.slice(app.indexOf('async function reroute('), app.indexOf('// Testa režīmā: simulēts brauciens'));
  ok(/requestRoute\(state\.me, state\.nav\.dest, \{ bearing:/.test(rr) && !/cachedRoute/.test(rr), 'pārrēķins ar virzienu, bez kešatmiņas');
  ok(/isOffRoute\(p\.loc\.off, state\.me\.accuracy, hd, state\.me\.speedKmh\)/.test(app) && /REROUTE_GAP_MS = 8000/.test(app), 'nobraukšanas pārbaude, ik 8 s');
});


test('v128: 50 → 70 bez 70 zīmes datos — OSM maxspeed uzvar atmiņu; aptuvens ierobežojums nekrāso sarkanu', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
  const fn = app.slice(app.indexOf('function resolveSpeedLimit('), app.indexOf('const speedHold'));
  ok(/speedMemoOsm\.limit = explicitOsm \? explicitOsm\.limit : null/.test(fn), 'atceras OSM vērtību zīmes vietā');
  ok(/if \(!\(explicitOsm && explicitOsm\.limit !== speedMemoOsm\.limit\)\) sign = mem\.limit;/.test(fn), 'OSM mainījies → zīmes atmiņu neizmanto');
  // simulate: memory 50 from a sign; OSM on that stretch 50; later OSM says 70
  const memo = { s: null, limit: null };
  const pick = (mem, osm) => { if (memo.s !== mem.s) { memo.s = mem.s; memo.limit = osm; } return osm != null && osm !== memo.limit ? osm : mem.limit; };
  const sign50 = { id: 'z' };
  eq(pick({ s: sign50, limit: 50 }, 50), 50, 'pie zīmes — 50');
  eq(pick({ s: sign50, limit: 50 }, 70), 70, 'OSM kļūst 70 → 70 (agrāk palika 50 un rādīja sarkanu pie 68)');
  eq(pick({ s: sign50, limit: 50 }, null), 50, 'OSM nav zināms → paliek zīme');
  const isOver = G('isOverspeed');
  eq(isOver(68, { limit: 70 }), false); eq(isOver(68, { limit: 50 }), true, 'zināms 50 → brīdina');
  eq(isOver(68, { limit: 50, approx: true }), false, 'minēts 50 → nebrīdina');
});


test('v129: spidometrs — aplis līdz atļautajam, sarkanā svītra pārsniedzot, zīme blakus, stāvot 0', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
  const src = app.slice(app.indexOf('function renderSpeedo('), app.indexOf('// ---------- Laika ierobežojumi'));
  const els = {}; const mk = id => els[id] || (els[id] = { id, textContent: '', hidden: false, title: '', attrs: {}, cls: new Set(),
    setAttribute(k, v) { this.attrs[k] = v; }, classList: { toggle: (c, on) => { const e = els[id]; on ? e.cls.add(c) : e.cls.delete(c); },
      add: c => els[id].cls.add(c), remove: c => els[id].cls.delete(c), contains: c => els[id].cls.has(c) } });
  const render = new Function('$', 'const SPEEDO_PARK_MS = 3000;\n' + src + '\nreturn renderSpeedo;')(mk);
  render(38, { limit: 50 }, false);
  eq(els.speedValue.textContent, '38'); eq(els.speedoArc.attrs['stroke-dasharray'], '76.0 100', '38/50 = 76 %');
  eq(els.speedoOver.attrs['stroke-dasharray'], '0.0 100'); eq(els.limitSign.hidden, false); eq(els.limitSignValue.textContent, '50');
  render(83, { limit: 70 }, true);
  eq(els.speedoOver.attrs['stroke-dasharray'], '43.3 100', '+13 no 30 → 43 % sarkanā'); eq(els.limitSignValue.textContent, '70');
  render(130, { limit: 90 }, true); eq(els.speedoOver.attrs['stroke-dasharray'], '100.0 100', 'vairāk par +30 — pilna');
  render(1.2, { limit: 50 }, false); eq(els.speedValue.textContent, '0', 'stāvot — 0'); ok(els.limitBadge.cls.has('stopped'));
  ok(/SPEEDO_PARK_MS = 3000/.test(app) && /badge\.classList\.add\('parked'\)/.test(src) && /badge\.classList\.remove\('parked'\)/.test(src), 'v130: stāvot 3 s — zīme izgaist, braucot atgriežas');
  const css = fs.readFileSync(path.join(__dirname, '..', 'style-gl.css'), 'utf8');
  ok(/\.limit-badge\.parked \.speedo-limit \{ opacity: 0/.test(css) && /\.speedo-limit, \.speedo-ring \{ transition: opacity/.test(css), 'v130: maiga pāreja');
  render(null, null, false); eq(els.speedValue.textContent, '–'); eq(els.limitSign.hidden, true, 'nezināms ierobežojums — zīmes nav');
  render(45, { limit: 50, approx: true }, false); ok(els.limitSign.cls.has('approx'), 'minēts — pelēka zīme');
  for (const f of ['index.html', 'index-gl.html']) {
    const h = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    ok(/id="limitSign"/.test(h) && /id="speedoArc"/.test(h) && /id="speedoOver"/.test(h), f + ': aplis un zīme');
  }
});

// ---------- Coins: community reports, confirmations, Garāža (supabase/coins-1.sql) ----------
test('Coins: SQL — report types config, validated confirmations, daily cap, atomic purchases, permissions', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'coins-1.sql'), 'utf8');
  const fnOf = name => { const i = sql.indexOf('function public.' + name + '('); return sql.slice(i, sql.indexOf('$$;', sql.indexOf('$$', i) + 2)); };
  // config: 5 types with Latvian labels/questions and lifetimes
  for (const [id, label, min, q] of [['police', 'Policija', 45, 'Vai policija vēl ir šeit?'], ['camera-mobile', 'Radars', 60, 'Vai radars vēl ir šeit?'],
    ['jam', 'Sastrēgums', 20, 'Vai sastrēgums vēl ir?'], ['accident', 'Avārija', 60, 'Vai avārija vēl ir šeit?'], ['obstacle', 'Šķērslis', 30, 'Vai šķērslis vēl ir uz ceļa?']]) {
    ok(new RegExp(`\\('${id}',\\s*'${label}',\\s*'[a-z-]+',\\s*${min},\\s*'${q.replace('?', '\\?')}'`).test(sql), id + ': config row');
  }
  ok(/coin_reward\s+int\s+not null default 10/.test(sql) && /author_bonus\s+int\s+not null default 5/.test(sql) && /max_lifetime_factor\s+numeric not null default 2/.test(sql), 'defaults: 10 coins, +5 author, ≤ 2× lifetime');
  ok(/coin_daily_cap\(\) returns int language sql immutable as \$\$ select 100 \$\$/.test(sql), 'daily cap 100');
  const rc = fnOf('report_confirm');
  for (const code of ['own_report', 'already_answered', 'not_nearby', 'not_driving', 'wrong_direction', 'poor_gps', 'gps_suspect']) ok(rc.includes(code), 'report_confirm checks ' + code);
  ok(/wallet_award\(me, t\.coin_reward, 'answer'/.test(rc) && /wallet_award\(r\.user_id, t\.author_bonus, 'author_bonus'/.test(rc), 'coins: answer + author bonus, decided on the server');
  ok(/streak >= 2/.test(fnOf('report_vote_apply')), 'two NO in a row hide the report');
  const buy = fnOf('skin_buy');
  ok(/wallet_can_spend\(me\)/.test(buy) && /wallet_lock\(me\)/.test(buy) && /balance < s\.price/.test(buy) && /balance = balance - s\.price/.test(buy) && /insert into user_skins/.test(buy), 'purchase: account check, row lock, balance, deduct, grant');
  ok(/email_confirmed_at is not null/.test(fnOf('wallet_can_spend')), 'spending needs a confirmed e-mail account');
  for (const tbl of ['report_types', 'skins', 'user_wallet', 'user_skins', 'coin_ledger']) ok(new RegExp(`alter table public\\.${tbl} enable row level security`).test(sql), tbl + ': RLS on');
  ok(/revoke all on function public\.wallet_award\(uuid, int, text, uuid\) from public, anon, authenticated/.test(sql), 'award not callable by clients');
  ok(!/grant execute on function public\.(skin_buy|wallet_get|report_confirm)[^;]*anon/.test(sql), 'anon cannot buy / confirm');
  ok(fs.existsSync(path.join(__dirname, 'coins-test.sql')), 'database scenario test present');
});

// ---------- F19: Stripe webhook + „Sinhronizēt ar Stripe” ----------
test('F19: stripe-webhook — paraksts, notikumi, idempotence, tikai uz priekšu', () => {
  const wh = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'stripe-webhook', 'index.ts'), 'utf8');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'rides-12-webhook.sql'), 'utf8');
  ok(/const body = await req\.text\(\);/.test(wh) && !/req\.json\(\)/.test(wh), 'ķermenis kā teksts');
  ok(/webhooks\.constructEventAsync\(body, sig, WHSEC, undefined, cryptoProvider\)/.test(wh) && /Stripe\.createSubtleCryptoProvider\(\)/.test(wh), 'Stripe paraksta pārbaude');
  ok(/catch \{\s*return json\(\{ error: 'Nederīgs paraksts' \}, 400\);/.test(wh), 'nederīgs paraksts → 400');
  ok(wh.indexOf('constructEventAsync') < wh.indexOf("sdb(`stripe_events?id=eq."), 'nekas netiek lasīts/rakstīts pirms paraksta');
  for (const e of ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired', 'charge.refunded'])
    ok(wh.includes(`'${e}'`), e);
  ok(/obj\.payment_status === 'paid' \? await syncOffer/.test(wh), 'paid tikai, ja payment_status = paid');
  ok(/if \(rs\.full\) \{/.test(wh) && /daļēja atmaksa — netiek atzīmēta kā pilna/.test(wh), 'daļēja atmaksa netiek atzīmēta (A05: refundState)');
  ok(/rpc\/ride_payment_mark/.test(wh) && /p_user_id: passenger/.test(wh), 'raksta caur ride_payment_mark (service_role)');
  ok(/seen\?\.length\) return json\(\{ received: true, duplicate: true \}\)/.test(wh), 'atkārtots notikums neko nedara');
  ok(!/json\([^)]*(SRK|WHSEC|SK)\b/.test(wh), 'atslēgas atbildē nenonāk');
  ok(/create table if not exists public\.stripe_events \(\s*id text primary key/.test(sql) && /enable row level security/.test(sql) &&
     /revoke all on table public\.stripe_events from public, anon, authenticated;/.test(sql), 'stripe_events tikai serverim');
});
test('F19: ride-pay „sync” — tikai īpašniekam, pa daļām; admin.html poga ar ziņu pie pogas', () => {
  const rp = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'ride-pay', 'index.ts'), 'utf8');
  const c = rp.slice(rp.indexOf("case 'sync'"), rp.indexOf("case 'refund_sync'"));
  ok(c.indexOf("rpc/is_app_admin") > 0 && c.indexOf("rpc/is_app_admin") < c.indexOf('sdb('), 'īpašnieka pārbaude pirms datiem');
  ok(/status=in\.\(created,paid\)/.test(c) && /offset=\$\{offset\}/.test(c), 'negalīgie, pa daļām');
  ok(/client_reference_id: oid/.test(rp) && /metadata: \{ offer_id: oid \}/.test(rp) && /transfer_data: \{ destination(: acct)? \}/.test(rp), 'sesijā brauciena ID; destination charges');
  const js = fs.readFileSync(path.join(__dirname, '..', 'admin.js'), 'utf8');
  ok(/action: 'sync', offset/.test(js) && /Pārbaudīti \$\{checked\}, atjaunoti \$\{updated\}/.test(js) && /await admLoad\(\)/.test(js), 'poga, rezultāts, pārlāde');
  const f = js.slice(js.indexOf('async function admSync'), js.indexOf('async function admFees'));
  ok(!/admSay\(/.test(f) && /msg\.textContent = adm\.syncMsg\.text/.test(f), 'kļūda pie pogas, ne kopējā ziņā');
});

// ---------- F20: „Ziņot” — pareizs iemesls, kāpēc nav atrašanās vietas ----------
test('F20: getLocationState un „Ziņot” logs — liegts / meklē / nav pieejams, pogas pelēkas', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const rep = fs.readFileSync(path.join(__dirname, '..', 'reports.js'), 'utf8');
  ok(/function getLocationState\(\)/.test(app) && /return 'denied'/.test(app) && /return 'unavailable'/.test(app) && /return 'searching'/.test(app), 'viens stāvoklis visai lietotnei');
  ok(/state\.me && \(state\.testMode \|\| gpsState !== 'denied'\)\) return 'ok'/.test(app), 'testa režīmā ar klikšķi — var ziņot');
  ok(/gpsTimeouts >= 2/.test(app) && /gpsTimeouts = kind === 'timeout' \? gpsTimeouts \+ 1 : 0/.test(app), 'atkārtots TIMEOUT → nav pieejams');
  ok(app.includes("'Atrašanās vieta nav atļauta — ieslēdz to, lai varētu ziņot.', 'Kā ieslēgt?'") && app.includes("'Meklē tavu atrašanās vietu…'") &&
     app.includes("'Mēģināt vēlreiz'"), 'teksti un pogas');
  ok(/b\.disabled = !ok/.test(app), 'tipu pogas pelēkas, kamēr vietas nav');
  ok(/reportSheet'\)\.hidden\) reportGpsRefresh\(\)/.test(app.slice(app.indexOf('function onFix'), app.indexOf('function onFix') + 3500)), 'vieta pienāk — logs atjaunojas');
  ok(/id="reportGps"/.test(html) && /id="reportGpsBtn"/.test(html), 'ziņa logā, ne statusa joslā');
  ok(!/pagaidi, kamēr GPS/.test(app + rep + html), 'maldinošais teksts izņemts');
  const fn = app.slice(app.indexOf('function reportGpsRefresh'), app.indexOf('function reportPlace'));
  ok(!/setStatus/.test(fn), 'bez setStatus');
});

// ---------- F21: iestatījumi latviski ----------
test('F21: „Marķieru animācija” — nosaukumi latviski, vērtības nemainītas', () => {
  for (const f of ['index.html', 'index-gl.html']) {
    const h = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    ok(h.includes('<option value="pop">Uzlēciens</option>') && h.includes('<option value="morph">Pārveidošanās</option>'), f + ': latviski, vērtības pop / morph');
    const set = h.slice(h.indexOf('id="settings"'), h.indexOf('id="devBox"'));
    ok(!/Elegant|Morph</.test(set), f + ': nav angļu nosaukumu');
  }
  const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
  ok(/store\.get\('markerAnim', 'pop'\)/.test(app) && /\bpop: \{ ms:/.test(app) && /\bmorph: \{ ms:/.test(app), 'saglabātās vērtības der kā līdz šim');
});

// ---------- F22: vietu kategorija latviski ----------
test('F22: „Elektroauto uzlāde” — nav „EV”, id un OSM vaicājums nemainīti', () => {
  const pl = fs.readFileSync(path.join(__dirname, '..', 'places.js'), 'utf8');
  ok(/\{ id: 'ev', +label: 'Elektroauto uzlāde', +color: '#0c8599', q: \['nwr\["amenity"="charging_station"\]'\]/.test(pl), 'teksts mainīts, id ev un vaicājums tie paši');
  ok(/"ev": \["amenity:charging_station"\]/.test(pl), 'Photon birkas nemainītas');
  for (const f of ['places.js', 'app-gl.js', 'index.html', 'index-gl.html'])
    ok(!/(label|title|textContent|aria-label)[^\n]*\bEV\b/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\/\/.*$/gm, '')), f + ': nav „EV” redzamos tekstos');
});

// ---------- F23: atceltie statistikā = atceltie „Mani braucieni” ----------
test('F23: atcelti braucieni + atsaukti pieprasījumi = atceltie vēsturē (demo, SQL, UI)', async () => {
  const S = G('LocalRideStore'), wd = G('rideHistWithdrawn');
  const mem = { d: {}, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = v; } };
  const pas = new S(mem, 'k'); await pas.saveProfile({ name: 'Anna' });
  const drv = new S(mem, 'k'); drv.id = 'drv'; await drv.saveProfile({ name: 'Jānis' });
  const st0 = await pas.myStats(); eq(st0.passenger_withdrawn, 0, 'jauns konts — 0');
  const req = { from_lat: 56.95, from_lng: 24.10, to_lat: 56.95, to_lng: 24.20, from_name: 'A', to_name: 'B', seats: 1, note: '', depart_at: new Date().toISOString() };
  const r1 = await pas.createRequest(req); await drv.offer(r1.id, { eta_min: 3 });
  const o1 = (await pas.offersFor(r1.id))[0]; await pas.respond(o1.id, 'accepted'); await drv.cancelOffer(o1.id);   // atcelts brauciens
  for (let i = 0; i < 3; i++) { const r = await pas.createRequest(req); await pas.setRequestStatus(r.id, 'cancelled'); }           // 3 atsaukti
  const st = await pas.myStats(), h = await pas.myHistory();
  const canc = h.filter(x => x.status !== 'done');
  eq(st.passenger_cancelled, 1, 'atcelti braucieni'); eq(st.passenger_withdrawn, 3, 'atsaukti pieprasījumi');
  eq(st.passenger_cancelled + st.passenger_withdrawn, canc.length, 'kopā = atceltie vēsturē');
  eq(canc.filter(wd).length, 3, 'vēsturē atšķirami');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'rides-ui.js'), 'utf8');
  ok(/'Kā pasažieris — atsaukti pieprasījumi'/.test(ui) && /RIDE_CANCELLED_NOTE = 'Braucieni, kuriem jau bija saskaņots šoferis'/.test(ui), 'statistikas rindas un paskaidrojums');
  ok(/'atsaukts pieprasījums' : 'atcelts brauciens'/.test(ui) && /'Pieprasījums atsaukts' : 'Brauciens atcelts'/.test(ui), 'vēsturē „atsaukts” / „atcelts”');
  const adm = fs.readFileSync(path.join(__dirname, '..', 'admin.js'), 'utf8');
  ok(/admRow\('Atcelti braucieni', a\.cancelled_rides/.test(adm) && /admRow\('Atsaukti pieprasījumi', a\.withdrawn/.test(adm), 'admin lapa');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'stats-2-f23.sql'), 'utf8');
  ok(/'passenger_withdrawn'/.test(sql) && /'cancelled_rides'/.test(sql) && /'withdrawn'/.test(sql), 'SQL lauki');
  ok(/if not is_app_admin\(\) then raise exception 'forbidden'/.test(sql) && /me uuid := auth\.uid\(\)/.test(sql), 'tiesības tās pašas');
  ok(/revoke all on function public\.my_stats\(\) from public, anon;/.test(sql) && /grant execute on function public\.my_stats\(\) to authenticated;/.test(sql), 'grants');
  ok(!/\b(update|delete|insert)\b/i.test(sql.replace(/--.*$/gm, '')), 'dati netiek mainīti');
});

// ---------- F24: vietu nosaukumi — apraksti no OSM netiek rādīti kā nosaukums ----------
test('F24: placeDisplayName / isGenericName — name:lv, īsti nosaukumi, kategorija · zīmols', () => {
  const d = G('placeDisplayName'), gen = G('isGenericName'), ev = G('evInfo');
  eq(d({ name: 'EV charging type 2', operator: 'Elektrum' }, 'ev'), 'Elektroauto uzlāde · Elektrum');
  eq(d({ name: 'EV charging type 2' }, 'ev'), 'Elektroauto uzlāde');
  eq(d({ name: 'Ignitis' }, 'ev'), 'Ignitis', 'zīmolu netulko');
  eq(d({ name: 'EV charger', 'name:lv': 'Uzlāde pie Akropoles' }, 'ev'), 'Uzlāde pie Akropoles', 'name:lv');
  eq(d({ name: 'Parking' }, 'parking'), 'Stāvvieta');
  eq(d({ name: 'Car wash' }, 'carwash'), 'Auto mazgātava', 'vienskaitlī'); eq(d({ name: 'Automazgātava' }, 'carwash'), 'Auto mazgātava');
  eq(d({ name: 'Pharmacy', brand: 'Benu' }, 'pharmacy'), 'Aptieka · Benu');
  eq(d({}, 'ev'), 'Elektroauto uzlāde', 'bez name'); eq(d(undefined, 'fuel'), 'Degviela');
  eq(d({ name: 'Uzlādes stacija', network: 'Elektrum' }, 'ev'), 'Elektroauto uzlāde · Elektrum', 'nerāda „· Uzlādes stacija”');
  eq(d({ name: 'Charging point', operator: 'Charging point' }, 'ev'), 'Elektroauto uzlāde', 'arī operators vispārīgs');
  ok(!gen('Elektrum EV charging', 'ev') && !gen('Tesla Supercharger', 'ev') && !gen('Station Cafe', 'coffee'), 'ar īstu vārdu — nav vispārīgs');
  ok(gen('  EV-Charging  (Type 2, 22kW) ', 'ev') && gen('CHAdeMO / CCS 50 kW', 'ev') && gen('Car Park', 'parking') && gen('WC', 'parking'), 'apraksti, pieturzīmes, kW');
  eq(ev({ 'socket:type2': '2', 'socket:type2_combo': '1', 'socket:type2_combo:output': '50 kW', capacity: '3' }).join(' · '), 'Type 2, CCS · līdz 50 kW · 3 vietas');
  eq(ev({}).length, 0, 'bez datiem — otrās rindas nav');
  const P = G('parsePlaces');
  const r = P([{ type: 'node', id: 1, lat: 56.95, lon: 24.1, tags: { amenity: 'charging_station', name: 'EV charging type 2', operator: 'Elektrum', 'socket:type2': '2', 'socket:type2:output': '22 kW' } },
    { type: 'node', id: 2, lat: 56.9501, lon: 24.1001, tags: { amenity: 'charging_station', name: 'EV charging' } },
    { type: 'node', id: 3, lat: 56.9502, lon: 24.1002, tags: { amenity: 'charging_station', name: 'EV charger' } }], 'ev', 56.95, 24.1);
  eq(r.map(x => x.name).join(' | '), 'Elektroauto uzlāde · Elektrum | Elektroauto uzlāde | Elektroauto uzlāde', 'divas dažādas stacijas ar vienādu rādāmo nosaukumu paliek');
  eq(r[0].osmName, 'EV charging type 2', 'oriģinālais nosaukums saglabāts'); eq(r[0].extra.join(' · '), 'Type 2 · līdz 22 kW');
  const ph = G('parsePhotonPlaces')([{ properties: { osm_type: 'N', osm_id: 5, name: 'Parking' }, geometry: { coordinates: [24.1, 56.95] } }], 'parking', 56.95, 24.1);
  eq(ph[0].name, 'Stāvvieta', 'Photon'); eq(G('parseTilePlaces')([{ properties: { subclass: 'charging_station', name: 'EV charging' }, geometry: { type: 'Point', coordinates: [24.1, 56.95] } }], 'ev', 56.95, 24.1)[0]?.name ?? 'Elektroauto uzlāde', 'Elektroauto uzlāde', 'kartes flīzes');
  const m = G('mergePlaceDetails')([{ id: 'node5', cat: 'parking', name: 'Stāvvieta', osmName: 'Parking', extra: [] }], [{ type: 'node', id: 5, tags: { name: 'Parking', operator: 'Rīgas satiksme' } }]);
  eq(m[0].name, 'Stāvvieta · Rīgas satiksme', 'papildinājums fonā — tā pati funkcija');
  const pl = fs.readFileSync(path.join(__dirname, '..', 'places.js'), 'utf8');
  ok(!/t\.name \|\| t\.brand|p\.name \|\| c\.label/.test(pl), 'vecā nosaukumu izvēle izņemta');
  const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
  ok(/isGenericName\(p\.name, p\.cat\) \? \{ name: placeLabelOne\(p\.cat\) \}/.test(app), 'vecā kešatmiņa — rādot, ne mainot');
});

// ---------- Domēns growlab.cc ----------
test('Domēns: CNAME = growlab.cc, ride-pay atļauj atgriešanos uz growlab.cc', () => {
  eq(fs.readFileSync(path.join(__dirname, '..', 'CNAME'), 'utf8').trim(), 'growlab.cc');
  const rp = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'ride-pay', 'index.ts'), 'utf8');
  ok(/APP_URLS = \['https:\/\/growlab\.cc\/', 'https:\/\/www\.growlab\.cc\/'/.test(rp), 'ride-pay atgriešanās adreses');
  ok(!/APP_URLS[^\n]*'https?:\/\/[^']*\*/.test(rp), 'bez aizstājējzīmēm');
});

// ---------- F16: administrēšanas lapa ----------
test('F16: admin.html — atsevišķa sesija, servera pārbaude, nav e-pasta', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'admin.js'), 'utf8');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'stats-f16.sql'), 'utf8');
  ok(/name="robots" content="noindex, nofollow"/.test(html), 'noindex');
  ok(/localStorage\.getItem\('cz\.admin\.' \+ k\)/.test(js) && /new CzAuth\(RIDES_CONFIG, \{ storage: admStorage \}\)/.test(js), 'atsevišķa sesija — lietotnes konts nemainās');
  ok(js.indexOf("admRpc('is_app_admin')") < js.indexOf("admRpc('admin_stats')"), 'vispirms is_app_admin');
  ok(!/service_role|sk_(test|live)_/.test(js + html), 'nav slepenu atslēgu');
  ok(!/[A-Za-z0-9._%+-]+@(?!example\.|epasts\.lv)[A-Za-z0-9.-]+\.[a-z]{2,}/.test(js + html + sql), 'nav īsta e-pasta');
  const fn = name => { const i = sql.indexOf('function public.' + name + '('); return sql.slice(i, sql.indexOf('$$;', sql.indexOf('$$', i) + 2)); };
  ok(/if not is_app_admin\(\) then raise exception 'forbidden'/.test(fn('admin_user_reports')) && /if not is_app_admin\(\) then raise exception 'forbidden'/.test(fn('admin_user_report_set')), 'ziņojumi — tikai īpašniekam');
  ok(/new\.email_confirmed_at is not null/.test(fn('app_admin_from_pending')), 'īpašnieks tikai ar apstiprinātu e-pastu');
});

// ---------- A01 (audits 07.11.2026): piedāvājuma dalībnieki nemaināmi ----------
// Uzvedību pārbauda tests/rides-guard-test.sql (lokālā PostgreSQL); šeit — ka lietotne joprojām sūta tikai {status}
// (citādi kolonnu tiesības produkcijā to noraidītu) un ka labojuma fails nav pazudis.
test('A01: dalībnieku aizsardzība un lietotne maina tikai statusu', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'rides-13-guard.sql'), 'utf8');
  ok(/new\.driver_id is distinct from old\.driver_id/.test(sql) && /new\.request_id is distinct from old\.request_id/.test(sql) && /new\.user_id is distinct from old\.user_id/.test(sql), 'trigeris sargā driver_id, request_id, user_id');
  ok(/if current_user in \('authenticated', 'anon'\)/.test(sql), 'servera funkcijas (kontu apvienošana) netiek bloķētas');
  ok(!/security definer/.test(sql.slice(sql.indexOf('function public.ride_guard_participants'), sql.indexOf('$$;'))), 'trigera funkcija NAV security definer (citādi current_user būtu īpašnieks)');
  ok(/revoke update on public\.ride_offers from public, anon, authenticated;/.test(sql) && /grant update \(status\) on public\.ride_offers to authenticated;/.test(sql) &&
     /grant update \(status\) on public\.ride_requests to authenticated;/.test(sql), 'authenticated drīkst mainīt tikai status');
  const js = fs.readFileSync(path.join(__dirname, '..', 'rides.js'), 'utf8');
  const patches = [...js.matchAll(/_rest\(`(ride_offers|ride_requests)\?[^`]*`, \{ method: 'PATCH'[^\n]*?body: JSON\.stringify\((\{[^)]*\})\)/g)];
  ok(patches.length >= 4, 'atrasti lietotnes PATCH pieprasījumi (' + patches.length + ')');
  for (const m of patches) ok(/^\{ status(: '[a-z]+')? \}$/.test(m[2]), m[1] + ' PATCH sūta tikai status: ' + m[2]);
  ok(!/(ride_offers|ride_requests)[^\n]*resolution=merge-duplicates/.test(js), 'nav upsert uz šīm tabulām (tam vajadzētu UPDATE tiesības)');
  ok(fs.existsSync(path.join(__dirname, 'rides-guard-test.sql')), 'SQL scenārija tests ir repozitorijā');
});

// ---------- A02 (audits 07.11.2026): pieņemšana vienā servera transakcijā ----------
// Uzvedību (arī divas sesijas vienlaikus) pārbauda tests/rides-accept-test.sql un tests/rides-accept-parallel.sh.
test('A02: pieņemšana caur ride_offer_accept, vecais ceļš tikai ja funkcijas vēl nav', async () => {
  const S = G('SupabaseRideStore'), missing = G('rideRpcMissing'), errText = G('rideErrorText');
  const mk = handler => { const st = Object.create(S.prototype); st.auth = { userId: 'me' }; st.calls = [];
    st._rest = async (p, o = {}) => { st.calls.push({ p, method: o.method || 'GET', body: o.body }); return handler(p, o); }; return st; };
  const err = (status, body) => Object.assign(new Error('Datubāze: ' + status), { status, body });
  // 1) Funkcija ir — tikai viens izsaukums, bez tiešiem PATCH
  let st = mk(() => ({ ok: true, already: false }));
  await st.respond('o1', 'accepted');
  eq(st.calls.length, 1); eq(st.calls[0].p, 'rpc/ride_offer_accept'); eq(st.calls[0].method, 'POST'); eq(st.calls[0].body, JSON.stringify({ oid: 'o1' }));
  // 2) Funkcijas vēl nav serverī (404 PGRST202) — vecais trīs soļu ceļš
  st = mk(p => { if (p.startsWith('rpc/')) throw err(404, '{"code":"PGRST202","message":"Could not find the function public.ride_offer_accept(oid)"}'); return [{ id: 'o1', request_id: 'r1' }]; });
  await st.respond('o1', 'accepted');
  eq(st.calls.map(c => c.method).join(','), 'POST,PATCH,PATCH,PATCH', 'rpc → pieņemt → matched → noraidīt pārējos');
  // 3) Servera atteikums (piem. otrā cilne) — NEkrīt atpakaļ uz veco ceļu, kļūda tiek parādīta
  st = mk(p => { if (p.startsWith('rpc/')) throw err(400, '{"code":"P0001","message":"request_not_open"}'); return []; });
  let caught = null; try { await st.respond('o1', 'accepted'); } catch (e) { caught = e; }
  ok(caught, 'kļūda nodota tālāk'); eq(st.calls.length, 1, 'nav tiešu PATCH pēc atteikuma');
  eq(errText(caught), 'Šis pieprasījums jau ir saskaņots vai atcelts.');
  // 4) Noraidīšana — joprojām tiešs PATCH {status}
  st = mk(() => [{ id: 'o1', request_id: 'r1' }]);
  await st.respond('o1', 'declined');
  eq(st.calls.length, 1); eq(st.calls[0].method, 'PATCH'); eq(st.calls[0].body, JSON.stringify({ status: 'declined' }));
  // rideRpcMissing atpazīst tikai īsto „funkcijas nav”
  ok(missing(err(404, 'PGRST202 ride_offer_accept'), 'ride_offer_accept'), '404 PGRST202');
  ok(!missing(err(404, 'PGRST202 cita_funkcija'), 'ride_offer_accept'), 'cita funkcija');
  ok(!missing(err(400, 'request_not_open'), 'ride_offer_accept'), '400 nav „funkcijas nav”');
  ok(!missing(new Error('Failed to fetch'), 'ride_offer_accept'), 'tīkla kļūda nav „funkcijas nav”');
  eq(errText(err(400, 'offer_not_pending')), 'Šoferis piedāvājumu atsauca vai tas vairs nav spēkā.');
  eq(errText(err(400, 'offer_not_found')), 'Piedāvājums vairs nav atrodams.');
  ok(/pārlādē lapu/.test(errText(err(403, 'Piedāvājumu pieņem tikai caur ride_offer_accept'))), 'vecā lietotne → pārlādēt');
  eq(errText(new Error('Failed to fetch')), 'Neizdevās. Pārbaudi internetu un mēģini vēlreiz.');
});
test('A02: demo krātuve — otru piedāvājumu pieņemt nevar', async () => {
  const L = G('LocalRideStore');
  const m = {}; const st = { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } };
  const store = new L(st);
  store._save({ requests: [{ id: 'r1', user_id: store.id, status: 'open' }],
    offers: [{ id: 'o1', request_id: 'r1', driver_id: 'd1', status: 'pending' }, { id: 'o2', request_id: 'r1', driver_id: 'd2', status: 'pending' }] });
  await store.respond('o1', 'accepted');
  let d = store._load(); eq(d.requests[0].status, 'matched'); eq(d.offers[1].status, 'declined');
  let caught = null; try { await store.respond('o2', 'accepted'); } catch (e) { caught = e; }
  ok(caught && /request_not_open/.test(caught.message), 'otrais pieņemšanas mēģinājums atteikts');
  d = store._load(); eq(d.offers.filter(o => o.status === 'accepted').length, 1, 'viens pieņemts');
});
test('A02: SQL labojums un lietotnes pogas', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'rides-14-accept.sql'), 'utf8');
  const fn = sql.slice(sql.indexOf('function public.ride_offer_accept'), sql.indexOf('$$;'));
  ok(/security definer/.test(fn) && /for update/.test(fn), 'funkcija ir security definer un bloķē pieprasījumu');
  ok(fn.indexOf('from ride_requests where id = rid for update') < fn.indexOf("update ride_offers set status = 'accepted'"), 'bloķē PIRMS maina');
  ok(/r\.user_id is distinct from me/.test(fn), 'pieņemt drīkst tikai pieprasījuma autors');
  ok(/revoke all on function public\.ride_offer_accept\(uuid\) from public, anon;/.test(sql), 'anon nevar izsaukt');
  ok(/create unique index ride_offers_one_accepted on public\.ride_offers \(request_id\) where status = 'accepted'/.test(sql), 'unikāls indekss');
  const guard = sql.slice(sql.indexOf('function public.ride_guard_status'));
  ok(!/security definer/.test(guard.slice(0, guard.indexOf('$$;'))), 'statusa trigeris NAV security definer');
  ok(/old\.status in \('pending', 'accepted', 'declined'\)/.test(guard), 'šoferis var atcelt arī tikko noraidītu piedāvājumu');
  ok(sql.indexOf('rides-13-guard.sql') > 0, 'norādīta palaišanas secība');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'rides-ui.js'), 'utf8');
  const rr = ui.slice(ui.indexOf('async function ridesRespond'), ui.indexOf('function ridesConfirmCancel'));
  ok(/b\.disabled = true/.test(rr) && /catch \(e\)/.test(rr) && /rideErrorText\(e\)/.test(rr) && /finally/.test(rr), 'pogas atslēdz, kļūdu parāda, sarakstu atjauno');
  ok(/ridesRespond\(e\.currentTarget, o\.id, 'accepted'\)|ridesRespond\([^)]*'accepted'\)/.test(ui) && /ridesRespond\([^)]*'declined'\)/.test(ui), 'abas pogas izmanto ridesRespond');
  ok(/cancelOffer\(o\.id\);[\s\S]{0,200}catch \(err\)[\s\S]{0,80}rideErrorText\(err\)/.test(ui), '„Atcelt” kļūda neiestrēgst');
  for (const f of ['index.html', 'index-gl.html']) {
    const h = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    ok(/rides\.js\?v=(14[7-9]|1[5-9]\d)/.test(h) && /rides-ui\.js\?v=(14[7-9]|1[5-9]\d)/.test(h), f + ': rides v147+');
  }
  ok(fs.existsSync(path.join(__dirname, 'rides-accept-test.sql')) && fs.existsSync(path.join(__dirname, 'rides-accept-parallel.sh')), 'SQL testi repozitorijā');
});

// ---------- A03 (audits 07.11.2026): brauciena gaita tikai uz priekšu ----------
// Uzvedību datubāzē pārbauda tests/rides-trip-test.sql; šeit — demo krātuve, kļūdu teksti, pogas un SQL faila saturs.
test('A03: gaita tikai uz priekšu (demo krātuve kā serveris)', async () => {
  const check = G('rideTripCheck'), errText = G('rideErrorText');
  const thr = (a, b) => { try { check(a, b); return null; } catch (e) { return e.message; } };
  eq(thr('', 'coming'), null); eq(thr('coming', 'arrived'), null); eq(thr('arrived', 'onboard'), null); eq(thr('onboard', 'done'), null);
  eq(thr('', 'onboard'), null, 'uz priekšu var izlaist soli');
  eq(thr('arrived', 'coming'), 'trip_backwards'); eq(thr('done', 'arrived'), 'trip_backwards'); eq(thr('onboard', ''), 'trip_backwards');
  eq(thr('arrived', 'done'), 'trip_not_onboard', 'pabeigt tikai pēc iekāpšanas');
  eq(thr('', 'kaut kas'), 'bad trip');
  const L = G('LocalRideStore');
  const m = {}; const st = { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } };
  const drv = new L(st); const me = drv.id;
  drv._save({ requests: [{ id: 'r1', user_id: 'pas', status: 'matched' }], offers: [{ id: 'o1', request_id: 'r1', driver_id: me, status: 'accepted', trip: '' }] });
  await drv.driverUpdate('o1', { trip: 'arrived' });
  let e1 = null; try { await drv.driverUpdate('o1', { trip: 'done' }); } catch (e) { e1 = e.message; }
  eq(e1, 'trip_not_onboard');
  await drv.driverUpdate('o1', { trip: 'onboard' });
  let e2 = null; try { await drv.cancelOffer('o1'); } catch (e) { e2 = e.message; }
  eq(e2, 'trip_started'); eq(drv._load().offers[0].status, 'accepted', 'pēc iekāpšanas neatceļ');
  await drv.driverUpdate('o1', { trip: 'done' }); eq(drv._load().requests[0].status, 'done');
  let e3 = null; try { await drv.driverUpdate('o1', { trip: 'coming' }); } catch (e) { e3 = e.message; }
  eq(e3, 'trip_backwards');
  ok(/iekāpis/.test(errText(Object.assign(new Error('x'), { status: 403, body: '{"message":"trip_started: …"}' }))), 'trip_started teksts');
  ok(/mainījusies/.test(errText(Object.assign(new Error('x'), { status: 403, body: 'trip_backwards: brauciena gaitu onboard → arrived atpakaļ mainīt nevar' }))), 'trip_backwards teksts (nevis vispārīgais „mainīt nevar”)');
  ok(/atcēla/.test(errText(Object.assign(new Error('x'), { status: 403, body: 'trip_not_active' }))), 'trip_not_active teksts');
});
test('A03: SQL labojums un lietotnes pogas', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'rides-15-trip.sql'), 'utf8');
  const guard = sql.slice(sql.indexOf('function public.ride_guard_trip'), sql.indexOf('create trigger ride_offers_guard_trip'));
  ok(guard && !/security definer/.test(guard), 'gaitas trigeris NAV security definer');
  ok(/tg_op = 'INSERT'[\s\S]{0,120}new\.trip := ''; new\.onboard_at := null; new\.done_at := null;/.test(guard), 'jauns piedāvājums sākas no nulles');
  ok(/ride_trip_rank\(new\.trip\) < public\.ride_trip_rank\(old\.trip\)/.test(guard) && /trip_backwards/.test(guard), 'atpakaļ nevar (arī servera funkcijas — pārbaude nav ierobežota ar lomu)');
  ok(/new\.trip = 'done' and old\.trip <> 'onboard'/.test(guard), 'pabeigt tikai pēc iekāpšanas');
  ok(/when old\.onboard_at is not null then old\.onboard_at/.test(guard) && /when old\.done_at is not null then old\.done_at/.test(guard), 'notikumu laiki nemaināmi');
  ok(/if client and new\.status is distinct from old\.status and old\.onboard_at is not null/.test(guard), 'pēc iekāpšanas lietotne neatceļ');
  ok(/not client and current_setting\('cz\.trip_repair', true\) = 'on'/.test(guard), 'labošanas slēdzis tikai īpašniekam');
  ok(/create trigger ride_offers_guard_trip before insert or update on public\.ride_offers/.test(sql), 'trigeris uz insert un update');
  ok(/create trigger ride_requests_guard_started before update of status on public\.ride_requests/.test(sql), 'pasažieris neatceļ pēc iekāpšanas');
  const du = sql.slice(sql.indexOf('function public.ride_driver_update'));
  ok(/for update/.test(du) && /rst is distinct from 'matched'/.test(du) && /where id = o\.request_id and status = 'matched'/.test(du), 'ride_driver_update — tikai saskaņotam braucienam');
  ok(/o\.onboard_at is null and o\.trip in \('', 'coming', 'arrived'\)/.test(sql), 'atmaksas kandidāti — tikai pirms iekāpšanas');
  ok(sql.indexOf('update public.ride_offers set onboard_at') < sql.indexOf('create trigger ride_offers_guard_trip'), 'esošie dati aizpildīti PIRMS trigera');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'rides-ui.js'), 'utf8');
  const cc = ui.slice(ui.indexOf('function ridesConfirmCancel'), ui.indexOf('function ridesDriveView'));
  ok(/catch \(err\)[\s\S]{0,60}rideErrorText\(err\)/.test(cc) && /finally \{ ridesRefresh\(true\); \}/.test(cc), 'pasažiera „Jā, atcelt” kļūda neiestrēgst');
  ok(/if \(st !== 'onboard'\) acts\.append/.test(ui), '„Atcelt” paslēpts ceļā (abām lomām)');
  for (const f of ['index.html', 'index-gl.html']) {
    const h = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    ok(/rides\.js\?v=(14[89]|1[5-9]\d)/.test(h) && /rides-ui\.js\?v=(14[89]|1[5-9]\d)/.test(h), f + ': rides v148+');
  }
  ok(fs.existsSync(path.join(__dirname, 'rides-trip-test.sql')), 'SQL scenārija tests repozitorijā');
});

// ---------- A04 (audits 07.11.2026): viena maksājuma lapa braucienam ----------
// ride-pay/index.ts bloks <checkout-flow> pret Stripe un datubāzes imitāciju. Imitācija dara to pašu, ko Stripe ar
// Idempotency-Key (tā pati atslēga → tā pati sesija; kamēr pirmais pieprasījums vēl iet — 409) un ride_checkout_save (SQL).
{
  const mkWorld = (opts = {}) => {
    const w = { sessions: new Map(), keys: new Map(), inflight: new Set(), created: 0, expired: [], row: null, n: 0, stripeDown: false };
    const tick = () => new Promise(r => setTimeout(r, opts.lag ?? 5));
    w.deps = {
      begin: async () => { await tick(); return w.row ? { session_id: w.row.session_id, attempt: w.row.attempt } : { session_id: null, attempt: 0 }; },
      retrieve: async id => { await tick(); return w.stripeDown ? null : (w.sessions.get(id) || null); },
      create: async (params, key) => {
        if (key && w.keys.has(key)) { const k = w.keys.get(key); if (k.params !== JSON.stringify(params)) throw Object.assign(new Error('idem'), { stripeStatus: 400, stripeType: 'idempotency_error' }); return w.sessions.get(k.id); }
        if (key && w.inflight.has(key)) throw Object.assign(new Error('in flight'), { stripeStatus: 409, stripeType: 'idempotency_error' });
        if (key) w.inflight.add(key);
        await tick(); await tick();
        const id = 'cs_test_' + (++w.n).toString().padStart(12, '0');
        const s = { id, url: 'https://checkout.stripe.test/' + id, status: 'open', payment_status: 'unpaid', amount_total: params ? params.amount : 500, metadata: { offer_id: 'o1' } };
        w.sessions.set(id, s); w.created++;
        if (key) { w.keys.set(key, { id, params: JSON.stringify(params) }); w.inflight.delete(key); }
        return s;
      },
      expire: async id => { await tick(); const s = w.sessions.get(id); if (s && s.status === 'open') { s.status = 'expired'; w.expired.push(id); } },
      save: async (id, attempt) => {                       // tas pats, ko ride_checkout_save
        await tick();
        if (!w.row) { w.row = { session_id: id, attempt, status: 'created' }; return true; }
        if (w.row.session_id === id) { w.row.attempt = Math.max(w.row.attempt, attempt); return true; }
        if (w.row.status !== 'created' || attempt <= w.row.attempt) return false;
        w.row = { ...w.row, session_id: id, attempt }; return true;
      },
      sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 20))),
    };
    w.open = () => [...w.sessions.values()].filter(s => s.status === 'open').length;
    return w;
  };
  const P = { amount: 500 };
  const O = { oid: 'o1', price_cents: 500 };
  // Kods tiek ņemts tieši no ride-pay/index.ts (bloks <checkout-flow>), lai tests pārbauda to pašu, kas tiek izvietots
  const load = async () => {
    const ts = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'ride-pay', 'index.ts'), 'utf8');
    const m = ts.match(/\/\/ <checkout-flow>[^\n]*\n([\s\S]*?)\/\/ <\/checkout-flow>/);
    if (!m) throw new Error('nav <checkout-flow> bloka');
    const strip = require('module').stripTypeScriptTypes;
    if (typeof strip !== 'function') throw new Error('vajag Node 22.13+ (module.stripTypeScriptTypes)');
    const warn = process.emitWarning; process.emitWarning = () => {};
    let js; try { js = strip(m[1]); } finally { process.emitWarning = warn; }
    return new Function(js + '\nreturn { checkoutFlow, checkoutKey, CheckoutError, CHECKOUT_KEY_PREFIX };')();
  };

  test('A04: imitācija atklāj veco kļūdu (bez atslēgas divi klikšķi → divas sesijas)', async () => {
    const w = mkWorld();
    // vecā ride-pay loģika: nolasa rindu, ja nav — veido jaunu sesiju bez atslēgas un raksta virsū
    const old = async () => { const r = await w.deps.begin(); if (!r.session_id) { const s = await w.deps.create(P, null); w.row = { session_id: s.id, attempt: 1, status: 'created' }; return s.url; } return w.sessions.get(r.session_id).url; };
    const [a, b] = await Promise.all([old(), old()]);
    eq(w.created, 2, 'divas sesijas'); ok(a !== b, 'divas dažādas maksājuma lapas');
  });
  test('A04: divi vienlaicīgi klikšķi → viena sesija, viena lapa', async () => {
    const { checkoutFlow } = await load();
    const w = mkWorld();
    const [a, b] = await Promise.all([checkoutFlow(w.deps, O, P), checkoutFlow(w.deps, O, P)]);
    eq(w.created, 1, 'Stripe izveidoja vienu sesiju'); eq(a.url, b.url, 'abiem tā pati lapa'); eq(w.row.attempt, 1); eq(w.open(), 1);
  });
  test('A04: desmit vienlaicīgi pieprasījumi → viena sesija', async () => {
    const { checkoutFlow } = await load();
    const w = mkWorld({ lag: 3 });
    const all = await Promise.all(Array.from({ length: 10 }, () => checkoutFlow(w.deps, O, P)));
    eq(w.created, 1); eq(new Set(all.map(r => r.url)).size, 1); eq(w.open(), 1);
  });
  test('A04: atvērtu sesiju atdod atkārtoti; beigušās vietā — jauna ar nākamo numuru', async () => {
    const { checkoutFlow, checkoutKey } = await load();
    const w = mkWorld();
    const a = await checkoutFlow(w.deps, O, P);
    const b = await checkoutFlow(w.deps, O, P);
    eq(b.url, a.url); eq(b.reused, true); eq(w.created, 1);
    w.sessions.get(a.session_id).status = 'expired';
    const c = await checkoutFlow(w.deps, O, P);
    ok(c.url !== a.url, 'jauna lapa'); eq(w.row.attempt, 2); eq(w.created, 2); eq(w.open(), 1);
    ok(w.keys.has(checkoutKey('o1', 2)), 'atslēga ar numuru 2');
    const [d, e] = await Promise.all([checkoutFlow(w.deps, O, P), checkoutFlow(w.deps, O, P)]);
    eq(d.url, c.url); eq(e.url, c.url); eq(w.created, 2);
  });
  test('A04: samaksāts / apstrādē / Stripe neatbild — jaunu sesiju neveido', async () => {
    const { checkoutFlow } = await load();
    const code = async (w) => { try { await checkoutFlow(w.deps, O, P); return 'ok'; } catch (e) { return e.code + ':' + e.status; } };
    let w = mkWorld(); const a = await checkoutFlow(w.deps, O, P);
    w.sessions.get(a.session_id).payment_status = 'paid'; w.sessions.get(a.session_id).status = 'complete';
    eq(await code(w), 'already_paid:409'); eq(w.created, 1);
    w = mkWorld(); const b = await checkoutFlow(w.deps, O, P);
    w.sessions.get(b.session_id).status = 'complete';
    eq(await code(w), 'processing:409'); eq(w.created, 1);
    w = mkWorld(); await checkoutFlow(w.deps, O, P); w.stripeDown = true;
    eq(await code(w), 'stripe_unreachable:502'); eq(w.created, 1, 'vecā vēl varētu būt apmaksājama — jaunu neveido');
  });
  test('A04: cita summa — veco aizver, tad jauna (vienlaikus apmaksājama tikai viena)', async () => {
    const { checkoutFlow } = await load();
    const w = mkWorld(); const a = await checkoutFlow(w.deps, O, P);
    const r = await checkoutFlow(w.deps, { oid: 'o1', price_cents: 700 }, { amount: 700 });
    ok(r.url !== a.url); eq(w.expired[0], a.session_id, 'vecā aizvērta'); eq(w.open(), 1);
  });
  test('A04: atslēga ar citiem datiem (cits logs) → saprotama kļūda, nevis otra sesija', async () => {
    const { checkoutFlow, checkoutKey } = await load();
    const w = mkWorld();
    w.keys.set(checkoutKey('o1', 1), { id: 'x', params: '{"amount":1}' });
    let err = null; try { await checkoutFlow(w.deps, O, P); } catch (e) { err = e; }
    eq(err && err.code, 'in_other_tab'); eq(w.created, 0);
  });
  test('A04: atslēga atdod vecu beigušos sesiju (saglabāšana bija neizdevusies) → nākamais numurs', async () => {
    const { checkoutFlow, checkoutKey } = await load();
    const w = mkWorld();
    const old = await w.deps.create(P, checkoutKey('o1', 1)); old.status = 'expired';    // izveidota, bet datubāzē nav
    const r = await checkoutFlow(w.deps, O, P);
    ok(r.url !== old.url, 'jauna lapa'); eq(w.row.attempt, 2); eq(w.open(), 1);
  });
  test('A04: ride-pay izmanto checkoutFlow un idempotences atslēgu; SQL fails', () => {
    const ts = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'ride-pay', 'index.ts'), 'utf8');
    ok(/\/\/ <checkout-flow>/.test(ts) && /\/\/ <\/checkout-flow>/.test(ts) && ts.indexOf('// <checkout-flow>') < ts.indexOf("case 'checkout':"), 'checkoutFlow tajā pašā failā (viens fails izvietošanai)');
    const ck = ts.slice(ts.indexOf("case 'checkout':"), ts.indexOf("case 'status':"));
    ok(/checkoutFlow\(/.test(ck) && /rpc\/ride_checkout_begin/.test(ck) && /rpc\/ride_checkout_save/.test(ck), 'checkout iet caur checkoutFlow');
    ok(/stripe\('checkout\/sessions', params\(await needAcct\(\)\), key\)/.test(ck), 'sesiju veido ar atslēgu');
    ok(!/resolution=merge-duplicates/.test(ck) && !/db\('ride_payments', \{ method: 'POST'/.test(ck), 'vairs nav aklas pārrakstīšanas');
    ok(!/Date\.now\(\)|expires_at|Math\.random/.test(ck), 'parametros nav mainīgu vērtību (citādi atslēga nestrādātu)');
    ok(/f\.stripeStatus = r\.status; f\.stripeType = j\?\.error\?\.type;/.test(ts), 'Stripe kļūdas statuss un tips saglabāts');
    const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'rides-16-checkout.sql'), 'utf8');
    ok(/function public\.ride_checkout_save[\s\S]*for update of o[\s\S]*for update;/.test(sql), 'saglabāšana bloķē rindas');
    ok(/if p\.status <> 'created' or p_attempt <= p\.attempt then return false;/.test(sql), 'vecāks / samaksāts netiek pārrakstīts');
    ok(/revoke all on function public\.ride_checkout_begin\(uuid\) from public, anon;/.test(sql), 'anon nevar');
    ok(/if tg_op = 'INSERT' then new\.attempt := 1; else new\.attempt := old\.attempt;/.test(sql), 'klients numuru nemaina');
    ok(fs.existsSync(path.join(__dirname, 'rides-checkout-test.sql')), 'SQL scenārija tests');
  });
}

// ---------- A05 (audits 07.11.2026): viena atmaksas stāvokļa loģika ----------
{
  const RP = path.join(__dirname, '..', 'supabase', 'functions', 'ride-pay', 'index.ts');
  const WH = path.join(__dirname, '..', 'supabase', 'functions', 'stripe-webhook', 'index.ts');
  const blockOf = f => { const m = fs.readFileSync(f, 'utf8').match(/\/\/ <refund-state>[\s\S]*?\/\/ <\/refund-state>/); return m ? m[0] : null; };
  const loadRS = () => {
    const strip = require('module').stripTypeScriptTypes;
    const warn = process.emitWarning; process.emitWarning = () => {};
    let js; try { js = strip(blockOf(RP)); } finally { process.emitWarning = warn; }
    return new Function(js + '\nreturn { refundState, refundKey };')();
  };
  const R = (amount, status, created = 1, id = 're_' + status + created) => ({ id, amount, status, created, metadata: { cz_reason: 'driver_refund' } });

  test('A05: abas servera funkcijas lieto VIENU UN TO PAŠU atmaksas loģiku', () => {
    const a = blockOf(RP), b = blockOf(WH);
    ok(a && b, 'bloks <refund-state> abos failos'); eq(a, b, 'bloki burtiski vienādi');
    for (const f of [RP, WH]) {
      const t = fs.readFileSync(f, 'utf8');
      ok(!/refundedCents|okRefunds|amount_refunded/.test(t.replace(/\/\/[^\n]*/g, '').replace(/application_fees[\s\S]*?f\.amount_refunded/, '')), path.basename(path.dirname(f)) + ': vecā atmaksas loģika izņemta');
    }
  });
  test('A05: imitācija atklāj veco kļūdu (daļēja / gaidoša atmaksa = „atmaksāts”)', () => {
    // agrākā loģika: refundedCents = charge.amount_refunded vai succeeded+pending summa; > 0 → „atmaksāts”
    const old = refunds => refunds.filter(r => r.status === 'succeeded' || r.status === 'pending').reduce((a, r) => a + r.amount, 0) > 0;
    const { refundState } = loadRS();
    eq(old([R(200, 'succeeded')]), true, 'vecā: 2 € no 5 € = atmaksāts'); eq(refundState(500, [R(200, 'succeeded')]).full, false, 'jaunā: nav pilna');
    eq(old([R(500, 'pending')]), true, 'vecā: gaidoša = atmaksāts'); eq(refundState(500, [R(500, 'pending')]).full, false, 'jaunā: nav pilna');
  });
  test('A05: refundState — nav, daļēja, apstrādē, pilna, neizdevusies', () => {
    const { refundState: rs, refundKey } = loadRS();
    let x = rs(500, []);
    eq(x.state, 'none'); eq(x.refunded, 0); eq(x.remaining, 500); eq(x.full, false);
    x = rs(500, [R(200, 'succeeded')]);
    eq(x.state, 'partial'); eq(x.refunded, 200); eq(x.remaining, 300); eq(x.full, false); eq(x.refundId, 're_succeeded1');
    x = rs(500, [R(500, 'pending')]);
    eq(x.state, 'pending'); eq(x.pending, 500); eq(x.refunded, 0); eq(x.remaining, 0); eq(x.full, false);
    eq(rs(500, [R(500, 'requires_action')]).state, 'pending', 'requires_action = apstrādē');
    x = rs(500, [R(200, 'succeeded', 1), R(300, 'pending', 2)]);
    eq(x.state, 'pending'); eq(x.refunded, 200); eq(x.pending, 300); eq(x.remaining, 0);
    x = rs(500, [R(200, 'succeeded', 1), R(300, 'succeeded', 5, 're_last')]);
    eq(x.state, 'full'); eq(x.full, true); eq(x.refunded, 500); eq(x.refundId, 're_last', 'jaunākā atmaksa'); eq(x.reason, 'driver_refund');
    x = rs(500, [R(500, 'failed'), R(500, 'canceled', 2)]);
    eq(x.state, 'none', 'neizdevusies netiek skaitīta'); eq(x.failed, 2); eq(x.remaining, 500);
    eq(rs(500, [R(600, 'succeeded')]).full, true, 'vairāk par summu — pilna');
    eq(rs(0, [R(100, 'succeeded')]).full, false, 'nesamaksātam nav „pilnas atmaksas”');
    eq(rs(500, [null, { amount: 'x', status: 'succeeded' }]).refunded, 0, 'bojāti dati netiek skaitīti');
    // atslēga: vienāda vienlaicīgiem klikšķiem, jauna pēc daļējas vai neizdevušās atmaksas
    eq(refundKey('o1', rs(500, [])), refundKey('o1', rs(500, [])));
    ok(refundKey('o1', rs(500, [])) !== refundKey('o1', rs(500, [R(200, 'succeeded')])), 'pēc daļējas — jauna atslēga');
    ok(refundKey('o1', rs(500, [])) !== refundKey('o1', rs(500, [R(500, 'failed')])), 'pēc neizdevušās — jauna atslēga');
  });
  test('A05: ride-pay un webhook — „refunded” tikai pilnai atmaksai; gaidošai otru neveido', () => {
    const rp = fs.readFileSync(RP, 'utf8'), wh = fs.readFileSync(WH, 'utf8');
    const fn = rp.slice(rp.indexOf('const refund = async'), rp.indexOf('const body = await req.json()'));
    ok(/if \(st\.full\) \{/.test(fn) && /if \(st\.pending > 0\) return result\(st, true\);/.test(fn), 'pilna → jau; apstrādē → otru neveido');
    ok(!/amount:/.test(fn.slice(fn.indexOf("stripe('refunds'"), fn.indexOf('refundKey(oid, st)'))), 'atmaksā atlikumu (bez summas)');
    ok(/const again = await payInfo\(p\.session_id, oid\);/.test(fn), 'kļūdas gadījumā pārbauda vēlreiz (otrs dalībnieks tieši tagad atmaksāja)');
    ok(/if \(st2\.full\) await mark\(oid, 'refunded'/.test(fn), 'refunded — tikai pēc pilnas');
    ok(/refunded: i\.rs\.full, refund_cents: i\.rs\.refunded,\s*refund_pending_cents: i\.rs\.pending, refund_state: i\.rs\.state/.test(rp), "'status' atdod pilnu / atmaksāto / gaidošo atsevišķi");
    ok(/if \(i\.rs\.full\) \{/.test(rp) && /if \(i && i\.rs\.full\) recent\.push/.test(rp), "'sync' un 'refund_sync' — tikai pilna");
    ok(/if \(ch && ch\.refunds\?\.has_more\)/.test(rp) && /if \(ch && ch\.refunds\?\.has_more\)/.test(wh), 'vairāk par 10 atmaksām — nolasa visas');
    for (const ev of ['charge.refunded', 'charge.refund.updated', 'refund.created', 'refund.updated', 'refund.failed']) ok(wh.includes(`case '${ev}':`), 'webhook: ' + ev);
    ok(!/amount_refunded\) < Number\(obj\.amount\)/.test(wh), 'webhook vairs neizlemj pēc notikuma laukiem');
    ok(/if \(info\.paid && row\.status === 'created' && await mark\('paid'\)\) res = 'paid';/.test(wh), 'samaksāts tiek pierakstīts arī, ja daļēji atmaksāts');
  });
  test('A05: lietotne — pilna, daļēja un gaidoša atmaksa atšķirīgi', () => {
    const ri = G('rideRefundInfo'), pt = G('ridePayText');
    eq(ri(null, 500).state, 'none');
    eq(ri({ paid: true, amount: 500, refunded: true, refund_cents: 500 }, 500).text, '↩ Atmaksāts 5,00 €');
    const part = ri({ paid: true, amount: 500, refunded: false, refund_cents: 200, refund_state: 'partial' }, 500);
    eq(part.state, 'partial'); eq(part.remaining, 300); ok(/Daļēji atmaksāts 2,00 € no 5,00 €/.test(part.text), part.text);
    const pend = ri({ paid: true, amount: 500, refunded: false, refund_cents: 0, refund_pending_cents: 500, refund_state: 'pending' }, 500);
    eq(pend.state, 'pending'); ok(/apstrādē 5,00 €/.test(pend.text), pend.text);
    eq(ri({ paid: true, amount: 500, refunded: true, refund_cents: 500 }, 500).state, 'full', 'vecāka servera atbilde (bez refund_state)');
    ok(/Daļēji/.test(pt({ price_cents: 500 }, { paid: true, amount: 500, refund_cents: 200, refund_state: 'partial' })), 'vēsturē daļēja');
    eq(pt({ price_cents: 500, pay_status: 'paid' }, null), 'Samaksāts ar karti');
    const ui = fs.readFileSync(path.join(__dirname, '..', 'rides-ui.js'), 'utf8');
    ok(/const amount = rideRefundInfo\(p, o\.price_cents\)\.remaining/.test(ui), 'pēc daļējas — poga atmaksā atlikumu');
    ok(/else if \(r && r\.pending && !r\.already\)/.test(ui), 'automātiskā atmaksa apstrādē — atsevišķa ziņa');
    for (const f of ['index.html', 'index-gl.html']) {
      const h = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      ok(/rides\.js\?v=149/.test(h) && /rides-ui\.js\?v=149/.test(h), f + ': rides v149');
    }
  });
}

// ---------- A06 (audits 07.11.2026): noteikumos un privātuma politikā aizpildīts sniedzējs un kontakts ----------
test('A06: noteikumi un privātuma politika — sniedzējs, kontakts, nekas nav palicis neaizpildīts', () => {
  const SUPPORT = 'support.travel24@gmail.com';
  for (const f of ['terms.html', 'privacy.html']) {
    const h = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    ok(!/AIZPILD/i.test(h), f + ': nav [AIZPILDĪT]');
    ok(!/class="todo"/.test(h), f + ': nav piezīmes „vēl jāpapildina”');
    ok(/<b>Ričards Liepa<\/b>, privātpersona, Latvija/.test(h), f + ': sniedzējs / pārzinis');
    ok(h.includes(`<a href="mailto:${SUPPORT}">${SUPPORT}</a>`), f + ': atbalsta e-pasts kā saite');
    // Publiskajās lapās drīkst būt TIKAI atbalsta adrese (ne īpašnieka personīgā)
    const mails = [...new Set((h.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []))];
    eq(mails.join(','), SUPPORT, f + ': vienīgā e-pasta adrese');
  }
  const t = fs.readFileSync(path.join(__dirname, '..', 'terms.html'), 'utf8');
  eq((t.match(/support\.travel24@gmail\.com<\/a>/g) || []).length, 2, 'terms.html: kontakts 1. punktā un pie maksājumiem');
  const pr = fs.readFileSync(path.join(__dirname, '..', 'privacy.html'), 'utf8');
  eq((pr.match(/support\.travel24@gmail\.com<\/a>/g) || []).length, 2, 'privacy.html: pārzinis un tiesību punkts');
  // Versijas nemainītas: tikai identitātes aizpildīšana, lietotājiem atkārtoti piekrist nav jāprasa
  ok(/Versija 2026-10-23/.test(t) && /CZ_TERMS_VERSION = '2026-10-23'/.test(fs.readFileSync(path.join(__dirname, '..', 'auth.js'), 'utf8')), 'noteikumu versija sakrīt ar auth.js');
  ok(/Versija 2026-11-01/.test(pr) && /CZ_PRIVACY_VERSION = '2026-11-01'/.test(fs.readFileSync(path.join(__dirname, '..', 'auth.js'), 'utf8')), 'politikas versija sakrīt ar auth.js');
});

// ---------- A07 (audits 07.11.2026): MapLibre 6.15.0 (XSS labojums GHSA-jrc7-96c5-q579, ≥ 6.4.1) ----------
test('A07: MapLibre 6.15.0 — ES modulis pirms visiem skriptiem, pārējie defer', () => {
  for (const f of ['index.html', 'index-gl.html']) {
    const h = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    ok(!/maplibre-gl@[45]\./.test(h), f + ': vecā MapLibre izņemta');
    const vers = [...h.matchAll(/maplibre-gl@(\d+)\.(\d+)\.(\d+)/g)].map(m => m.slice(1).map(Number));
    eq(vers.length, 2, f + ': css + modulis');
    for (const [a, b, c] of vers) ok(a > 6 || (a === 6 && (b > 4 || (b === 4 && c >= 1))), f + ': versija ≥ 6.4.1 (' + [a, b, c].join('.') + ')');
    ok(h.includes('href="https://unpkg.com/maplibre-gl@6.15.0/dist/maplibre-gl.css"'), f + ': css 6.15.0');
    const mod = `<script type="module">import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.15.0/dist/maplibre-gl.mjs'; window.maplibregl = maplibregl;</script>`;
    ok(h.includes(mod), f + ': modulis uzliek window.maplibregl');
    const after = h.slice(h.indexOf(mod) + mod.length);
    const tags = after.match(/<script\b[^>]*>/g) || [];
    ok(tags.length >= 25, f + ': skripti pēc moduļa');
    ok(tags.every(t => /\sdefer\s/.test(t) && /\ssrc="/.test(t)), f + ': visi nākamie skripti ir defer (izpildās pēc moduļa, tajā pašā secībā)');
    ok(!/<script>/.test(h), f + ': nav iekļautu (inline) klasisko skriptu, kas izpildītos ārpus secības');
    ok(/app-gl\.js\?v=150/.test(h) && /signs-gl\.js\?v=150/.test(h), f + ': mainītie faili ar jaunu versiju');
  }
});
test('A07: trūkstošie attēli (MapLibre 6) un skaidra ziņa, ja karte neielādējas', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app-gl.js'), 'utf8');
  ok(/if \(typeof map\.setMissingStyleImageResolver === 'function'\) map\.setMissingStyleImageResolver\(resolveImage\);\s*else map\.on\('styleimagemissing', e => \{ resolveImage\(e\.id\); \}\);/.test(app), 'resolver (6) ar rezervi (4/5)');
  ok(/if \(typeof maplibregl === 'undefined' \|\| !maplibregl\.Map\)/.test(app), 'modulis neielādējās → ziņa');
  ok(/zoomLevelsToOverscale: undefined,/.test(app), 'ceļu flīzes kā MapLibre 4 (bez sadalīšanas virs maxzoom)');
  ok(/try \{\s*map = new maplibregl\.Map\(\{[\s\S]{0,700}\}\);\s*\} catch \(e\) \{[\s\S]{0,200}vajag WebGL2/.test(app), 'nav WebGL2 → ziņa');
  ok(!/antialias|preserveDrawingBuffer|map\.transform\b|\.on\([^)]*\)\.on\(/.test(app), 'nav MapLibre 5/6 noņemto API');
  const sg = fs.readFileSync(path.join(__dirname, '..', 'signs-gl.js'), 'utf8');
  const li = sg.slice(sg.indexOf('  loadImage(id) {'), sg.indexOf('  // Atjauno kartē redzamās zīmes'));
  ok(/if \(this\.map\.hasImage\(id\)\) return Promise\.resolve\(\);/.test(li) && /if \(this\._pend\.has\(id\)\) return this\._pend\.get\(id\);/.test(li) && /return p;\s*\}\s*$/.test(li), 'loadImage atgriež solījumu (vienu uz attēlu)');
  ok((li.match(/end\(\)/g) || []).length >= 3 && /f\.onerror = end;/.test(li), 'solījums izpildās arī kļūdas gadījumā (karte negaida mūžīgi)');
  ok(fs.existsSync(path.join(__dirname, 'map-smoke.js')), 'kartes dūmu tests repozitorijā');
});

// ---------- A08 (audits 07.11.2026): atkārtojami testi visur + automātiski GitHub ----------
test('A08: LF rindu beigas, GitHub Actions (Linux + Windows, datubāze, karte)', () => {
  const ga = fs.readFileSync(path.join(__dirname, '..', '.gitattributes'), 'utf8');
  ok(/^\* text=auto eol=lf$/m.test(ga) && /^\*\.png binary$/m.test(ga), '.gitattributes: LF, attēli bināri');
  // CRLF fails dod tieši to pašu saturu (Windows ar core.autocrlf)
  const tmp = path.join(require('os').tmpdir(), 'cz-crlf-' + process.pid + '.txt');
  readRaw.call(fs, __filename);                     // oriģinālā funkcija joprojām pieejama
  require('fs').writeFileSync(tmp, 'a\r\nb\r\n');
  eq(fs.readFileSync(tmp, 'utf8'), 'a\nb\n', 'CRLF → LF'); require('fs').unlinkSync(tmp);
  const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'tests.yml'), 'utf8');
  ok(/pull_request:/.test(wf) && /branches: \[main\]/.test(wf), 'katrai izmaiņai main un pull request');
  ok(/os: \[ubuntu-latest, windows-latest\]/.test(wf) && /- run: node tests\/run\.js/.test(wf), 'JS testi Linux un Windows');
  ok(/image: postgres:16/.test(wf) && /- run: bash tests\/run-sql\.sh/.test(wf), 'datubāzes testi');
  ok(/node tests\/map-smoke\.js \. /.test(wf) && /releases\/download\/v\$V\/dist\.zip/.test(wf), 'kartes tests ar lietotnes MapLibre versiju');
  ok(/permissions:\s*\n\s*contents: read/.test(wf) && !/secrets\./.test(wf), 'tikai lasīšanas tiesības, bez slepenajām atslēgām');
});
test('A08: datubāzes testos ir VISI supabase/*.sql faili un visi SQL scenāriji', () => {
  const sh = fs.readFileSync(path.join(__dirname, 'run-sql.sh'), 'utf8');
  const steps = (sh.match(/STEPS=\(([\s\S]*?)\n\)/) || [])[1] || '';
  const listed = new Set([...steps.matchAll(/\bs:([\w.-]+\.sql)/g)].map(m => m[1]));
  // A09: migrācijas — visi supabase/*.sql, izņemot ģenerēto pārbaudi status.sql
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'supabase')).filter(f => f.endsWith('.sql') && f !== 'status.sql')) ok(listed.has(f), 'run-sql.sh: trūkst supabase/' + f);
  const tests = new Set([...steps.matchAll(/\bt:([\w.-]+\.sql)/g)].map(m => m[1]));
  for (const f of fs.readdirSync(__dirname).filter(f => /-test\.sql$/.test(f))) ok(tests.has(f), 'run-sql.sh: netiek palaists tests/' + f);
  ok(/\bp:rides-accept-parallel\.sh\b/.test(steps), 'paralēlais tests');
  for (const f of ['rides-13-guard.sql', 'rides-14-accept.sql', 'rides-15-trip.sql', 'rides-16-checkout.sql'])
    eq((steps.match(new RegExp('s:' + f.replace(/[.-]/g, '\\$&'), 'g')) || []).length, 2, f + ' palaists divreiz (atkārtojams)');
  ok(steps.indexOf('s:rides-16-checkout.sql') < steps.indexOf('t:rides-guard-test.sql'), 'drošības scenāriji pēc labojumiem');
  ok(/\[ "\$fail" -eq 0 \]\s*$/.test(sh), 'kods 1, ja kaut kas neizdevās');
  ok(fs.existsSync(path.join(__dirname, 'sql', 'supabase-stub.sql')), 'Supabase aizstājējs testiem');
});

// ---------- A09 (audits 08.11.2026): sakārtotas migrācijas, pārbaude, aizsardzība, jauns README ----------
{
  const SUP = path.join(__dirname, '..', 'supabase');
  const order = fs.readFileSync(path.join(SUP, 'ORDER.txt'), 'utf8').split('\n').filter(l => l.trim() && !l.trim().startsWith('#'))
    .map(l => { const [n, f] = l.trim().split(/\s+/); return { n: +n, f }; });
  test('A09: ORDER.txt — visi migrāciju faili, pēc kārtas, bez dublikātiem', () => {
    order.forEach((x, i) => eq(x.n, i + 1, 'numuri pēc kārtas: ' + x.f));
    const files = fs.readdirSync(SUP).filter(f => f.endsWith('.sql') && f !== 'status.sql').sort();
    eq(order.map(x => x.f).slice().sort().join(','), files.join(','), 'ORDER.txt = visi supabase/*.sql (izņemot status.sql)');
    eq(new Set(order.map(x => x.f)).size, order.length, 'bez dublikātiem');
    eq(order[order.length - 1].f, 'rides-17-migrations.sql', 'pēdējā — migrāciju uzskaite');
    // run-sql.sh 1. daļā shēmas faili tajā pašā secībā (izņemot coins-3: testu dēļ pēc kopbraucienu scenārijiem — neatkarīgi)
    const sh = fs.readFileSync(path.join(__dirname, 'run-sql.sh'), 'utf8');
    const steps = [...((sh.match(/STEPS=\(([\s\S]*?)\n\)/) || [])[1] || '').matchAll(/\bs:([\w.-]+\.sql)/g)].map(m => m[1]);
    const firstSeen = steps.filter((f, i) => steps.indexOf(f) === i && f !== 'coins-3-skins.sql');
    eq(firstSeen.join(','), order.map(x => x.f).filter(f => f !== 'coins-3-skins.sql').join(','), 'run-sql.sh secība = ORDER.txt');
    ok(/mapfile -t ORDER < <\(grep -vE '\^\[\[:space:\]\]\*\(#\|\$\)' supabase\/ORDER\.txt/.test(sh), '2. daļa būvē tieši pēc ORDER.txt');
  });
  test('A09: veco failu aizsardzība — tieši tiem, kuru atkārtošana maina datubāzi', () => {
    const guarded = ['rides-2-chat-trip.sql', 'rides-3-pay.sql', 'rides-7-account.sql', 'radars.sql', 'traffic.sql', 'traffic-2-helpers.sql',
      'reports.sql', 'rides-8-refund.sql', 'rides-9-ratings.sql', 'stats-f16.sql', 'coins-1.sql'];
    for (const { n, f } of order) {
      const s = fs.readFileSync(path.join(SUP, f), 'utf8');
      const g = s.match(/if exists \(select 1 from public\.cz_migrations where seq > (\d+)\)/);
      if (guarded.includes(f)) {
        ok(g && +g[1] === n, f + ': aizsardzība ar savu numuru ' + n);
        ok(s.indexOf("if to_regclass('public.cz_migrations') is not null then") < s.indexOf('if exists (select 1 from public.cz_migrations'), f + ': ārējais if (tabulas var vēl nebūt)');
        const firstStmt = s.split('\n').findIndex(l => l.trim() && !l.startsWith('--'));
        ok(s.split('\n')[firstStmt] === 'do $$ begin', f + ': aizsardzība ir pirmā darbība failā');
        ok(s.includes(`raise exception '${f} (Nr. ${n}) ir vecs migrācijas fails`), f + ': skaidrs teksts');
      } else ok(!g, f + ': bez veco failu aizsardzības (to drīkst palaist atkārtoti)');
    }
    const m = fs.readFileSync(path.join(SUP, 'rides-17-migrations.sql'), 'utf8');
    ok(/create table if not exists public\.cz_migrations/.test(m) && /enable row level security/.test(m) && /revoke all on public\.cz_migrations from public, anon, authenticated;/.test(m), 'uzskaites tabula lietotnei neredzama');
    for (const { n, f } of order.slice(0, 25)) ok(m.includes(`(${n}, '${f}', 'pirms uzskaites')`), 'rides-17 atzīmē ' + f);
    ok(/revoke all on function public\.cz_migration_begin\(int, text\) from public, anon, authenticated;/.test(m), 'palīgfunkcijas lietotnei nav pieejamas');
    ok(/to_regprocedure\('public\.ride_checkout_save\(uuid, text, integer\)'\) is null/.test(m), 'prasa, lai iepriekšējie faili jau palaisti');
  });
  test('A09: status.sql — ģenerēts, tikai lasa, aptver funkcijas, tiesības un migrācijas', () => {
    const st = fs.readFileSync(path.join(SUP, 'status.sql'), 'utf8');
    ok(/ŠIS FAILS IR ĢENERĒTS/.test(st) && /bash tests\/gen-status\.sh/.test(st), 'ģenerēts');
    const code = st.replace(/--[^\n]*/g, '');
    ok(!/\b(insert|update|delete|drop|create|alter|grant|revoke|truncate)\b/i.test(code.replace(/'[^']*'/g, "''")), 'tikai lasa (nav rakstīšanas komandu)');
    for (const fn of ['ride_driver_update(', 'ride_offer_accept(', 'ride_checkout_save(', 'ride_guard_trip(', 'cz_migration_begin('])
      ok(st.includes("('" + fn), 'pārbauda funkciju ' + fn);
    for (const { n, f } of order) ok(st.includes(`(${n}, '${f}')`), 'pārbauda migrāciju ' + f);
    ok(/'ride_offers', 'driver_id', 'authenticated', false/.test(st), 'A01: driver_id UPDATE lietotnei aizliegts');
    ok(/VISS KĀRTĪBĀ/.test(st), 'skaidrs rezultāts');
    const sup = fs.readFileSync(path.join(__dirname, 'sql', 'supabase-stub.sql'), 'utf8');
    ok(/alter default privileges in schema public grant all on functions to anon, authenticated, service_role;/.test(sup), 'testu datubāzē funkciju tiesības kā Supabase');
  });
  test('A09: dokumentācija — MIGRATIONS.md un jauns README', () => {
    const md = fs.readFileSync(path.join(SUP, 'MIGRATIONS.md'), 'utf8');
    for (const { n, f } of order) ok(new RegExp('\\| ' + n + ' \\| ' + f.replace(/[.-]/g, '\\$&') + ' \\|').test(md), 'MIGRATIONS.md tabulā: ' + f);
    for (const h of ['## Kā palaist migrāciju produkcijā', '## Kā uzrakstīt jaunu migrāciju', '## Jauns Supabase projekts', '## Datu rezerves kopija'])
      ok(md.includes(h), 'MIGRATIONS.md: ' + h);
    ok(/Neizmanto `--data-only`/.test(md), 'brīdinājums par trigeriem atjaunošanā');
    const rd = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    ok(/MapLibre GL 6/.test(rd) && /supabase\/MIGRATIONS\.md/.test(rd) && /supabase\/ORDER\.txt/.test(rd) && /node tests\/run\.js/.test(rd), 'README: karte, datubāze, testi');
    ok(!/`app\.js` — karte/.test(rd) && /netiek lietota/.test(rd), 'README vairs neapraksta veco Leaflet versiju kā galveno');
    ok(!/[A-Za-z0-9._%+-]+@gmail\.com/.test(rd + md), 'nav personīgu e-pastu');
  });
}

Promise.all(pending).then(() => {
  console.log(results.join('\n'));
  console.log(`\n${pass} izdevās, ${fail} neizdevās`);
  process.exit(fail ? 1 : 0);
});
