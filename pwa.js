// Ceļa Zīmes — bezsaistes režīms lapā (audits 2, B14).
//   1) Reģistrē sw.js (lietotnes faili un apskatītā karte paliek ierīcē — atveras arī bez interneta).
//      NE Android lietotnē (Capacitor ielādē lapu pati un tai pievieno savu tiltu — service worker to apietu).
//   2) Paziņojums „Nav interneta”, kamēr ierīce bez tīkla (online/offline notikumi), un īss „Internets atkal ir”.
// Kešotos failus var izdzēst: pārlūka iestatījumi → vietnes dati (growlab.cc).

const CZ_PWA = { el: null, hideTimer: null };

function czPwaNative(w) {
  try {
    return !!((w.Capacitor && typeof w.Capacitor.isNativePlatform === 'function' && w.Capacitor.isNativePlatform()) || w.androidBridge);
  } catch { return false; }
}

function czPwaRegister(w) {
  const n = w.navigator;
  if (!n || !('serviceWorker' in n)) return Promise.resolve(false);
  if (czPwaNative(w)) {
    // Ja kāds agrāk reģistrēts (piem. vecā versija) — Android lietotnē to noņem
    return n.serviceWorker.getRegistrations().then(rs => Promise.all(rs.map(r => r.unregister()))).then(() => false, () => false);
  }
  const secure = w.location.protocol === 'https:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(w.location.hostname);
  if (!secure) return Promise.resolve(false);
  return n.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' }).then(() => true, e => {
    if (typeof czReportError === 'function') czReportError(e, 'sw.js');
    return false;
  });
}

function czPwaBanner(w, state) {
  const d = w.document;
  let el = CZ_PWA.el;
  if (!el) {
    el = d.createElement('div');
    el.id = 'offlineBanner';
    el.className = 'cz-offline';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.hidden = true;
    d.body.appendChild(el);
    CZ_PWA.el = el;
  }
  clearTimeout(CZ_PWA.hideTimer);
  czPwaPlace(w, el);
  if (state === 'offline') {
    el.textContent = 'Nav interneta — rāda saglabāto karti. Maršruts, meklēšana un „Kopā” — kad būs internets.';
    el.classList.remove('back');
    el.hidden = false;
  } else if (state === 'online' && !el.hidden) {
    el.textContent = 'Internets atkal ir.';
    el.classList.add('back');
    CZ_PWA.hideTimer = setTimeout(() => { el.hidden = true; el.classList.remove('back'); }, 3000);
  }
  return el;
}

// Zem augšējās joslas (meklēšana) vai navigācijas laikā — zem nākamā pagrieziena
function czPwaPlace(w, el) {
  try {
    const d = w.document;
    const nav = d.getElementById('navBanner'), top = d.getElementById('topbar');
    const ref = nav && !nav.hidden && nav.getBoundingClientRect().height ? nav : top;
    const b = ref ? ref.getBoundingClientRect().bottom : 0;
    el.style.top = Math.max(8, Math.round(b) + 8) + 'px';
  } catch { /* paliek CSS vieta */ }
}

function czPwaInit(w) {
  if (!w || w.__czPwa) return;
  w.__czPwa = true;
  w.addEventListener('offline', () => czPwaBanner(w, 'offline'));
  w.addEventListener('online', () => czPwaBanner(w, 'online'));
  w.addEventListener('resize', () => { if (CZ_PWA.el && !CZ_PWA.el.hidden) czPwaPlace(w, CZ_PWA.el); });
  const start = () => {
    if (w.navigator && w.navigator.onLine === false) czPwaBanner(w, 'offline');
    czPwaRegister(w);
  };
  if (w.document.readyState === 'loading') w.document.addEventListener('DOMContentLoaded', start); else start();
}

if (typeof window !== 'undefined' && window.document && typeof window.addEventListener === 'function') czPwaInit(window);
if (typeof module !== 'undefined') module.exports = { czPwaInit, czPwaRegister, czPwaBanner, czPwaNative, czPwaPlace, CZ_PWA };
