// Ceļa Zīmes — lietotnes kļūdu pieraksts (audits 2, B12).
//
// Kāpēc: par JavaScript kļūdām lietotāju pārlūkos īpašnieks citādi uzzina tikai, ja kāds pasaka.
// Ko sūta (supabase/client-errors.sql → client_error): kļūdas veidu, attīrītu tekstu (bez e-pastiem, žetoniem, URL
// parametriem, koordinātām un garām ciparu virknēm), faila nosaukumu (bez adreses parametriem), rindu, lietotnes versiju,
// lapu (app/admin) un pārlūka nosaukumu ar galveno versiju. NESŪTA: lietotāja ID, atrašanās vietu, IP (serveris to
// nesaglabā), lapas saturu. Lasāms tikai administrēšanas lapā (admin.html → Kļūdas), glabā 30 dienas.
// Ierobežojumi: viena un tā pati kļūda — vienreiz lapas ielādē; ne vairāk kā 5 ziņojumi lapas ielādē.
// Lietotnē sūta tikai pēc piekrišanas noteikumiem (czConsentOk); citas kļūdas (pārlūka paplašinājumi, tīkla pārtraukumi,
// „Script error.” no citām vietnēm) ignorē.

const CZ_ERR_MAX = 5;
const czErr = { sent: new Set(), count: 0 };

function czErrScrub(t, max) {
  return String(t == null ? '' : t)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '…')
    .replace(/eyJ[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]+)*/g, '…')
    .replace(/\b(sk|pk|rk|sb|whsec|acct|cus|pi|ch|re)_[A-Za-z0-9_]{6,}/g, '…')
    .replace(/[?#][^\s"')]*/g, '')
    .replace(/-?\d{1,3}\.\d{3,}/g, '…')
    .replace(/\d{6,}/g, '…')
    .trim().slice(0, max);
}
// Tikai faila nosaukums, ja tas ir šīs vietnes fails; citādi — „ārējs”
function czErrSrc(src, origin) {
  const s = String(src || '');
  if (!s) return '';
  if (origin && s.startsWith(origin + '/')) return czErrScrub(s.slice(origin.length + 1), 200);
  if (/^(chrome|moz|safari|safari-web)-extension:|^webkit-masked-url:/.test(s)) return null;   // paplašinājumi — ignorē
  return 'ārējs';
}
function czErrBrowser(ua) {
  const u = String(ua || '');
  const m = /(Edg|OPR|SamsungBrowser|Firefox|CriOS|FxiOS|Chrome|Version)\/(\d{1,4})/.exec(u);
  if (!m) return '';
  const name = { Edg: 'Edge', OPR: 'Opera', SamsungBrowser: 'Samsung', CriOS: 'Chrome iOS', FxiOS: 'Firefox iOS', Version: 'Safari' }[m[1]] || m[1];
  return name + ' ' + m[2];
}
function czErrNoise(msg) {
  return /^Script error\.?$/i.test(msg) || /ResizeObserver loop/i.test(msg) ||
    /Failed to fetch|NetworkError|Load failed|network error|The network connection was lost|AbortError|The operation was aborted|signal is aborted/i.test(msg);
}
function czErrVer(doc) {
  try {
    const s = doc && doc.querySelector('script[src*="app-gl.js"], script[src*="admin.js"]');
    const m = s && /[?&]v=([0-9a-z.]{1,20})/.exec(s.getAttribute('src') || '');
    return m ? m[1] : '';
  } catch { return ''; }
}

// Sagatavo ierakstu; null — nesūtīt
function czErrEntry(kind, msg, src, line, col, env) {
  const m = czErrScrub(msg, 300);
  if (!m || czErrNoise(m)) return null;
  const s = czErrSrc(src, env.origin);
  if (s === null) return null;
  return { kind, msg: m, src: s, line: Number.isInteger(line) ? line : null, col: Number.isInteger(col) ? col : null,
    ver: env.ver || '', page: env.page, browser: czErrBrowser(env.ua) };
}

function czErrSend(entry, env) {
  if (!entry) return false;
  if (typeof env.consent === 'function' && !env.consent()) return false;
  const key = entry.kind + '|' + entry.msg + '|' + entry.src + '|' + entry.line;
  if (czErr.sent.has(key) || czErr.count >= CZ_ERR_MAX) return false;
  const cfg = env.config && env.config();
  if (!cfg || !cfg.url || !cfg.anonKey || typeof env.fetch !== 'function') return false;
  czErr.sent.add(key); czErr.count++;
  try {
    env.fetch(cfg.url.replace(/\/$/, '') + '/rest/v1/rpc/client_error', {
      method: 'POST', keepalive: true, credentials: 'omit',
      headers: { apikey: cfg.anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ p: entry }),
    }).catch(() => {});
  } catch { /* nekad nemet kļūdu no kļūdu pieraksta */ }
  return true;
}

function czErrEnv(w) {
  const page = /admin\.html$/.test((w.location && w.location.pathname) || '') ? 'admin' : 'app';
  return {
    origin: w.location && w.location.origin, ua: w.navigator && w.navigator.userAgent, page,
    ver: czErrVer(w.document),
    // Lietotnē — tikai pēc piekrišanas noteikumiem; administrēšanas lapā (tikai īpašnieks) — vienmēr
    // (RIDES_CONFIG un czConsentOk ir citu skriptu globālie nosaukumi — const nav window īpašība, tāpēc typeof)
    consent: () => page === 'admin' || (typeof czConsentOk === 'function' && !!czConsentOk()),
    config: () => (typeof RIDES_CONFIG !== 'undefined' ? RIDES_CONFIG : null),
    fetch: w.fetch && w.fetch.bind(w),
  };
}

// Ar roku (kods var ziņot par kļūdu, ko pats noķēra): czReportError(e, 'kur')
function czReportError(e, where, w = (typeof window !== 'undefined' ? window : null)) {
  if (!w) return false;
  const env = czErrEnv(w);
  const msg = (where ? where + ': ' : '') + (e && (e.message || e.code) ? (e.message || e.code) : String(e));
  return czErrSend(czErrEntry('report', msg, '', null, null, env), env);
}

function czErrInstall(w) {
  if (!w || w.__czErrInstalled) return;
  w.__czErrInstalled = true;
  w.addEventListener('error', ev => {
    if (!ev || !ev.message) return;                                       // resursu (attēlu) ielādes kļūdas — ne
    const env = czErrEnv(w);
    czErrSend(czErrEntry('error', ev.message, ev.filename, ev.lineno, ev.colno, env), env);
  });
  w.addEventListener('unhandledrejection', ev => {
    const r = ev && ev.reason;
    const msg = r && (r.message || r.code) ? (r.name && r.name !== 'Error' ? r.name + ': ' : '') + (r.message || r.code) : String(r);
    let src = '', line = null, col = null;
    const m = r && r.stack && /(https?:\/\/[^\s)]+):(\d+):(\d+)/.exec(r.stack);
    if (m) { src = m[1]; line = Number(m[2]); col = Number(m[3]); }
    const env = czErrEnv(w);
    czErrSend(czErrEntry('rejection', msg, src, line, col, env), env);
  });
}

if (typeof window !== 'undefined') czErrInstall(window);
if (typeof module !== 'undefined') module.exports = { czErrScrub, czErrSrc, czErrBrowser, czErrNoise, czErrEntry, czErrSend, czErrInstall, czReportError, czErr, CZ_ERR_MAX };
