// Mapillary: ceļa zīmes, kas atpazītas no ielu fotogrāfijām visā pasaulē.
// Dati nāk kā "vector tiles" (zoom 14). Šeit ir mazs dekoderis, kas nolasa
// tikai punktus (zīmes), lai nevajadzētu papildu bibliotēkas.

const MLY_TILE_URL = 'https://tiles.mapillary.com/maps/vtp/mly_map_feature_traffic_sign/2/{z}/{x}/{y}?access_token=';
const MLY_ICON_URL = 'https://cdn.jsdelivr.net/gh/mapillary/mapillary_sprite_source@master/package_signs/';
const MLY_ZOOM = 14;
// Mapillary "aligned_direction": vai tas ir virziens, uz kuru skatās zīmes priekšpuse
// (true), vai virziens, kurā brauc vadītājs, kas zīmi redz (false). Pārbaudīts ar foto.
const MLY_DIR_IS_FACE = true;

// ---------- Protobuf lasītājs ----------
function pbReader(buf) {
  let pos = 0;
  const r = {
    get pos() { return pos; },
    end: buf.length,
    varint() {
      let result = 0, mul = 1, b;
      do { b = buf[pos++]; result += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
      return result;
    },
    skip(wire) {
      if (wire === 0) r.varint();
      else if (wire === 1) pos += 8;
      else if (wire === 2) pos += r.varint();
      else if (wire === 5) pos += 4;
      else throw new Error('wire ' + wire);
    },
    bytes() { const len = r.varint(); const out = buf.subarray(pos, pos + len); pos += len; return out; },
    string() { return new TextDecoder().decode(r.bytes()); },
    packed() { const sub = pbReader(r.bytes()); const out = []; while (sub.pos < sub.end) out.push(sub.varint()); return out; },
    float() { const v = new DataView(buf.buffer, buf.byteOffset + pos, 4).getFloat32(0, true); pos += 4; return v; },
    double() { const v = new DataView(buf.buffer, buf.byteOffset + pos, 8).getFloat64(0, true); pos += 8; return v; },
  };
  return r;
}
const zigzag = n => (n % 2 ? -(n + 1) / 2 : n / 2);

function readValue(bytes) {
  const r = pbReader(bytes);
  let v = null;
  while (r.pos < r.end) {
    const key = r.varint(), field = key >> 3, wire = key & 7;
    if (field === 1) v = r.string();
    else if (field === 2) v = r.float();
    else if (field === 3) v = r.double();
    else if (field === 4 || field === 5) v = r.varint();
    else if (field === 6) v = zigzag(r.varint());
    else if (field === 7) v = !!r.varint();
    else r.skip(wire);
  }
  return v;
}

// Atgriež [{ props, points: [[x, y], ...] }] katram slānim, kā arī extent.
function decodeTile(buf) {
  const layers = {};
  const r = pbReader(buf);
  while (r.pos < r.end) {
    const key = r.varint(), field = key >> 3, wire = key & 7;
    if (field !== 3) { r.skip(wire); continue; }
    const l = pbReader(r.bytes());
    let name = '', extent = 4096;
    const keys = [], values = [], rawFeatures = [];
    while (l.pos < l.end) {
      const k = l.varint(), f = k >> 3, w = k & 7;
      if (f === 1) name = l.string();
      else if (f === 2) rawFeatures.push(l.bytes());
      else if (f === 3) keys.push(l.string());
      else if (f === 4) values.push(readValue(l.bytes()));
      else if (f === 5) extent = l.varint();
      else l.skip(w);
    }
    const features = rawFeatures.map(fb => {
      const fr = pbReader(fb);
      let tags = [], geom = [], type = 0;
      while (fr.pos < fr.end) {
        const k = fr.varint(), f = k >> 3, w = k & 7;
        if (f === 2) tags = fr.packed();
        else if (f === 3) type = fr.varint();
        else if (f === 4) geom = fr.packed();
        else fr.skip(w);
      }
      const props = {};
      for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
      const points = [];
      if (type === 1) { // punkti
        let x = 0, y = 0, i = 0;
        while (i < geom.length) {
          const cmd = geom[i] & 7, count = geom[i] >> 3; i++;
          for (let c = 0; c < count; c++) {
            if (cmd === 1 || cmd === 2) { x += zigzag(geom[i++]); y += zigzag(geom[i++]); if (cmd === 1) points.push([x, y]); }
          }
        }
      }
      return { props, points };
    });
    layers[name] = { extent, features };
  }
  return layers;
}

// ---------- Flīžu matemātika ----------
function lngToTileX(lng, z) { return Math.floor((lng + 180) / 360 * 2 ** z); }
function latToTileY(lat, z) {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z);
}
function tileToLatLng(x, y, z) {
  const n = Math.PI - 2 * Math.PI * y / 2 ** z;
  return [180 / Math.PI * Math.atan(Math.sinh(n)), x / 2 ** z * 360 - 180];
}
function tilesForBounds(s, w, n, e, z = MLY_ZOOM) {
  const out = [];
  for (let x = lngToTileX(w, z); x <= lngToTileX(e, z); x++)
    for (let y = latToTileY(n, z); y <= latToTileY(s, z); y++) out.push([x, y]);
  return out;
}

