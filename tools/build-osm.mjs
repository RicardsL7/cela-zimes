// Latvijas OSM dati stāvēšanas pārbaudei — sagatavo GitHub Action reizi diennaktī.
//   node tools/build-osm.mjs            (lejupielādē no Overpass)
//   node tools/build-osm.mjs in.json    (no saglabātas Overpass atbildes — testiem)
// Rezultāts: data/osm/index.json un data/osm/c_<rinda>_<kolonna>.json (šūnas pa 0,05°).
// Lietotne ielādē tikai šūnas ap pārbaudāmo vietu — ātri un bez Overpass gaidīšanas.
//
// Šūnas formāts (kompakts):
//   n: [[lat, lng, kods], …]   x — gājēju pāreja, b — autobusa/trolejbusa pietura,
//                               t — tramvaja pietura, r — dzelzceļa pārbrauktuve
//   w: [[tagi, [[lat, lng], …]], …]   ielas ar stāvēšanas atzīmēm (parking:*)
//   p: [[tagi, [[lat, lng], …]], …]   stāvlaukumu kontūras (amenity=parking)
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';

const CELL = 0.05;
const OUT = new URL('../data/osm/', import.meta.url);
const URLS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const QUERY = `[out:json][timeout:600][maxsize:1073741824];
area["ISO3166-1"="LV"][admin_level=2]->.lv;
(
  way(area.lv)["highway"][~"^parking:(left|right|both|lane|condition)"~"."];
  node(area.lv)["highway"~"^(crossing|bus_stop)$"];
  node(area.lv)["railway"~"^(tram_stop|level_crossing)$"];
  node(area.lv)["public_transport"="platform"]["bus"="yes"];
  node(area.lv)["public_transport"="platform"]["trolleybus"="yes"];
  way(area.lv)["amenity"="parking"];
  relation(area.lv)["amenity"="parking"];
);
out tags geom qt;`;
// Minimālie apjomi — ja Overpass atdod nepilnīgus datus, vecos datus NEPĀRRAKSTA.
const MIN = { x: 10000, b: 6000, p: 6000 };

const r5 = v => Math.round(v * 1e5) / 1e5;
const cellKey = (lat, lng) => Math.floor(lat / CELL) + '_' + Math.floor(lng / CELL);
const PARK_AREA_KEYS = ['name', 'fee', 'fee:conditional', 'access', 'opening_hours', 'maxstay', 'parking', 'operator'];

async function download() {
  let last;
  for (let round = 0; round < 3; round++) {
    for (const url of URLS) {
      try {
        console.log('Overpass:', url);
        const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(QUERY),
          headers: { 'User-Agent': 'cela-zimes-data/1 (github.com/RicardsL7/cela-zimes)' }, signal: AbortSignal.timeout(900000) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        if (j.remark && /error|timed out/i.test(j.remark)) throw new Error(j.remark);
        return j;
      } catch (e) { last = e; console.warn('  neizdevās:', e.message); }
    }
    await new Promise(r => setTimeout(r, 60000));
  }
  throw last;
}

export function buildCells(json) {
  const cells = new Map();
  const cell = k => { if (!cells.has(k)) cells.set(k, { n: [], w: [], p: [] }); return cells.get(k); };
  const cellsForLine = pts => {
    const ks = new Set();
    let s = 90, w = 180, n = -90, e = -180;
    for (const [la, lo] of pts) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
    for (let a = Math.floor(s / CELL); a <= Math.floor(n / CELL); a++)
      for (let b = Math.floor(w / CELL); b <= Math.floor(e / CELL); b++) ks.add(a + '_' + b);
    return ks;
  };
  const count = { x: 0, b: 0, t: 0, r: 0, w: 0, p: 0 };
  for (const el of json.elements || []) {
    const t = el.tags || {};
    if (el.type === 'node') {
      const code = t.highway === 'crossing' ? 'x' : t.railway === 'level_crossing' ? 'r' : t.railway === 'tram_stop' ? 't'
        : (t.highway === 'bus_stop' || t.public_transport === 'platform') ? 'b' : null;
      if (!code || el.lat == null) continue;
      cell(cellKey(el.lat, el.lon)).n.push([r5(el.lat), r5(el.lon), code]);
      count[code]++;
    } else if (el.type === 'way' && el.geometry) {
      const pts = el.geometry.filter(Boolean).map(g => [r5(g.lat), r5(g.lon)]);
      if (pts.length < 2) continue;
      if (t.amenity === 'parking') {
        if (pts.length < 3) continue;
        const keep = {};
        for (const k of PARK_AREA_KEYS) if (t[k]) keep[k] = t[k];
        for (const k of cellsForLine(pts)) cell(k).p.push([keep, pts]);
        count.p++;
      } else if (t.highway) {
        const keep = {};
        for (const [k, v] of Object.entries(t)) if (/^parking:/.test(k) || k === 'name' || k === 'highway' || k === 'oneway') keep[k] = v;
        for (const k of cellsForLine(pts)) cell(k).w.push([keep, pts]);
        count.w++;
      }
    } else if (el.type === 'relation' && t.amenity === 'parking') {
      const keep = {};
      for (const k of PARK_AREA_KEYS) if (t[k]) keep[k] = t[k];
      for (const m of el.members || []) {
        if (m.type !== 'way' || m.role === 'inner' || !m.geometry) continue;
        const pts = m.geometry.filter(Boolean).map(g => [r5(g.lat), r5(g.lon)]);
        if (pts.length < 3) continue;
        for (const k of cellsForLine(pts)) cell(k).p.push([keep, pts]);
      }
      count.p++;
    }
  }
  return { cells, count };
}

async function main() {
  const json = process.argv[2] ? JSON.parse(await readFile(process.argv[2], 'utf8')) : await download();
  const { cells, count } = buildCells(json);
  console.log('Atrasts:', JSON.stringify(count), 'šūnas:', cells.size);
  if (!process.argv[2]) for (const [k, v] of Object.entries(MIN)) {
    if (count[k] < v) throw new Error(`Par maz datu (${k}: ${count[k]} < ${v}) — vecie dati paliek.`);
  }
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const keys = [...cells.keys()].sort();
  for (const k of keys) {
    const c = cells.get(k);
    c.n.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    await writeFile(new URL(`c_${k}.json`, OUT), JSON.stringify({ v: 1, n: c.n, w: c.w, p: c.p }));
  }
  const stamp = json.osm3s && json.osm3s.timestamp_osm_base || new Date().toISOString();
  await writeFile(new URL('index.json', OUT), JSON.stringify({ v: 1, cell: CELL, osm: stamp, counts: count, cells: keys }));
  console.log('Gatavs:', keys.length, 'šūnas, OSM laiks', stamp);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
