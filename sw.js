// Ceļa Zīmes — bezsaistes režīms (audits 2, B14). Service worker: lietotne atveras arī bez interneta.
//
// Ko glabā ierīcē (Cache API, tikai šajā pārlūkā):
//   cz-shell-v1 — lietotnes lapa (index.html), skripti, stili, MapLibre (vendor/), tēli; pēc versijas (?v=) — nemainīgi.
//   cz-data-v1  — sagatavotie Latvijas dati (data/: kameras, stāvvietas) — vispirms tīkls, bez tīkla — saglabātais.
//   cz-tiles-v1 — pamatkartes stils, flīzes, burti un zīmju ikonas, ko lietotājs jau ir apskatījis (≤ 4000; vecākās ārā).
// Ko NEKAD neglabā: Supabase (konti, braucieni, maksājumi), Mapillary (adresē ir atslēga), maršruti, meklēšana,
// admin.html, POST pieprasījumi. API atbildes (zīmes, ceļi) kešo cache.js („cz-api-v1”) — to šis fails neaiztiek.
// Android lietotnē (Capacitor) netiek reģistrēts — tur lapu ielādē pati lietotne (pwa.js).
// Avārijas izslēgšana: README → „Bezsaistes režīms (B14)”.

const CZ_SW_VERSION = '168';
const CZ_SW_SHELL = 'cz-shell-v1', CZ_SW_DATA = 'cz-data-v1', CZ_SW_TILES = 'cz-tiles-v1';
const CZ_SW_KEEP = [CZ_SW_SHELL, CZ_SW_DATA, CZ_SW_TILES, 'cz-api-v1'];
const CZ_SW_MAX = { [CZ_SW_DATA]: 600, [CZ_SW_TILES]: 4000 };
const CZ_SW_DAY = 24 * 3600 * 1000;
// Lapas, kuras sagatavo uzreiz (pārējais — kad pirmo reizi ielādēts)
const CZ_SW_PAGES = ['./', './index.html', './index-gl.html', './vendor/maplibre-gl-6.15.0/maplibre-gl-worker.mjs',
  './data/osm/cameras.json', './data/osm/index.json', './manifest.webmanifest', './icons/icon-192.png'];
// Nekad neaiztikt (vienmēr tikai tīkls)
const CZ_SW_SKIP = /^\/(admin\.(html|js|css)|sw\.js|\.well-known\/)/;

// Kurā veidā apstrādāt pieprasījumu: null — neaiztikt (pārlūks pats, kā bez service worker)
function czSwRoute(u, mode, method, origin) {
  if (method !== 'GET') return null;
  if (u.origin === origin) {
    if (CZ_SW_SKIP.test(u.pathname)) return null;
    if (mode === 'navigate') return 'page';
    if (u.pathname.startsWith('/data/')) return 'data';
    if (/[?&]v=[0-9a-z.]+/.test(u.search) || u.pathname.startsWith('/vendor/')) return 'static';
    if (/\.(js|mjs|css|svg|png|webmanifest|json)$/.test(u.pathname)) return 'fresh';
    return null;
  }
  if (u.hostname === 'tiles.openfreemap.org') {
    // Stils un TileJSON norāda uz flīžu versiju — vienmēr vispirms tīkls; flīzes, burti, ikonas — pēc adreses nemainīgas
    // (/styles/liberty, /planet — stils un TileJSON; /planet/20251105_…/14/9300/5000.pbf, /fonts/…, /sprites/ofm_f384/… — nemainīgi)
    return /^\/(styles\/|[A-Za-z0-9_-]+\/?$)/.test(u.pathname) ? 'style' : 'tile';
  }
  if (u.hostname === 'tile.openstreetmap.org') return 'osm';
  if (u.hostname === 'cdn.jsdelivr.net' && u.pathname.startsWith('/gh/mapillary/mapillary_sprite_source@')) return 'tile';
  return null;
}

