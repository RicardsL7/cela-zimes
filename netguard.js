// A13: ārējo servisu aizsardzība un mērīšana — visi lapas fetch() pieprasījumi iet caur šo slāni.
//   • Mēra: cik pieprasījumu katram serverim šajā ierīcē (šodien un 7 dienas), cik kļūdu, cik „par daudz” (429/503),
//     vidējais atbildes laiks. Redzams iestatījumos ar ?dev=1 un konsolē: czNet.stats().
//   • Bezmaksas karšu serveriem (Overpass, Nominatim, Photon, OSRM, Open-Meteo, Mapillary, OSM API):
//       – ne biežāk kā to lietošanas noteikumi atļauj (piem. Nominatim — 1 pieprasījums sekundē) — pieprasījums pagaida rindā;
//       – ja serveris saka „par daudz” (429/503) vai neatbild — pauze (backoff): 5 s, 10 s, 20 s … līdz 5 min,
//         vai cik serveris prasa (Retry-After, līdz 10 min). Pauzes laikā pieprasījumi uzreiz atgriež kļūdu
//         (lietotne jau prot to apstrādāt — rāda kešatmiņu vai mēģina vēlāk), serveris netiek „dauzīts”.
//   • Supabase un pārējos tikai skaita (maksājumus, kontus u.c. nekad neaptur).
// Kartes flīzes MapLibre ielādē savā worker — tās šeit neredz (OpenFreeMap / OSM flīžu politika — README).
const CZ_NET_POLICY = {
  'overpass-api.de':             { gap: 1000, conc: 2, minPause: 30000 },   // pēc 429 jāgaida ≥ 30 s (OSM Wiki: Overpass API)
  'maps.mail.ru':                { gap: 1000, conc: 2, minPause: 30000 },
  'nominatim.openstreetmap.org': { gap: 1100, conc: 1 },     // https://operations.osmfoundation.org/policies/nominatim/
  'photon.komoot.io':            { gap: 250,  conc: 2 },
  'router.project-osrm.org':     { gap: 1000, conc: 1 },     // demo serveris — ne vairāk kā 1/s
  'routing.openstreetmap.de':    { gap: 1000, conc: 1 },
  'api.open-meteo.com':          { gap: 1000, conc: 1 },
  'graph.mapillary.com':         { gap: 100,  conc: 4 },
  'tiles.mapillary.com':         { gap: 0,    conc: 6 },
  'api.openstreetmap.org':       { gap: 500,  conc: 2 },
};
const CZ_NET_KEY = 'cz.net.v1';
const czNet = {
  hosts: new Map(),          // host → { n, ok, err, r429, blocked, waitMs, ms, fail, until, last, active, queue }
  day: null,                 // { date, hosts: { host: { n, err, r429, blocked } } }
  native: typeof fetch === 'function' ? fetch.bind(typeof window !== 'undefined' ? window : globalThis) : null,
  saveTimer: null,
};

function czNetHost(host) {
  let h = czNet.hosts.get(host);
  if (!h) { h = { n: 0, ok: 0, err: 0, r429: 0, blocked: 0, waitMs: 0, ms: 0, fail: 0, until: 0, last: 0, active: 0, queue: Promise.resolve() }; czNet.hosts.set(host, h); }
  return h;
}
function czNetToday() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function czNetLoad() {
  try { const all = JSON.parse(localStorage.getItem(CZ_NET_KEY) || '{}'); return all && typeof all === 'object' ? all : {}; } catch { return {}; }
}
function czNetCount(host, field) {
  const date = czNetToday();
  if (!czNet.day || czNet.day.date !== date) czNet.day = { date, hosts: (czNetLoad()[date] || {}) };
  const d = czNet.day.hosts[host] || (czNet.day.hosts[host] = { n: 0, err: 0, r429: 0, blocked: 0 });
  d[field] = (d[field] || 0) + 1;
  if (!czNet.saveTimer) { czNet.saveTimer = setTimeout(czNetSave, 5000); if (czNet.saveTimer.unref) czNet.saveTimer.unref(); }
}
function czNetSave() {
  czNet.saveTimer = null;
  try {
    const all = czNetLoad();
    all[czNet.day.date] = czNet.day.hosts;
    for (const k of Object.keys(all).sort().slice(0, -7)) delete all[k];   // 7 dienas
    localStorage.setItem(CZ_NET_KEY, JSON.stringify(all));
  } catch { /* privātais logs u.c. — skaitīšana tikai atmiņā */ }
}

