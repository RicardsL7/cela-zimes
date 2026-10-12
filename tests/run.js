// Automātiskie testi: node tests/run.js
// Ielādē lietotnes moduļus (bez kartes un pārlūka) vienā kontekstā un pārbauda
// zīmju piesaisti ceļam, virzienus, maršruta filtrēšanu, laikus un datu modeli.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = vm.createContext({ console, Intl, Date, Math, Map, Set, JSON, Number, String, Array, Object, isNaN, setTimeout, clearTimeout,
  signSvg: () => '<svg/>', encodeURIComponent });
for (const f of ['times.js', 'model.js', 'roads-gl.js', 'signs-gl.js']) {
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
function test(name, fn) {
  try { fn(); pass++; results.push('  ✓ ' + name); }
  catch (e) { fail++; results.push('  ✗ ' + name + '\n      ' + e.message); }
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
  // brīvā braukšanā pēc kursa
  st.setRoute(null); st.heading = 90;
  st.match(east); st.match(west);
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
  eq(r.known, false); eq(describeRestriction('Apstāties aizliegts', r), 'Apstāties aizliegts · laiks nav zināms');
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

console.log(results.join('\n'));
console.log(`\n${pass} izdevās, ${fail} neizdevās`);
process.exit(fail ? 1 : 0);
