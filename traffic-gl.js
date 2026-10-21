// Sastrēgumu karte — savākšana braucot (tikai ar lietotāja piekrišanu), kartes slānis un
// sastrēgumu kavējums maršrutā. Serveris: Supabase (supabase/traffic.sql), tā pati datubāze
// kā kopbraucieniem. Ja Supabase nav iestatīts (RIDES_CONFIG tukšs) — funkcija klusē.

const TRAFFIC_COLORS = { 1: '#f5b800', 2: '#f07800', 3: '#c81e3a' };
const trafficCfg = typeof RIDES_CONFIG !== 'undefined' && RIDES_CONFIG && RIDES_CONFIG.url && RIDES_CONFIG.anonKey ? RIDES_CONFIG : null;
const trCollector = new TrafficCollector();
let trJams = new Map();                 // "cell|dir" → { kmh, typical, cls, samples }
let trLastFetch = 0, trFetchBox = null, trSending = false, trAsked = false;

function trPref(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } }
function trSetPref(k, v) { try { localStorage.setItem(k, v); } catch {} }
const trShare = () => trPref('cz.traffic.share', '') === 'yes';
const trShow = () => trPref('cz.traffic.show', 'yes') === 'yes';

// ---------- Anonīma sesija (atsevišķa no kopbraucienu profila) ----------
let trSession = null;
async function trAuth() {
  if (trSession && trSession.exp - Date.now() > 60000) return trSession.token;
  try { trSession = JSON.parse(localStorage.getItem('cz.traffic.session') || 'null'); } catch { trSession = null; }
  const url = trafficCfg.url.replace(/\/$/, ''), h = { apikey: trafficCfg.anonKey, 'content-type': 'application/json' };
  let r;
  if (trSession && trSession.refresh) {
    r = await fetch(url + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: h, body: JSON.stringify({ refresh_token: trSession.refresh }) });
  }
  if (!r || !r.ok) r = await fetch(url + '/auth/v1/signup', { method: 'POST', headers: h, body: JSON.stringify({ data: {} }) });
  if (!r.ok) throw new Error('auth ' + r.status);
  const s = await r.json();
  trSession = { token: s.access_token, refresh: s.refresh_token, exp: Date.now() + (s.expires_in || 3600) * 1000 };
  try { localStorage.setItem('cz.traffic.session', JSON.stringify(trSession)); } catch {}
  return trSession.token;
}
async function trRpc(name, body, auth) {
  const url = trafficCfg.url.replace(/\/$/, '') + '/rest/v1/rpc/' + name;
  const h = { apikey: trafficCfg.anonKey, 'content-type': 'application/json' };
  if (auth) h.Authorization = 'Bearer ' + await trAuth();
  const r = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(name + ' ' + r.status);
  return r.json();
}

// ---------- Savākšana braucot ----------
// Izsauc app-gl.js onFix() pēc katra GPS mērījuma.
function trafficOnFix(lat, lng, kmh, heading, acc) {
  if (!trafficCfg || state.testMode) return;
  if (!trShare()) { if (!trAsked && kmh > 15 && trPref('cz.traffic.share', '') === '') trAskConsent(); return; }
  if (!roadIndex.ready || !roadIndex.covers(lat, lng)) return;
  const now = Date.now(), L = trCollector.last;
  if (kmh == null && L && now - L.t < 15000) kmh = Math.hypot((lat - L.rawLat) * 111320, (lng - L.rawLng) * 111320 * Math.cos(lat * Math.PI / 180)) / ((now - L.t) / 1000) * 3.6;
  const m = roadIndex.matchPosition(lat, lng, heading, acc || 10);
  if (!m || m.dist > 15) return;
  const seg = (roadIndex._candidates(lat, lng, 0).find(c => c.seg.id === m.segId) || {}).seg;
  trCollector.add({ lat: m.P[1], lng: m.P[0], rawLat: lat, rawLng: lng, t: now, kmh, bearing: heading == null ? null : m.dir, acc, cls: seg ? TR_CLASS[seg.cls] || 0 : 0 });
  trFlush(false);
}
async function trFlush(force) {
  if (trSending || !trCollector.last) return;
  const pos = Object.assign({}, trCollector.last, { t: Date.now() });
  const items = trCollector.ready(pos);
  if (!items.length) return;
  trSending = true;
  try {
    for (let i = 0; i < items.length; i += 80) await trRpc('traffic_report', { items: items.slice(i, i + 80) }, true);
  } catch (e) { console.warn('Sastrēgumu dati netika nosūtīti', e); }
  finally { trSending = false; }
}