// Ielādē vienu flīzi un atgriež zīmes: [{ lat, lng, value, id }]
// Flīzes glabā telefona kešatmiņā 3 dienas: atkārtoti braucot zīmes parādās uzreiz.
const MLY_CACHE = 'cz-mly-tiles-v1', MLY_CACHE_MS = 3 * 24 * 3600 * 1000;
let mlyCachePromise = null;
function mlyCache() {
  if (!mlyCachePromise) mlyCachePromise = (self.caches ? caches.open(MLY_CACHE) : Promise.reject()).catch(() => null);
  return mlyCachePromise;
}
async function fetchMapillaryTile(x, y, token) {
  const url = MLY_TILE_URL.replace('{z}', MLY_ZOOM).replace('{x}', x).replace('{y}', y) + encodeURIComponent(token);
  const key = `https://cela-zimes.cache/mly/${MLY_ZOOM}/${x}/${y}`; // bez atslēgas
  const cache = await mlyCache();
  let bytes = null;
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit && Date.now() - Number(hit.headers.get('x-saved') || 0) < MLY_CACHE_MS) bytes = new Uint8Array(await hit.arrayBuffer());
    } catch { /* kešatmiņa nav pieejama */ }
  }
  if (!bytes) {
    const res = await fetch(url);
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error('token'), { badToken: true });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    bytes = new Uint8Array(buf);
    if (cache) cache.put(key, new Response(buf, { headers: { 'x-saved': String(Date.now()) } })).catch(() => {});
  }
  const layers = decodeTile(bytes);
  const layer = layers.traffic_sign;
  if (!layer) return [];
  const out = [];
  for (const f of layer.features) {
    for (const [px, py] of f.points) {
      const [lat, lng] = tileToLatLng(x + px / layer.extent, y + py / layer.extent, MLY_ZOOM);
      out.push({ lat, lng, value: String(f.props.value || ''), id: String(f.props.id) });
    }
  }
  return out;
}

// Zīmju virzieni (flīzēs to nav) nāk no Mapillary API, kas ir lēnāks.
// Tāpēc tos ielādē tikai nelielā apgabalā ap braucēju. Ja API atbilde ir
// "pilna" (dati nogriezti), apgabalu sadala 4 daļās (līdz 2 reizēm).
const MLY_API_FULL = 1400;
let mlyApiActive = 0;
const mlyApiQueue = [];
function mlyApiSlot() {           // ne vairāk kā 4 pieprasījumi vienlaikus
  return new Promise(res => { if (mlyApiActive < 4) { mlyApiActive++; res(); } else mlyApiQueue.push(res); });
}
function mlyApiDone() { const next = mlyApiQueue.shift(); if (next) next(); else mlyApiActive--; }

