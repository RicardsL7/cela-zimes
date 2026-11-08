// A14: Android lietotnē (Capacitor, mape mobile/) — saites uz growlab.cc atveras lietotnē, nevis pārlūkā.
// Pieslēgšanās ar e-pasta saiti vai Google un atgriešanās no Stripe beidzas ar adresi https://growlab.cc/…#access_token=…
// (vai ?pay=…). Ārējās lapas (Google, Stripe) Capacitor atver telefona pārlūkā; kad tās novirza atpakaļ uz growlab.cc,
// Android „App Links” (mobile/scripts/patch-android.js + .well-known/assetlinks.json) atver lietotni ar šo adresi.
// Šeit lietotne to ielādē — auth.js / rides-ui.js to apstrādā tieši tāpat kā pārlūkā. Parastā pārlūkā nekas nenotiek.
(function () {
  const C = typeof window !== 'undefined' ? window.Capacitor : null;
  if (!C || typeof C.isNativePlatform !== 'function' || !C.isNativePlatform() || typeof C.registerPlugin !== 'function') return;
  const App = C.registerPlugin('App');
  const KEY = 'cz.native.opened';
  const open = (url, how) => {
    let u;
    try { u = new URL(url); } catch { return; }
    if (u.origin !== location.origin) return;                     // tikai savas lapas adreses
    let seen = null;
    try { seen = sessionStorage.getItem(KEY); } catch { /* */ }
    if (seen === u.href) return;                                   // jau ielādēts (piem. pēc pārlādes palaišanas adrese tā pati)
    try { sessionStorage.setItem(KEY, u.href); } catch { /* */ }
    console.log('[cz-native] ' + how + ' ' + u.origin + u.pathname + (u.search ? ' ?…' : '') + (u.hash ? ' #…' : ''));   // bez atslēgām žurnālā
    const samePage = u.pathname === location.pathname && u.search === location.search;
    location.href = u.href;
    if (samePage) location.reload();                               // tikai #… mainās — bez pārlādes auth.js to neredzētu
  };
  try { App.addListener('appUrlOpen', e => { if (e && e.url) open(e.url, 'appUrlOpen'); }); } catch { /* spraudnis nav */ }
  try { Promise.resolve(App.getLaunchUrl()).then(r => { if (r && r.url) open(r.url, 'launchUrl'); }).catch(() => {}); } catch { /* */ }
})();