// ---------- Piekrišana ----------
function trAskConsent() {
  trAsked = true;
  if (document.getElementById('trConsent')) return;
  const el = document.createElement('div');
  el.id = 'trConsent'; el.className = 'tr-consent';
  el.innerHTML = `<div class="tr-c-t">Palīdzi veidot sastrēgumu karti?</div>
    <div class="tr-c-s">Lietotne anonīmi sūtīs tikai braukšanas ātrumu pa ielu posmiem — bez tava vārda, bez brauciena maršruta, un nekad ne pirmos un pēdējos 400 m (mājas, darbs). Jo vairāk braucēju, jo precīzāki sastrēgumi visiem.</div>
    <div class="tr-c-b"><button type="button" class="btn ghost" data-a="no">Nē</button><button type="button" class="btn primary" data-a="yes">Jā, anonīmi</button></div>`;
  el.addEventListener('click', ev => {
    const a = ev.target.closest('button') && ev.target.closest('button').dataset.a;
    if (!a) return;
    trSetPref('cz.traffic.share', a);
    const sw = $('trafficShare'); if (sw) sw.checked = a === 'yes';
    el.remove();
  });
  document.body.appendChild(el);
}

// ---------- Kartes slānis ----------
function trEnsureLayer() {
  if (map.getSource('traffic')) return true;
  try { map.addSource('traffic', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }); } catch { return false; }
  const before = map.getLayer('route-casing') ? 'route-casing' : map.getLayer('signs') ? 'signs' : undefined;
  map.addLayer({ id: 'traffic', type: 'line', source: 'traffic', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'c'], 'line-opacity': 0.92,
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, ['*', 1.5, ['get', 'w']], 15, ['*', 3, ['get', 'w']], 18, ['*', 6, ['get', 'w']]] } }, before);
  return true;
}
function trOffsetLine(a, b, m) {      // [lng,lat] līnija nobīdīta pa labi par m metriem
  const cos = Math.cos(a[1] * Math.PI / 180), k = 111320;
  const dx = (b[0] - a[0]) * k * cos, dy = (b[1] - a[1]) * k, L = Math.hypot(dx, dy) || 1;
  const ox = dy / L * m / (k * cos), oy = -dx / L * m / k;
  return [[a[0] + ox, a[1] + oy], [b[0] + ox, b[1] + oy]];
}
function trDraw() {
  if (!trEnsureLayer()) return;
  const feats = [];
  if (trShow()) {
    const drawn = new Set();
    // Ja ceļu indekss aptver šūnu — zīmē pa īstajiem ceļa posmiem; citādi — īsu līniju šūnas centrā.
    for (const [key, j] of trJams) {
      const lvl = trLevel(j.kmh, j.typical, j.cls);
      if (!lvl) continue;
      const [cell, dirS] = key.split('|'), dir = +dirS, c = trCellCenter(cell);
      const props = { c: TRAFFIC_COLORS[lvl], w: lvl === 3 ? 1.3 : 1 };
      let any = false;
      if (roadIndex.ready && roadIndex.covers(c.lat, c.lng)) {
        const h = 0.5 / TR_CELL;
        roadIndex.eachSegInBox(c.lat - h, c.lng - h, c.lat + h, c.lng + h, seg => {
          const mid = [(seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2];
          if (trCell(mid[1], mid[0]) !== cell) return;
          const br = (Math.atan2((seg.b[0] - seg.a[0]) * Math.cos(mid[1] * Math.PI / 180), seg.b[1] - seg.a[1]) * 180 / Math.PI + 360) % 360;
          let ln = null;
          if (trDir(br) === dir) ln = trOffsetLine(seg.a, seg.b, 2.5);
          else if (!seg.oneway && trDir(br + 180) === dir) ln = trOffsetLine(seg.b, seg.a, 2.5);
          if (!ln || drawn.has(seg.id + dir)) return;
          drawn.add(seg.id + dir); any = true;
          feats.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: ln } });
        });
      }
      if (!any) {
        const b = dir * 45 * Math.PI / 180, dLat = 22 * Math.cos(b) / 111320, dLng = 22 * Math.sin(b) / (111320 * Math.cos(c.lat * Math.PI / 180));
        feats.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: trOffsetLine([c.lng - dLng, c.lat - dLat], [c.lng + dLng, c.lat + dLat], 2.5) } });
      }
    }
  }
  map.getSource('traffic').setData({ type: 'FeatureCollection', features: feats });
}
async function trFetch(box) {
  const rows = await trRpc('traffic_now', { s: box[0], w: box[1], n: box[2], e: box[3] }, false);
  const m = new Map();
  for (const r of rows || []) m.set(r.cell + '|' + r.dir, { kmh: r.kmh, typical: r.typical, cls: r.cls, samples: r.samples });
  return m;
}
async function trRefresh(force) {
  if (!trafficCfg || !trShow() || map.getZoom() < 11) { if (map.getSource('traffic')) trDraw(); return; }
  const b = map.getBounds(), box = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
  if (box[2] - box[0] > 0.6 || box[3] - box[1] > 0.6) return;
  const same = trFetchBox && box[0] >= trFetchBox[0] && box[1] >= trFetchBox[1] && box[2] <= trFetchBox[2] && box[3] <= trFetchBox[3];
  if (!force && same && Date.now() - trLastFetch < 60000) return;
  const pad = 0.15 * Math.max(box[2] - box[0], box[3] - box[1]);
  const fbox = [box[0] - pad, box[1] - pad, Math.min(box[2] + pad, box[0] - pad + 0.6), Math.min(box[3] + pad, box[1] - pad + 0.6)];
  try {
    trJams = await trFetch(fbox);
    trFetchBox = fbox; trLastFetch = Date.now();
    trDraw();
  } catch (e) { console.warn('Sastrēgumi netika ielādēti', e); }
}