// Lapas resursi no HTML (tās pašas adreses relatīvie src/href)
function czSwAssets(html) {
  const out = new Set();
  const re = /\s(?:src|href)="([^"#]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const p = m[1];
    if (/^(?:[a-z]+:|\/\/|\/)/i.test(p)) continue;                // ārējas adreses, data:, mailto:, absolūti ceļi
    if (/\.html(?:$|\?)/.test(p) || CZ_SW_SKIP.test('/' + p.replace(/^\.\//, ''))) continue;
    out.add('./' + p.replace(/^\.\//, ''));
  }
  return [...out];
}

// Lapas atslēga kešā — bez ?parametriem un #, „/” = „/index.html”
function czSwPageKey(u) {
  const p = u.pathname.endsWith('/') ? u.pathname + 'index.html' : u.pathname;
  return u.origin + p;
}

const czSw = { puts: 0, fetch: (...a) => fetch(...a), caches: typeof caches !== 'undefined' ? caches : null, now: () => Date.now(),
  // B15: ierīce zina, ka tīkla nav — saglabāto atdod uzreiz, negaidot tīkla kļūdu (dažos tīklos tā nāk tikai pēc ilga laika)
  offline: () => typeof navigator !== 'undefined' && navigator.onLine === false };

function czSwTimeout(p, ms) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms);
    p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
  });
}
async function czSwPut(name, key, res) {
  if (!res || !res.ok || res.status !== 200) return;
  try {
    const c = await czSw.caches.open(name);
    await c.put(key, res);
    if (CZ_SW_MAX[name] && ++czSw.puts % 50 === 0) await czSwTrim(name, CZ_SW_MAX[name]);
  } catch { /* pilna krātuve — darbojas bez tās */ }
}
async function czSwTrim(name, max) {
  try {
    const c = await czSw.caches.open(name);
    const keys = await c.keys();
    for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);   // vecākie (ievietošanas secībā) ārā
  } catch { /* nekas */ }
}
async function czSwMatch(name, key) {
  try { const c = await czSw.caches.open(name); return (await c.match(key)) || null; } catch { return null; }
}
function czSwAge(res) {
  const d = Date.parse(res && res.headers && res.headers.get('date') || '');
  return Number.isFinite(d) ? czSw.now() - d : Infinity;
}
function czSwOfflinePage() {
  return new Response('<!doctype html><html lang="lv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Ceļa Zīmes</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px system-ui,sans-serif;' +
    'background:#16202e;color:#fff;text-align:center;padding:24px}</style></head><body><div><h1>Ceļa Zīmes</h1>' +
    '<p>Nav interneta, un šī lapa vēl nav saglabāta ierīcē. Pieslēdzies internetam un atver vēlreiz.</p></div></body></html>',
  { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// Lapa: vispirms tīkls (lai jaunā versija nonāk uzreiz); lēns tīkls (> 8 s) vai nav tīkla — saglabātā
async function czSwPage(req, u) {
  const key = czSwPageKey(u);
  if (czSw.offline()) { const c = await czSwMatch(CZ_SW_SHELL, key); if (c) return c; }
  const net = czSw.fetch(req);
  try {
    const res = await czSwTimeout(net, 8000);
    if (res.ok) czSwPut(CZ_SW_SHELL, key, res.clone());
    return res;
  } catch {
    // Lietotnes adreses (/, /index.html, /index-gl.html) — arī ar citiem parametriem; citas lapas — tikai pašas
    const app = /^\/(index(-gl)?\.html)?$/.test(u.pathname);
    const cached = await czSwMatch(CZ_SW_SHELL, key) || (app ? await czSwMatch(CZ_SW_SHELL, u.origin + '/index.html') : null);
    if (cached) return cached;
    try { return await net; } catch { return czSwOfflinePage(); }
  }
}
// Dati: vispirms tīkls (līdz 6 s), tad saglabātais
async function czSwNetFirst(name, req, ms) {
  if (czSw.offline()) { const c = await czSwMatch(name, req.url); if (c) return c; }
  const net = czSw.fetch(req);
  try {
    const res = await czSwTimeout(net, ms);
    if (res.ok) czSwPut(name, req.url, res.clone());
    return res;
  } catch (e) {
    const cached = await czSwMatch(name, req.url);
    if (cached) return cached;
    return net;
  }
}
// Nemainīgs pēc adreses: saglabātais (ja nav vecāks par maxAge), citādi tīkls; bez tīkla — arī vecs saglabātais
async function czSwCacheFirst(name, req, maxAge) {
  const cached = await czSwMatch(name, req.url);
  if (cached && czSwAge(cached) < maxAge) return cached;
  try {
    const res = await czSw.fetch(req);
    if (res.ok) czSwPut(name, req.url, res.clone());
    else if (cached) return cached;
    return res;
  } catch (e) {
    if (cached) return cached;
    throw e;
  }
}
// Bez versijas (tēli, privātuma lapa u.c.): saglabātais uzreiz, fonā atjauno
async function czSwFresh(req) {
  const cached = await czSwMatch(CZ_SW_SHELL, req.url);
  const net = czSw.fetch(req).then(res => { if (res.ok) czSwPut(CZ_SW_SHELL, req.url, res.clone()); return res; });
  if (cached) { net.catch(() => {}); return cached; }
  return net;
}

function czSwHandle(req, origin) {
  let u;
  try { u = new URL(req.url); } catch { return null; }
  const r = czSwRoute(u, req.mode, req.method, origin);
  switch (r) {
    case 'page':   return czSwPage(req, u);
    case 'data':   return czSwNetFirst(CZ_SW_DATA, req, 6000);
    case 'static': return czSwCacheFirst(CZ_SW_SHELL, req, Infinity);
    case 'fresh':  return czSwFresh(req);
    case 'style':  return czSwNetFirst(CZ_SW_TILES, req, 6000);
    case 'tile':   return czSwCacheFirst(CZ_SW_TILES, req, 30 * CZ_SW_DAY);
    case 'osm':    return czSwCacheFirst(CZ_SW_TILES, req, 7 * CZ_SW_DAY);   // OSM flīžu politika: kešot, ievērot svaigumu
    default:       return null;
  }
}

// Uzstādīšana: lapa un visi tās skripti/stili; vecās versijas (?v=) — ārā
async function czSwInstall(base) {
  const c = await czSw.caches.open(CZ_SW_SHELL);
  let html = '';
  try {
    const r = await czSw.fetch(new Request(new URL('./index-gl.html', base).href, { cache: 'reload' }));
    if (r.ok) html = await r.text();
  } catch { /* bez tīkla — tikai tas, kas ir */ }
  const want = new Set([...CZ_SW_PAGES, ...czSwAssets(html)].map(p => new URL(p, base).href));
  await Promise.all([...want].map(async href => {
    try {
      const u = new URL(href);
      const isData = u.pathname.startsWith('/data/');
      const fixed = u.searchParams.has('v') || u.pathname.startsWith('/vendor/');
      if (fixed && !isData && await c.match(href)) return;          // B15: nemainīgs pēc adreses un jau ir — neielādē vēlreiz
      const r = await czSw.fetch(new Request(href, { cache: 'reload' }));
      if (!r.ok) return;
      if (isData) return czSwPut(CZ_SW_DATA, href, r);
      return czSwPut(CZ_SW_SHELL, fixed ? href : czSwPageKey(u), r);
    } catch { /* viens fails neizdodas — pārējie paliek */ }
  }));
  // Vecas versijas: tas pats fails ar citu ?v=
  const cur = new Map();
  for (const href of want) { const u = new URL(href); if (u.searchParams.has('v')) cur.set(u.pathname, u.search); }
  for (const k of await c.keys()) {
    const u = new URL(k.url);
    if (u.searchParams.has('v') && cur.has(u.pathname) && cur.get(u.pathname) !== u.search) await c.delete(k);
  }
}
async function czSwActivate() {
  // Tikai šī faila vecās versijas (cz-shell-v0 u.c.); citu failu kešus (cache.js cz-api-v1, mapillary.js cz-mly-tiles-v1) neaiztiek
  for (const n of await czSw.caches.keys()) if (/^cz-(shell|data|tiles)-v\d+$/.test(n) && !CZ_SW_KEEP.includes(n)) await czSw.caches.delete(n);
  for (const [n, max] of Object.entries(CZ_SW_MAX)) await czSwTrim(n, max);
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function' && typeof ServiceWorkerGlobalScope !== 'undefined') {
  self.addEventListener('install', ev => { ev.waitUntil(czSwInstall(self.registration.scope).finally(() => self.skipWaiting())); });
  self.addEventListener('activate', ev => { ev.waitUntil(czSwActivate().then(() => self.clients.claim())); });
  self.addEventListener('fetch', ev => {
    const p = czSwHandle(ev.request, self.location.origin);
    if (p) ev.respondWith(p);
  });
  self.addEventListener('message', ev => {
    if (ev.data === 'cz-sw-version' && ev.ports && ev.ports[0]) ev.ports[0].postMessage(CZ_SW_VERSION);
  });
}
if (typeof module !== 'undefined') module.exports = { czSwRoute, czSwAssets, czSwPageKey, czSwHandle, czSwInstall, czSwActivate, czSwTrim, czSw, CZ_SW_VERSION, CZ_SW_KEEP };