async function fetchDirectionsBox(w, s, e, n, values, token, depth) {
  await mlyApiSlot();
  let data;
  try {
    const url = 'https://graph.mapillary.com/map_features?fields=aligned_direction,object_value,geometry&limit=2000' +
      '&object_values=' + values.map(encodeURIComponent).join(',') +
      '&bbox=' + [w, s, e, n].map(v => v.toFixed(6)).join(',');
    const res = await fetch(url, { headers: { Authorization: 'OAuth ' + token } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = (await res.json()).data || [];
  } finally { mlyApiDone(); }
  const out = [];
  for (const f of data) {
    if (f.aligned_direction == null || !f.geometry) continue;
    out.push({ lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], value: f.object_value, dir: f.aligned_direction });
  }
  if (data.length >= MLY_API_FULL && depth < 2) { // nogriezts: sadala laukumu
    const mx = (w + e) / 2, my = (s + n) / 2;
    const parts = await Promise.all([[w, s, mx, my], [mx, s, e, my], [w, my, mx, n], [mx, my, e, n]]
      .map(bb => fetchDirectionsBox(bb[0], bb[1], bb[2], bb[3], values, token, depth + 1)));
    for (const p of parts) out.push(...p);
  }
  return out;
}

// Atgriež [{ lat, lng, value, dir }] zīmēm apgabalā.
// valueCounts: Map(zīmes veids -> cik tādu ir apgabalā). Pieprasa tikai šos
// veidus (citādi API atbildi aizpilda laternas u.c. objekti) un grupē tos tā,
// lai vienā pieprasījumā būtu ~500 zīmes.
async function fetchMapillaryDirectionsArea(w, s, e, n, token, valueCounts) {
  const groups = [];
  let cur = [], count = 0;
  for (const [v, c] of [...valueCounts].sort((a, b) => b[1] - a[1])) {
    if (cur.length && (count + c > 500 || cur.length >= 40)) { groups.push(cur); cur = []; count = 0; }
    cur.push(v); count += c;
  }
  if (cur.length) groups.push(cur);
  const parts = await Promise.all(groups.map(g => fetchDirectionsBox(w, s, e, n, g, token, 0)));
  return parts.flat();
}

// Mapillary zīmes atpazīst automātiski no foto un dažreiz kļūdās, piem.
// svara zīmi "3,5 t" nolasa kā ātrumu 35. Ārpus ASV ātruma ierobežojumi
// beidzas ar 0 (izņemot 5 km/h), tāpēc 15, 25, 35… šeit ir gandrīz droši kļūdas.
function inUSA(lat, lng) {
  return (lat > 24 && lat < 50 && lng > -125 && lng < -66) ||   // kontinentālā daļa
    (lat > 51 && lat < 72 && lng > -170 && lng < -129) ||        // Aļaska
    (lat > 18 && lat < 23 && lng > -161 && lng < -154);          // Havaju salas
}
function isPlausibleSign(value, lat, lng) {
  const m = value.match(/maximum-speed-limit-(\d+)/);
  if (!m || inUSA(lat, lng)) return true;
  const n = parseInt(m[1], 10);
  if (value.startsWith('complementary')) return false; // papildzīmes ar "ātrumu" — parasti kļūdas
  return n === 5 || n % 10 === 0;
}

// Biežākās zīmes latviski (pārējām paliek Mapillary nosaukums).
const MLY_NAMES = [
  [/no-entry/, 'Iebraukt aizliegts'],
  [/no-stopping/, 'Apstāties aizliegts'],
  [/no-parking/, 'Stāvēt aizliegts'],
  [/no-left-turn/, 'Pa kreisi nogriezties aizliegts'],
  [/no-right-turn/, 'Pa labi nogriezties aizliegts'],
  [/no-u-turn/, 'Apgriezties aizliegts'],
  [/no-overtaking/, 'Apdzīt aizliegts'],
  [/no-motor-vehicles|road-closed/, 'Braukt aizliegts'],
  [/no-heavy-goods|no-trucks/, 'Kravas automobiļiem braukt aizliegts'],
  [/maximum-weight|weight-limit/, 'Masas ierobežojums'],
  [/maximum-height|height-limit/, 'Augstuma ierobežojums'],
  [/end-of-maximum-speed|end-of-speed-limit/, 'Ātruma ierobežojuma beigas'],
  [/end-of-priority-road/, 'Galvenā ceļa beigas'],
  [/priority-road/, 'Galvenais ceļš'],
  [/one-way/, 'Vienvirziena ceļš'],
  [/keep-right/, 'Apbraukt no labās puses'],
  [/keep-left/, 'Apbraukt no kreisās puses'],
  [/turn-right|go-straight-or-turn-right/, 'Braukt taisni vai pa labi'],
  [/turn-left|go-straight-or-turn-left/, 'Braukt taisni vai pa kreisi'],
  [/go-straight/, 'Braukt tikai taisni'],
  [/roundabout/, 'Aplis'],
  [/parking/, 'Stāvvieta'],
  [/bus-stop/, 'Autobusa pietura'],
  [/pedestrians-only|pedestrian-zone/, 'Gājēju ceļš'],
  [/bicycles-only|bicycle/, 'Velosipēdu ceļš'],
  [/children|school/, 'Bērni'],
  [/road-works|roadworks/, 'Ceļa remonts'],
  [/residential-area|living-street/, 'Dzīvojamā zona'],
  [/added-lane|lane/, 'Joslu zīme'],
];

// Mapillary zīmes kods → mūsu kategorija.
function classifyMapillary(value) {
  const v = value.toLowerCase();
  const speed = v.match(/maximum-speed-limit-(\d{1,3})(?!\d)/);
  const pretty = v.replace(/--g\d+$/, '').replace(/^(regulatory|warning|information|complementary)--/, '').replace(/-/g, ' ');
  // 5 km/h ir reta zīme (iebrauktuves, pagalmi, stāvvietas): rāda kā mazāk svarīgu,
  // lai tā neaizsegtu galvenās zīmes un to var paslēpt ar "Citas zīmes".
  if (speed && v.startsWith('regulatory') && speed[1] === '5') return { cat: 'other', title: 'Ātruma ierobežojums 5 km/h (parasti iebrauktuvē vai pagalmā)' };
  if (speed && v.startsWith('regulatory')) return { cat: 'speed', title: `Ātruma ierobežojums ${speed[1]} km/h` };
  if (/--stop--|stop-here/.test(v)) return { cat: 'priority', title: 'STOP — apstāties obligāti' };
  if (/--yield--|give-way/.test(v)) return { cat: 'priority', title: 'Dodiet ceļu' };
  if (/traffic-signals/.test(v)) return { cat: 'signals', title: 'Luksofors' };
  if (/pedestrians-crossing|crosswalk/.test(v)) return { cat: 'crossing', title: 'Gājēju pāreja' };
  if (/camera|speed-enforcement/.test(v)) return { cat: 'camera', title: 'Ātruma kamera' };
  if (/speed-bump|road-bump|speed-hump|uneven-road/.test(v)) return { cat: 'calming', title: 'Ātrumvalnis' };
  if (/railroad|railway|level-crossing/.test(v)) return { cat: 'rail', title: 'Dzelzceļa pārbrauktuve' };
  for (const [re, title] of MLY_NAMES) if (re.test(v)) return { cat: 'other', title };
  return { cat: 'other', title: `Ceļa zīme: ${pretty}` };
}

if (typeof module !== 'undefined') {
  module.exports = { decodeTile, tileToLatLng, tilesForBounds, lngToTileX, latToTileY, classifyMapillary };
}