// ---------- Maršruta kavējums ----------
// Izsauc app-gl.js previewRoute() pēc maršruta parādīšanas.
// Sastrēgumu kavējums vairākiem maršrutiem ar vienu pieprasījumu. Katram maršrutam ieliek
// route.jamSec (sekundes) vai null, ja datu nav. Atgriež true, ja dati bija.
async function trafficForRoutes(routes) {
  routes = (routes || []).filter(r => r && r.coords);
  if (!trafficCfg || !routes.length) return false;
  let s = 90, w = 180, n = -90, e = -180;
  for (const r of routes) for (const [lo, la] of r.coords) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
  if (n - s > 0.6 || e - w > 0.6) return false;
  let jams;
  try { jams = await trFetch([s - 0.002, w - 0.003, n + 0.002, e + 0.003]); } catch { return false; }
  if (!jams.size) return false;                       // datu vēl nav — neko nerāda
  for (const r of routes) { const d = trRouteDelay(r.coords, jams); r.jamSec = d.sec; r.jamWorst = d.worst; }
  for (const [k, v] of jams) trJams.set(k, v);
  trDraw();
  return true;
}
// Rinda maršruta kartītē par izvēlētā maršruta sastrēgumiem.
function trafficLine(route) {
  const el = $('routeTraffic');
  if (!el) return;
  if (!route || route.jamSec == null) { el.hidden = true; return; }
  const sec = route.jamSec;
  el.hidden = false;
  el.className = 'route-traffic ' + (sec >= 300 ? 'bad' : sec >= 60 ? 'mid' : 'ok');
  el.textContent = sec >= 60 ? `🚦 Sastrēgumi maršrutā: +${Math.round(sec / 60)} min` : '🚦 Sastrēgumu maršrutā nav';
}
async function trafficOnRoute(route) {
  const el = $('routeTraffic');
  if (el) el.hidden = true;
  if (await trafficForRoutes([route]) && state.nav.route === route) trafficLine(route);
}

// ---------- Pieslēgšana ----------
function wireTraffic() {
  const share = $('trafficShare'), show = $('trafficShow');
  if (share) {
    share.checked = trShare();
    share.addEventListener('change', () => trSetPref('cz.traffic.share', share.checked ? 'yes' : 'no'));
  }
  if (show) {
    show.checked = trShow();
    show.addEventListener('change', () => { trSetPref('cz.traffic.show', show.checked ? 'yes' : 'no'); trRefresh(true); });
  }
  if (!trafficCfg) { const r = $('trafficRows'); if (r) r.hidden = true; return; }
  map.on('moveend', () => { clearTimeout(wireTraffic._t); wireTraffic._t = setTimeout(() => trRefresh(false), 400); });
  map.on('style.load', () => trDraw());
  setInterval(() => { if (!document.hidden) trRefresh(true); }, 90000);
  setInterval(() => trFlush(false), 30000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) trFlush(true); });
  trRefresh(true);
}
(function trWait() {
  if (typeof map !== 'undefined' && map && typeof roadIndex !== 'undefined' && $('settings')) wireTraffic();
  else setTimeout(trWait, 200);
})();