// Pauze pēc kļūmes: 5 s · 2^(n-1), līdz 5 min; Retry-After — līdz 10 min
function czNetBackoff(h, retryAfter, minPause = 0) {
  h.fail++;
  const ra = Number(retryAfter);
  const ms = Number.isFinite(ra) && ra > 0 ? Math.min(600, ra) * 1000 : Math.min(300000, 5000 * 2 ** (h.fail - 1));
  h.until = Date.now() + Math.max(ms, minPause);
}
function czNetCooling(host) { const h = czNet.hosts.get(host); return !!h && h.until > Date.now(); }
// Veselība Overpass serveru izvēlei: mazāk kļūmju un ātrāk — labāk
function czNetHealth(host) {
  const h = czNet.hosts.get(host);
  if (!h) return { cooling: false, fail: 0, avgMs: 0 };
  return { cooling: h.until > Date.now(), fail: h.fail, avgMs: h.ok ? Math.round(h.ms / h.ok) : 0 };
}
function czNetError(msg, status) { return Object.assign(new Error(msg), { status, netguard: true }); }
function czNetSleep(ms, signal) {
  return new Promise((res, rej) => {
    if (signal && signal.aborted) return rej(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(res, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

async function czNetFetch(input, init) {
  let url;
  try { url = new URL(typeof input === 'string' ? input : (input && input.url) || String(input), typeof location !== 'undefined' ? location.href : undefined); }
  catch { return czNet.native(input, init); }
  const host = url.hostname, pol = CZ_NET_POLICY[host], h = czNetHost(host);
  const signal = (init && init.signal) || (input && input.signal) || null;
  if (pol) {
    if (h.until > Date.now()) {                           // pauzē — serveri netraucē
      h.blocked++; czNetCount(host, 'blocked');
      throw czNetError('Serveris ' + host + ' ir pārslogots — mēģināsim vēlāk', 429);
    }
    // Rinda: ne vairāk kā conc vienlaikus un ne biežāk kā reizi gap ms
    const turn = h.queue.then(async () => {
      const wait = Math.max(0, h.last + pol.gap - Date.now());
      if (wait) { h.waitMs += wait; await czNetSleep(wait, signal); }
      while (h.active >= pol.conc) await czNetSleep(50, signal);
      h.last = Date.now();
    });
    h.queue = turn.catch(() => {});
    await turn;
    if (h.until > Date.now()) { h.blocked++; czNetCount(host, 'blocked'); throw czNetError('Serveris ' + host + ' ir pārslogots — mēģināsim vēlāk', 429); }
  }
  h.n++; h.active++; czNetCount(host, 'n');
  const t0 = Date.now();
  try {
    const res = await czNet.native(input, init);
    if (res.status === 429 || res.status === 503 || (pol && (res.status === 502 || res.status === 504))) {
      h.r429++; czNetCount(host, 'r429');
      if (pol) czNetBackoff(h, res.headers && res.headers.get('Retry-After'), res.status === 429 ? pol.minPause || 0 : 0);
    } else if (res.ok) { h.ok++; h.ms += Date.now() - t0; h.fail = 0; h.until = 0; }
    else { h.err++; czNetCount(host, 'err'); }
    return res;
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    if (!aborted) {
      h.err++; czNetCount(host, 'err');
      // Bez interneta — nav servera vaina, pauzi neliek
      if (pol && !(typeof navigator !== 'undefined' && navigator.onLine === false)) czNetBackoff(h, null);
    }
    throw e;
  } finally { h.active--; }
}

// Pārskats (iestatījumi ar ?dev=1, konsole): šodien un 7 dienās katram serverim
function czNetStats() {
  const all = czNetLoad();
  if (czNet.day) all[czNet.day.date] = czNet.day.hosts;
  const rows = {};
  for (const [date, hosts] of Object.entries(all)) for (const [host, c] of Object.entries(hosts)) {
    const r = rows[host] || (rows[host] = { host, today: 0, week: 0, err: 0, r429: 0, blocked: 0 });
    r.week += c.n || 0; r.err += c.err || 0; r.r429 += c.r429 || 0; r.blocked += c.blocked || 0;
    if (date === czNetToday()) r.today += c.n || 0;
  }
  for (const r of Object.values(rows)) {
    const h = czNet.hosts.get(r.host);
    r.avgMs = h && h.ok ? Math.round(h.ms / h.ok) : null;
    r.pauseS = h && h.until > Date.now() ? Math.ceil((h.until - Date.now()) / 1000) : 0;
    r.limited = !!CZ_NET_POLICY[r.host];
  }
  return Object.values(rows).sort((a, b) => b.week - a.week);
}

// Tabula iestatījumos (?dev=1): atjaunojas ik 5 s, kamēr redzama
function czNetRenderPanel() {
  const box = typeof document !== 'undefined' && document.getElementById('netStats');
  if (!box || document.hidden || !box.getClientRects().length) return;
  const rows = czNetStats();
  const t = document.createElement('table');
  const head = t.createTHead().insertRow();
  for (const c of ['Serveris', 'Šodien', '7 d.', 'Kļūdas', '429/503', 'Aizturēti', 'ms', 'Pauze']) { const th = document.createElement('th'); th.textContent = c; head.appendChild(th); }
  const body = t.createTBody();
  for (const r of rows) {
    const tr = body.insertRow();
    if (r.pauseS) tr.className = 'pause';
    for (const v of [r.host + (r.limited ? ' •' : ''), r.today, r.week, r.err, r.r429, r.blocked, r.avgMs == null ? '—' : r.avgMs, r.pauseS ? r.pauseS + ' s' : '']) tr.insertCell().textContent = String(v);
  }
  if (!rows.length) { const p = document.createElement('p'); p.className = 'fine'; p.textContent = 'Vēl nav pieprasījumu.'; box.replaceChildren(p); return; }
  const note = document.createElement('p'); note.className = 'fine';
  note.textContent = '• — bezmaksas serveris ar ierobežojumu (rinda un pauze pēc „par daudz”). Kartes flīzes šeit nav redzamas.';
  box.replaceChildren(t, note);
}

if (typeof window !== 'undefined' && czNet.native && !window.__czNetWrapped) {
  setInterval(czNetRenderPanel, 5000);
  document.addEventListener('click', e => { if (e.target && e.target.closest && e.target.closest('#settingsBtn')) setTimeout(czNetRenderPanel, 300); });
  window.__czNetWrapped = true;
  window.fetch = czNetFetch;
  window.czNet = { stats: czNetStats, health: czNetHealth, cooling: czNetCooling };
  window.addEventListener('pagehide', () => { if (czNet.saveTimer) { clearTimeout(czNet.saveTimer); czNetSave(); } });
}
if (typeof module !== 'undefined') module.exports = { CZ_NET_POLICY, czNetFetch, czNetStats, czNetHealth, czNetCooling, czNetBackoff, czNet, czNetHost };
