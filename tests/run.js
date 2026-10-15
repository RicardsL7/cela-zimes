// Automātiskie testi: node tests/run.js
// Ielādē lietotnes moduļus (bez kartes un pārlūka) vienā kontekstā un pārbauda
// zīmju piesaisti ceļam, virzienus, maršruta filtrēšanu, laikus un datu modeli.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = vm.createContext({ console, Intl, Date, Math, Map, Set, JSON, Number, String, Array, Object, isNaN, setTimeout, clearTimeout,
  signSvg: () => '<svg/>', encodeURIComponent });
for (const f of ['times.js', 'model.js', 'roads-gl.js', 'signs-gl.js', 'nav.js', 'alerts.js', 'places.js', 'cache.js', 'voice.js']) {
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

// Brīdinājumi (kā Waze)
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

test('N. Vietas tuvumā: 12 kategorijas, pareizs Overpass vaicājums, tuvākās pirmās, darba laiks', () => {
  const CATS = G('PLACE_CATEGORIES'), q = G('buildPlacesQuery'), parse = G('parsePlaces'), pc = G('parseCondition');
  eq(CATS.length, 12, '12 kategorijas kā Waze');
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

test('S. Balss norādes: latviski, katrs posms vienreiz, pareizā attālumā', () => {
  const vd = G('voiceDistance'), vm_ = G('voiceForManeuver'), va = G('voiceForAlert'), dur = G('voiceDuration');
  eq(vd(300), 'Pēc trīssimt metriem'); eq(vd(80), 'Pēc astoņdesmit metriem'); eq(vd(1000), 'Pēc viena kilometra');
  eq(vd(1500), 'Pēc pusotra kilometra'); eq(vd(3200), 'Pēc trim kilometriem'); eq(vd(250), 'Pēc divsimt piecdesmit metriem');
  eq(dur(60 * 12), 'divpadsmit minūtes'); eq(dur(60 * 21), 'divdesmit viena minūte'); eq(dur(3600 + 300), 'viena stunda piecas minūtes');
  const right = { maneuver: { type: 'turn', modifier: 'right' }, name: 'Brīvības iela' };
  const said = new Set();
  eq(vm_(3, right, 800, 50, said), null, 'par tālu');
  eq(vm_(3, right, 480, 50, said).text, 'Pēc piecsimt metriem pagriezies pa labi, Brīvības iela', 'iepriekš');
  eq(vm_(3, right, 470, 50, said), null, 'neatkārto');
  eq(vm_(3, right, 150, 50, said).text, 'Pēc simt piecdesmit metriem pagriezies pa labi, Brīvības iela', 'tuvu');
  eq(vm_(3, right, 30, 50, said).text, 'Pagriezies pa labi, Brīvības iela', 'tagad');
  eq(vm_(3, right, 10, 50, said), null, 'tagad tikai vienreiz');
  eq(vm_(4, { maneuver: { type: 'new name', modifier: 'straight' }, name: 'X' }, 100, 50, new Set()), null, 'nosaukuma maiņu nesaka');
  eq(vm_(5, { maneuver: { type: 'arrive' } }, 100, 40, new Set()).text, 'Pēc simt metriem galamērķis');
  const s2 = new Set();
  eq(va('cam1', 'Ātruma kamera', 300, 50, s2).text, 'Uzmanību! Ātruma kamera, pēc trīssimt metriem');
  eq(va('cam1', 'Ātruma kamera', 200, 50, s2), null, 'brīdinājums vienreiz');
  eq(va('cam2', 'Ātruma kamera', 900, 50, s2), null, 'par tālu');
});

Promise.all(pending).then(() => {
  console.log(results.join('\n'));
  console.log(`\n${pass} izdevās, ${fail} neizdevās`);
  process.exit(fail ? 1 : 0);
});
