// Ceļa Zīmes — other drivers on the map with their Garage skin (v124).
// Server: supabase/coins-2-presence.sql (presence_update, presence_clear, presence_nearby).
//
// Privacy (option A): your position is sent ONLY if you turned on "Palīdzēt citiem" and accepted its
// current text (TR_SHARE_VERSION, traffic-gl.js), only while driving (≥ 15 km/h), rounded to ~20 m,
// without a name or account id; it disappears 2 minutes after the last update. You yourself always see
// the green arrow — the fox is what OTHER drivers see.

const PRESENCE_SEND_MS = 20000;      // send my position at most every 20 s
const PRESENCE_POLL_MS = 20000;      // refresh other drivers every 20 s
const PRESENCE_MIN_KMH = 15;
const PRESENCE_MIN_ZOOM = 11;
const PRESENCE_ICON_PX = 48;

const presence = { lastSend: 0, shown: false, sending: false, markers: [], pollTimer: null, seq: 0, skin: null };

// Allowed to be shown to others right now?
function presenceSharing() {
  return typeof trShareCurrent === 'function' && trShareCurrent() &&
    (typeof czConsentOk !== 'function' || czConsentOk()) && !state.testMode;
}

// Called from app-gl.js onFix() after every GPS fix.
function presenceOnFix(lat, lng, kmh, heading, acc) {
  const api = typeof reportsApi !== 'undefined' ? reportsApi : null;
  if (!api || presence.sending) return;
  const sharing = presenceSharing();
  const moving = sharing && kmh != null && kmh >= PRESENCE_MIN_KMH && (acc == null || acc <= 80);
  if (!moving && !presence.shown) return;                      // nothing to send, nothing to clear
  if (moving && presence.shown && Date.now() - presence.lastSend < PRESENCE_SEND_MS) return;
  presence.sending = true; presence.lastSend = Date.now();
  const req = sharing ? api.presenceUpdate(lat, lng, heading, kmh) : api.presenceClear().then(() => ({ shown: false }));
  req.then(r => { presence.shown = !!(r && r.shown); })
    .catch(e => { if (e.status === 404) presence.lastSend = Date.now() + 10 * 60000; })   // SQL not installed yet — retry later
    .finally(() => { presence.sending = false; });
}
// Sharing switched off: remove me from the map at once.
function presenceStop() {
  const api = typeof reportsApi !== 'undefined' ? reportsApi : null;
  if (!api || !presence.shown) return;
  presence.shown = false;
  api.presenceClear().catch(() => {});
}
// Equipped skin changed in the Garage → the next update carries it (send soon).
function presenceSetSkin(id) {
  if (presence.skin !== id) { presence.skin = id; presence.lastSend = 0; }
}

// ---- Drawing other drivers ----
// Element: the fox stays upright; the small arrow under it rotates to the driving direction.
// Without a skin: just a grey arrow.
function presenceMarkerEl(skin, heading, preview = false) {
  const el = document.createElement('div');
  el.className = 'pr-mk' + (skin ? '' : ' pr-plain') + (preview ? ' pr-preview' : '');
  el.dataset.heading = heading == null ? '' : String(heading);
  if (skin && typeof skinDataUrl === 'function' && skinDataUrl(skin)) {
    const img = document.createElement('img'); img.className = 'pr-fox'; img.alt = ''; img.src = skinDataUrl(skin);
    img.width = PRESENCE_ICON_PX; img.height = Math.round(PRESENCE_ICON_PX * 264 / 256);
    el.appendChild(img);
  }
  const ar = document.createElement('div'); ar.className = 'pr-arrow';
  ar.innerHTML = '<svg viewBox="0 0 60 60" width="22" height="22" aria-hidden="true"><path d="M30 4 52 54 30 42 8 54Z" stroke="#fff" stroke-width="6" stroke-linejoin="round"/></svg>';
  el.appendChild(ar);
  presenceRotate(el);
  return el;
}
function presenceRotate(el) {
  const ar = el.querySelector('.pr-arrow');
  if (!ar) return;
  const h = el.dataset.heading === '' ? null : +el.dataset.heading;
  ar.style.visibility = h == null ? 'hidden' : '';
  ar.style.transform = `rotate(${(h || 0) - (map && map.getBearing ? map.getBearing() : 0)}deg)`;
}
function presenceRotateAll() {
  for (const m of presence.markers) presenceRotate(m.getElement());
  if (typeof garage !== 'undefined' && garage.previewMarker) presenceRotate(garage.previewMarker.getElement());
}

// Bounding box around the map centre, within the server's limit (0.5° × 1°).
function presenceBBox() {
  const b = map.getBounds(), c = map.getCenter();
  const dLat = Math.min((b.getNorth() - b.getSouth()) / 2 + 0.01, 0.24), dLng = Math.min((b.getEast() - b.getWest()) / 2 + 0.02, 0.49);
  return { min_lat: +(c.lat - dLat).toFixed(4), min_lng: +(c.lng - dLng).toFixed(4), max_lat: +(c.lat + dLat).toFixed(4), max_lng: +(c.lng + dLng).toFixed(4) };
}
async function presencePoll() {
  const api = typeof reportsApi !== 'undefined' ? reportsApi : null;
  if (!api || !map || document.hidden) return;
  if (typeof czConsentOk === 'function' && !czConsentOk()) return;
  let rows = [];
  if (map.getZoom() >= PRESENCE_MIN_ZOOM) {
    const seq = ++presence.seq;
    try { rows = await api.presenceNearby(presenceBBox()); }
    catch (e) { if (e.status === 404) { clearInterval(presence.pollTimer); presence.pollTimer = null; } return; }
    if (seq !== presence.seq) return;
  }
  presenceDraw(rows);
}
function presenceDraw(rows) {
  for (const m of presence.markers) m.remove();
  presence.markers = (rows || []).filter(r => isFinite(r.lat) && isFinite(r.lng)).map(r =>
    new maplibregl.Marker({ element: presenceMarkerEl(r.skin, r.heading), anchor: 'bottom', offset: [0, 11] })
      .setLngLat([+r.lng, +r.lat]).addTo(map));
}

function presenceInit() {
  if (typeof map === 'undefined' || !map) return;
  map.on('rotate', presenceRotateAll);
  map.on('moveend', () => { clearTimeout(presenceInit._t); presenceInit._t = setTimeout(presencePoll, 800); });
  presence.pollTimer = setInterval(presencePoll, PRESENCE_POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) presencePoll(); });
  presencePoll();
}

if (typeof module !== 'undefined') module.exports = { presence, presenceOnFix, presenceSharing, PRESENCE_MIN_KMH };
