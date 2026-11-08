// Ceļa Zīmes — other drivers on the map with their Garage skin (v124; privacy A16 — v158).
// Server: supabase/presence-2-privacy.sql (presence_update, presence_clear, presence_nearby).
//
// Privacy (owner decision 08.11.2026, audit A16):
//   • You are shown ONLY if you switched on "Rādīt mani citu kartē" (separate from speed sharing, off by default;
//     consent kind 'show_on_map', PRESENCE_SHOW_VERSION), only while driving (≥ 15 km/h). The server rounds the
//     position to ~150 m, shows it only after ~60 s of continuous driving and drops it at once when you stop.
//   • You SEE other drivers only while you are driving yourself, signed in, within ~15 km of you: the request carries
//     your position and speed, the server checks that you really drive (60 s / 200 m warm-up, no jumps) and keeps
//     that position (~50 m) only for this check, at most 10 minutes. Without an account — nobody is shown.
// You yourself always see the green arrow — the fox is what OTHER drivers see.

const PRESENCE_SEND_MS = 30000;      // send my position at most every 30 s (server: ≥ 25 s)
const PRESENCE_POLL_MS = 20000;      // refresh other drivers every 20 s (server: ≥ 12 s)
const PRESENCE_MIN_KMH = 15;
const PRESENCE_MIN_ZOOM = 11;
const PRESENCE_ICON_PX = 48;
const PRESENCE_SHOW_VERSION = '2026-11-08';   // text of the "Rādīt mani citu kartē" switch (index.html, privacy.html §6)

const presence = { lastSend: 0, shown: false, sending: false, markers: [], pollTimer: null, seq: 0, skin: null, me: null, polling: false };

function presencePref(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } }
function presenceSetPref(k, v) { try { localStorage.setItem(k, v); } catch { /* */ } }
// "Rādīt mani citu kartē" switched on for the current text?
function presenceShowOn() {
  return presencePref('cz.presence.show', '') === 'yes' && presencePref('cz.presence.showVer', '') >= PRESENCE_SHOW_VERSION;
}
// Allowed to be shown to others right now?
function presenceSharing() {
  return presenceShowOn() && (typeof czConsentOk !== 'function' || czConsentOk()) && !state.testMode;
}
// The switch in the settings. "Yes" creates an (anonymous) account if there is none — the server needs it.
function presenceShowChoice(yes, say = true) {
  presenceSetPref('cz.presence.show', yes ? 'yes' : 'no');
  presenceSetPref('cz.presence.showVer', PRESENCE_SHOW_VERSION);
  if (!yes) presenceStop();
  const sw = typeof document !== 'undefined' && document.getElementById('presenceShow');
  if (sw) sw.checked = !!yes;
  if (say && typeof czToast === 'function') czToast(yes
    ? 'Ieslēgts: braucot citi kartē redzēs tavu tēlu aptuveni (~150 m), bez vārda. Izslēgt vari iestatījumos.'
    : 'Izslēgts: citi tevi kartē neredz.');
  const a = typeof czAuthGet === 'function' ? czAuthGet() : null;
  if (!a) return Promise.resolve();
  return (async () => {
    try {
      if (yes) await a.token({ create: true });
      await a.syncTermsConsent();
      await a.syncConsent('show_on_map', PRESENCE_SHOW_VERSION, !!yes);
    } catch (e) { console.warn('Izvēli „Rādīt mani citu kartē” neizdevās saglabāt serverī', e); }
  })();
}

// Called from app-gl.js onFix() after every GPS fix.
function presenceOnFix(lat, lng, kmh, heading, acc) {
  presence.me = { lat, lng, kmh, acc, t: Date.now() };            // for viewing others (presencePoll)
  const api = typeof reportsApi !== 'undefined' ? reportsApi : null;
  if (!api || presence.sending) return;
  const sharing = presenceSharing();
  const moving = sharing && kmh != null && kmh >= PRESENCE_MIN_KMH && (acc == null || acc <= 80);
  if (!moving && !presence.shown) return;                      // nothing to send, nothing to clear
  if (moving && presence.shown && Date.now() - presence.lastSend < PRESENCE_SEND_MS) return;
  presence.sending = true; presence.lastSend = Date.now();
  const req = sharing ? api.presenceUpdate(lat, lng, heading, kmh) : api.presenceClear().then(() => ({ shown: false }));
  req.then(r => { presence.shown = !!(r && (r.stored != null ? r.stored : r.shown)); })   // stored — server has my point (clear it later)
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

// Am I driving right now (fresh fix, ≥ 15 km/h, usable accuracy)? Only then other drivers are shown.
function presenceDriving(now = Date.now()) {
  const m = presence.me;
  return !!m && now - m.t < 15000 && m.kmh != null && m.kmh >= PRESENCE_MIN_KMH && (m.acc == null || m.acc <= 80);
}
async function presencePoll() {
  const api = typeof reportsApi !== 'undefined' ? reportsApi : null;
  if (!api || !map || document.hidden || presence.polling) return;
  if (typeof czConsentOk === 'function' && !czConsentOk()) return;
  if (!presenceDriving() || map.getZoom() < PRESENCE_MIN_ZOOM || state.testMode) { presenceDraw([]); return; }
  const m = presence.me, seq = ++presence.seq;
  let r;
  presence.polling = true;
  try { r = await api.presenceNearby({ p_lat: +m.lat.toFixed(5), p_lng: +m.lng.toFixed(5), p_speed_kmh: Math.round(m.kmh) }); }
  catch (e) { if (e.status === 404) { clearInterval(presence.pollTimer); presence.pollTimer = null; } return; }   // SQL Nr. 29 not installed yet
  finally { presence.polling = false; }
  if (seq !== presence.seq || !r) return;
  if (r.reason === 'throttled') return;                          // keep what is on the map
  presenceDraw(r.ok ? r.points : []);
}
function presenceDraw(rows) {
  for (const m of presence.markers) m.remove();
  presence.markers = (rows || []).filter(r => isFinite(r.lat) && isFinite(r.lng)).map(r =>
    new maplibregl.Marker({ element: presenceMarkerEl(r.skin, r.heading), anchor: 'bottom', offset: [0, 11] })
      .setLngLat([+r.lng, +r.lat]).addTo(map));
}

function presenceInit() {
  const sw = document.getElementById('presenceShow');
  if (sw) { sw.checked = presenceShowOn(); sw.addEventListener('change', () => presenceShowChoice(sw.checked)); }
  if (typeof map === 'undefined' || !map) return;
  map.on('rotate', presenceRotateAll);
  presence.pollTimer = setInterval(presencePoll, PRESENCE_POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) presencePoll(); });
  presencePoll();
}

if (typeof module !== 'undefined') module.exports = { presence, presenceOnFix, presenceSharing, presenceShowOn, presenceShowChoice, presenceDriving, presencePoll, PRESENCE_MIN_KMH, PRESENCE_SHOW_VERSION };
