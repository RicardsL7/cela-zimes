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

// ---------- Pieteikšanās: kopīgā (auth.js) — tikai tad, kad lietotājs pats ieslēdz dalīšanos ----------
const TR_SHARE_VERSION = '2026-10-23';
async function trAuth() {
  const a = czAuthGet();
  if (!a) throw new Error('auth');
  return a.token({ create: true });          // ja konta vēl nav — izveido (tikai ar piekrišanu noteikumiem)
}
// Atsevišķa, brīvprātīga piekrišana ātruma dalīšanai (glabājas lokāli; ar kontu — arī serverī, user_consents).
// „Jā” — ja konta vēl nav, izveido anonīmo (F1), pirms tiek sūtīts pirmais mērījums. Ziņas — uznirstošas (F9).
function trShareChoice(yes, say = true) {
  trSetPref('cz.traffic.share', yes ? 'yes' : 'no');
  trSyncSwitch();
  if (say) trToast(yes ? 'Paldies! Braucot tavs ātrums anonīmi palīdzēs sastrēgumu kartei. Izslēgt vari iestatījumos.'
    : 'Labi — ātrums netiek sūtīts. Ieslēgt vari jebkurā brīdī iestatījumos.');
  const a = czAuthGet();
  if (!a) return Promise.resolve();
  return (async () => {
    try { if (yes) await a.token({ create: true }); await a.syncTermsConsent(); await a.syncConsent('speed_share', TR_SHARE_VERSION, !!yes); }
    catch (e) {
      console.warn('Piekrišanu neizdevās saglabāt serverī', e);
      if (yes && !a.hasSession()) trToast('Pašlaik neizdevās pieslēgties serverim — mēģināšu vēlreiz, kad brauksi.', true);
    }
    trHelpersLoad(true);
  })();
}
function trToast(text, loud) { if (typeof czToast === 'function') czToast(text, loud); else if (typeof parkToast === 'function') parkToast(text, loud); }
function trSyncSwitch() { const sw = $('trafficShare'); if (sw) sw.checked = trShare(); }
// Vai šis lietotājs jau atbildēja citā ierīcē (konta piekrišanās serverī)? Tad nejautā vēlreiz.
async function trServerChoice() {
  const a = czAuthGet();
  if (!a || !a.hasSession()) return null;
  try {
    const t = await a.token();
    if (!t) return null;
    const r = await fetch(trafficCfg.url.replace(/\/$/, '') + '/rest/v1/user_consents?kind=eq.speed_share&select=accepted&order=created_at.desc&limit=1',
      { headers: { apikey: trafficCfg.anonKey, Authorization: 'Bearer ' + t } });
    const rows = r.ok ? await r.json() : [];
    return rows && rows[0] ? !!rows[0].accepted : null;
  } catch { return null; }
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
  if (!czConsentOk()) return;                 // bez piekrišanas noteikumiem neko nesūta un nejautā
  if (!trShare()) { if (!trAsked && kmh > 15 && trPref('cz.traffic.share', '') === '') trafficOffer(); return; }
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

// ---------- Piekrišana (F15) ----------
// Jautā vienu reizi: pirmajā navigācijas sākšanā (app-gl.js startNav) vai — ja lietotājs nenavigē — pirmajā braucienā.
const TR_ASK_TEXT = 'Braucot tiek sūtīts tikai ātrums, aptuvenā vieta uz ceļa (~50 m) un braukšanas virziens — bez tava vārda, e-pasta vai maršruta, un nekad ne brauciena pirmie un pēdējie 400 m. Dati glabājas 28 dienas. Dalīšanos vari jebkurā brīdī izslēgt iestatījumos.';
async function trafficOffer() {
  if (!trafficCfg || trAsked || trPref('cz.traffic.share', '') !== '') return;
  if (typeof czConsentOk === 'function' && !czConsentOk()) return;     // vispirms noteikumi
  trAsked = true;
  const prev = await trServerChoice();                                // atbildēja citā ierīcē — tikai atceras
  if (prev != null) { trSetPref('cz.traffic.share', prev ? 'yes' : 'no'); trSyncSwitch(); return; }
  trAskConsent();
}
function trAskConsent() {
  trAsked = true;
  if (document.getElementById('trConsent')) return;
  const el = document.createElement('div');
  el.id = 'trConsent'; el.className = 'tr-consent';
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-labelledby', 'trConsentT');
  el.innerHTML = `<div class="tr-c-t" id="trConsentT">Palīdzi citiem — anonīmi dalies ar braukšanas ātrumu sastrēgumu kartei?</div>
    <div class="tr-c-s"></div>
    <div class="tr-c-h" hidden></div>
    <div class="tr-c-b"><button type="button" class="btn tr-c-btn" data-a="no">Nē</button><button type="button" class="btn tr-c-btn" data-a="yes">Jā</button></div>`;
  el.querySelector('.tr-c-s').textContent = TR_ASK_TEXT;
  if (trHelpers.n != null) { const h = el.querySelector('.tr-c-h'); h.textContent = trHelpersText(trHelpers.n); h.hidden = false; }
  el.addEventListener('click', ev => {
    const a = ev.target.closest('button') && ev.target.closest('button').dataset.a;
    if (!a) return;
    trShareChoice(a === 'yes');
    el.remove();
  });
  document.body.appendChild(el);
}

// ---------- „Šobrīd palīdz: N braucēji” ----------
const trHelpers = { n: null, at: 0, busy: false };
function trHelpersText(n) {
  if (!n) return 'Šobrīd neviens nepalīdz — esi pirmais, kas palīdz!';
  return `Šobrīd palīdz: ${n} ${n % 10 === 1 && n % 100 !== 11 ? 'braucējs' : 'braucēji'}`;
}
async function trHelpersLoad(force) {
  if (!trafficCfg || trHelpers.busy || (!force && Date.now() - trHelpers.at < 60000)) return trHelpersShow();
  trHelpers.busy = true;
  try { const n = await trRpc('traffic_helpers', {}, false); trHelpers.n = Math.max(0, Number(n) || 0); trHelpers.at = Date.now(); }
  catch (e) { console.warn('Palīdzētāju skaits nav ielādēts', e); }
  trHelpers.busy = false;
  trHelpersShow();
}
// Rāda iestatījumos un maršruta kartītē (tikai, ja sastrēgumi kartē ieslēgti)
function trHelpersShow() {
  const t = trHelpers.n == null ? '' : '🚗 ' + trHelpersText(trHelpers.n);
  for (const id of ['trHelpersSet', 'routeHelpers']) {
    const el = $(id); if (!el) continue;
    el.textContent = t; el.hidden = !t || (id === 'routeHelpers' && !trShow());
  }
}
function trHelpersNeeded() {
  const s = $('settings'), rc = $('routeCard');
  return (s && !s.hidden) || (rc && !rc.hidden);
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
  trHelpersLoad(false);                                   // „Šobrīd palīdz: N” maršruta kartītē
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
  trHelpersLoad(false);
  if (await trafficForRoutes([route]) && state.nav.route === route) trafficLine(route);
}

// ---------- Pieslēgšana ----------
function wireTraffic() {
  const share = $('trafficShare'), show = $('trafficShow');
  if (share) {
    share.checked = trShare();
    share.addEventListener('change', () => trShareChoice(share.checked));
  }
  if (show) {
    show.checked = trShow();
    show.addEventListener('change', () => { trSetPref('cz.traffic.show', show.checked ? 'yes' : 'no'); trRefresh(true); trHelpersShow(); });
  }
  if (!trafficCfg) { const r = $('trafficRows'); if (r) r.hidden = true; return; }
  map.on('moveend', () => { clearTimeout(wireTraffic._t); wireTraffic._t = setTimeout(() => trRefresh(false), 400); });
  map.on('style.load', () => trDraw());
  setInterval(() => { if (!document.hidden) trRefresh(true); }, 90000);
  setInterval(() => trFlush(false), 30000);
  setInterval(() => { if (!document.hidden && trHelpersNeeded()) trHelpersLoad(false); }, 60000);   // reizi minūtē
  const sb = $('settingsBtn'); if (sb) sb.addEventListener('click', () => trHelpersLoad(false));
  trHelpersLoad(true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) trFlush(true); });
  trRefresh(true);
}
(function trWait() {
  if (typeof map !== 'undefined' && map && typeof roadIndex !== 'undefined' && $('settings')) wireTraffic();
  else setTimeout(trWait, 200);
})();
