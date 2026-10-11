// Mapillary: ceļa zīmes, kas atpazītas no ielu fotogrāfijām visā pasaulē.
// Dati nāk kā "vector tiles" (zoom 14). Šeit ir mazs dekoderis, kas nolasa
// tikai punktus (zīmes), lai nevajadzētu papildu bibliotēkas.

const MLY_TILE_URL = 'https://tiles.mapillary.com/maps/vtp/mly_map_feature_traffic_sign/2/{z}/{x}/{y}?access_token=';
const MLY_ICON_URL = 'https://cdn.jsdelivr.net/gh/mapillary/mapillary_sprite_source@master/package_signs/';
const MLY_ZOOM = 14;

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
async function fetchMapillaryTile(x, y, token) {
  const url = MLY_TILE_URL.replace('{z}', MLY_ZOOM).replace('{x}', x).replace('{y}', y) + encodeURIComponent(token);
  const res = await fetch(url);
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error('token'), { badToken: true });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const layers = decodeTile(new Uint8Array(await res.arrayBuffer()));
  const layer = layers.traffic_sign;
  if (!layer) return [];
  const out = [];
  for (const f of layer.features) {
    for (const [px, py] of f.points) {
      const [lat, lng] = tileToLatLng(x + px / layer.extent, y + py / layer.extent, MLY_ZOOM);
      out.push({ lat, lng, value: String(f.props.value || ''), id: f.props.id });
    }
  }
  return out;
}

// Mapillary zīmes kods → mūsu kategorija.
function classifyMapillary(value) {
  const v = value.toLowerCase();
  const speed = v.match(/maximum-speed-limit-(\d{1,3})(?!\d)/);
  const pretty = v.replace(/--g\d+$/, '').replace(/^(regulatory|warning|information|complementary)--/, '').replace(/-/g, ' ');
  if (speed && v.startsWith('regulatory')) return { cat: 'speed', title: `Ātruma ierobežojums ${speed[1]} km/h` };
  if (/--stop--|stop-here/.test(v)) return { cat: 'priority', title: 'STOP — apstāties obligāti' };
  if (/--yield--|give-way/.test(v)) return { cat: 'priority', title: 'Dodiet ceļu' };
  if (/traffic-signals/.test(v)) return { cat: 'signals', title: 'Luksofors' };
  if (/pedestrians-crossing|crosswalk/.test(v)) return { cat: 'crossing', title: 'Gājēju pāreja' };
  if (/camera|speed-enforcement/.test(v)) return { cat: 'camera', title: 'Ātruma kamera' };
  if (/speed-bump|road-bump|speed-hump|uneven-road/.test(v)) return { cat: 'calming', title: 'Ātrumvalnis' };
  if (/railroad|railway|level-crossing/.test(v)) return { cat: 'rail', title: 'Dzelzceļa pārbrauktuve' };
  return { cat: 'other', title: `Ceļa zīme: ${pretty}` };
}

if (typeof module !== 'undefined') {
  module.exports = { decodeTile, tileToLatLng, tilesForBounds, lngToTileX, latToTileY, classifyMapillary };
}
