// ---------- Kešatmiņa API atbildēm ----------
// Divi līmeņi: atmiņā (uzreiz) + telefona Cache API (saglabājas starp atvēršanas reizēm).
// Katram ierakstam ir saglabāšanas laiks; vecāks par maxAge netiek izmantots.
// Tāpat: vienādi pieprasījumi, kas notiek vienlaikus, tiek apvienoti (sūta tikai vienu).

const API_CACHE_NAME = 'cz-api-v1';
const API_CACHE_MEM_MAX = 400;
const apiMem = new Map();             // atslēga → { at, v }
let apiCachePromise = null;

function apiCacheStore() {
  if (!apiCachePromise) {
    apiCachePromise = (typeof caches !== 'undefined' ? caches.open(API_CACHE_NAME) : Promise.reject(new Error('no caches')))
      .catch(() => null);
  }
  return apiCachePromise;
}
function apiCacheUrl(ns, key) { return 'https://cela-zimes.cache/api/' + ns + '/' + encodeURIComponent(key); }
function apiMemSet(k, at, v) {
  apiMem.delete(k);
  apiMem.set(k, { at, v });
  if (apiMem.size > API_CACHE_MEM_MAX) apiMem.delete(apiMem.keys().next().value);   // vecākais ārā
}

// Atgriež saglabāto vērtību vai null.
async function cacheGet(ns, key, maxAgeMs) {
  const k = ns + '|' + key, now = Date.now();
  const m = apiMem.get(k);
  if (m && now - m.at < maxAgeMs) return m.v;
  const store = await apiCacheStore();
  if (!store) return null;
  try {
    const r = await store.match(apiCacheUrl(ns, key));
    if (!r) return null;
    const at = Number(r.headers.get('x-saved') || 0);
    if (now - at >= maxAgeMs) return null;
    const v = await r.json();
    apiMemSet(k, at, v);
    return v;
  } catch { return null; }
}
async function cachePut(ns, key, v) {
  const at = Date.now();
  apiMemSet(ns + '|' + key, at, v);
  const store = await apiCacheStore();
  if (!store) return;
  try {
    await store.put(apiCacheUrl(ns, key), new Response(JSON.stringify(v),
      { headers: { 'content-type': 'application/json', 'x-saved': String(at) } }));
  } catch { /* pilna krātuve u.c. — darbojas bez tās */ }
}
// Izdzēš ļoti vecus ierakstus (lai krātuve neaug bezgalīgi).
async function cachePrune(maxAgeMs = 7 * 24 * 3600 * 1000) {
  const store = await apiCacheStore();
  if (!store) return 0;
  let n = 0;
  try {
    for (const req of await store.keys()) {
      const r = await store.match(req);
      if (!r || Date.now() - Number(r.headers.get('x-saved') || 0) > maxAgeMs) { await store.delete(req); n++; }
    }
  } catch { /* nav svarīgi */ }
  return n;
}

// Vienlaicīgu vienādu pieprasījumu apvienošana.
const apiInflight = new Map();
function onceInflight(key, fn) {
  if (apiInflight.has(key)) return apiInflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => apiInflight.delete(key));
  apiInflight.set(key, p);
  return p;
}

// Ar laika limitu: ja serveris neatbild, pieprasījums tiek pārtraukts (nevis karājas minūti).
async function fetchJson(url, opts = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const outer = opts.signal;
  if (outer) { if (outer.aborted) ctrl.abort(); else outer.addEventListener('abort', () => ctrl.abort(), { once: true }); }
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
    if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status });
    return await res.json();
  } finally { clearTimeout(t); }
}

// Kešots JSON pieprasījums: vispirms krātuve, tad tīkls (un saglabā).
async function cachedJson(ns, key, maxAgeMs, loader) {
  const hit = await cacheGet(ns, key, maxAgeMs);
  if (hit != null) return hit;
  return onceInflight(ns + '|' + key, async () => {
    const v = await loader();
    cachePut(ns, key, v);
    return v;
  });
}

if (typeof module !== 'undefined') {
  module.exports = { cacheGet, cachePut, cachePrune, onceInflight, fetchJson, cachedJson, apiMem };
}
