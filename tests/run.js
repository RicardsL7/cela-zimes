// Automātiskie testi: node tests/run.js
// Ielādē lietotnes moduļus (bez kartes un pārlūka) vienā kontekstā un pārbauda
// zīmju piesaisti ceļam, virzienus, maršruta filtrēšanu, laikus un datu modeli.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
  eq(r[0].name, 'Circle K'); eq(r[0].addr, 'Brīvības iela 1'); eq(r[0].open, false, 'slēgts 13:00');
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
  eq(tp(feats, 'ev', 56.95, 24.1)[0].name, 'EV uzlāde', 'bez nosaukuma — kategorijas nosaukums');
  eq(rs(r, 56.97, 24.1)[0].name, 'Neste', 'pārkārtots pēc jaunās vietas');
  const cw = tp([F('car_wash', null, 24.1, 56.9503)], 'carwash', 56.95, 24.1);
  eq(cw.length === 1 && cw[0].name, 'Auto mazgātavas', 'auto mazgātava no kartes flīzēm');
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
  await drv.driverUpdate(o.id, { trip: 'done' });
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
  eq(ps[0].ct.phone.tel, 'tel:+37167000000');
  eq(ps[0].ct.app.ios, 'https://apps.apple.com/lv/app/id535050119');
  eq(ps[1].ct, null, 'nav kontaktu → nav pogu');
  const lidl = P.placeContacts({}, 'Lidl');
  ok(lidl.brandWeb && lidl.web.host === 'lidl.lv' && /lidlplus/.test(lidl.app.android));
  for (const b of P.PLACE_BRANDS) { ok(P.placeWebsite(b[2]), b[1] + ' vietne'); for (const v of Object.values(b[3])) ok(/^[\w.]+$/.test(v), b[1] + ' id'); }
  const m = P.mergePlaceDetails([{ id: 'node5', cat: 'coffee', name: 'Kafija', extra: [] }], [{ type: 'node', id: 5, tags: { 'contact:website': 'kafija.lv', 'contact:phone': '20000000' } }]);
  eq(m[0].ct.web.url, 'https://kafija.lv/'); eq(m[0].ct.phone.label, '+371 2000 0000');
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
    for (const k of rep) eq(srv[k], T[k].ttl, 'derīgums ' + k);
    eq(Object.keys(srv).length, rep.length, 'serverī nav lieku veidu');
    eq(T.police.ttl, 60); eq(T['camera-mobile'].ttl, 120); eq(T.accident.ttl, 120); eq(T.roadworks.ttl, 1440);
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
    ok(/'refund-' \+ oid/.test(fn) && /'Idempotency-Key': idem/.test(fn), 'Idempotency-Key refund-<id>');
    ok(/if \(info\.refundedCents > 0\)/.test(fn) && /Šis brauciens jau ir atmaksāts/.test(fn), 'dubulta atmaksa atteikta');
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
    ok(/revoke all on function public\.ride_payment_mark\([^)]*\) from public, anon/.test(sql), 'anon nevar');
  });
  test('F14: saskarne — „Atmaksāt” tikai samaksātam un neatmaksātam, ar apstiprinājumu; ziņas kartītē / uznirstošas', () => {
    ok(/if \(!\(ok && p && p\.paid && !p\.refunded\)\) return line;/.test(ui), 'poga tikai samaksātam');
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
    ok(i > 0 && j > i && j < k, 'sastrēgumu karte iestatījumu augšā');
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
    eq(isOverspeed(75, { limit: 50 }), true); eq(isOverspeed(75, { limit: 50, approx: true }), true, 'arī aptuvenam');
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
    ok(/id="testSpeed"/.test(html) && /class="limit-approx"/.test(html) && /speedlimit\.js\?v=\d+/.test(html));
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
    ok(/ridesToast\('Neizdevās — pārbaudi internetu un mēģini vēlreiz\.', true\)/.test(card) && /ridesToast\('Brauciens pabeigts\. Paldies!'\)/.test(card));
    ok(/ridesToast\('Pieprasījums publicēts — šoferi to redz\.'\)/.test(ui) && /ridesToast\('Brauciens saskaņots!'\)/.test(ui));
    const ret = fnOf(ui, 'ridesPayReturn');
    ok(ret && !/setStatus/.test(ret) && ret.indexOf('ridesOpen(true)') < ret.indexOf('ridesToast(msg'), 'ridesPayReturn: logs atveras, ziņa virs tā');
    ok(/if \(rides\.open\) ridesToast\(msg\)/.test(ui), 'jaunumi atvērtā logā — uznirstoši');
    eq((ui.match(/setStatus\(/g) || []).length, 2, 'rides-ui.js: palikuši tikai jaunumi aizvērtam logam un v91 „Paņemšu” (ziņa jau kartītē)');
  });
  test('F9: testa slēdzis, Mapillary atslēga (vienreiz), maršruts neatrasts — czToast', () => {
    ok(/czToast\(state\.testMode \?/.test(app) && !/setStatus\(state\.testMode/.test(app), 'testa slēdzis');
    ok(/if \(!state\.mlyBadShown\) \{ state\.mlyBadShown = true; czToast\('Mapillary atslēga nav derīga/.test(app) && !/setStatus\('Mapillary atslēga/.test(app), 'Mapillary — vienreiz');
    ok(/czToast\('Maršrutu neizdevās atrast\. Pamēģini vēlreiz\.', true\)/.test(app) && !/setStatus\('Maršrutu neizdevās/.test(app));
    const left = (app.match(/setStatus\([^)]*\)/g) || []).filter(x => !/^setStatus\(text\)$/.test(x));
    eq(left.length, 5, 'app-gl.js: tikai kartes statuss (zīmju skaits, GPS, centrēšana): ' + left.join(' | '));
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

Promise.all(pending).then(() => {
  console.log(results.join('\n'));
  console.log(`\n${pass} izdevās, ${fail} neizdevās`);
  process.exit(fail ? 1 : 0);
});
