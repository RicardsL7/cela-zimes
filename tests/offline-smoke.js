// B14: bezsaistes režīma tests (Playwright, Chromium). Īsts HTTP serveris uz 127.0.0.1 (service worker vajag drošu adresi),
// ārējie serveri — aizstāti (pamatkartes stils un flīze) vai bloķēti. Pārbauda:
//   1) ar tīklu: sw.js reģistrēts, lapa kontrolēta, lietotnes faili un kartes stils saglabāti; nekas no Supabase/admin kešā;
//   2) bez tīkla (serveris izslēgts + pārlūks offline): lapa atveras no kešatmiņas, skripti strādā, karte ielādē
//      saglabāto stilu, redzams „Nav interneta”, nav lapas kļūdu;
//   3) tīkls atpakaļ: „Internets atkal ir”;
//   4) Android lietotnē (Capacitor) sw.js netiek reģistrēts;
//   5) avārijas izslēgšana (tools/sw-kill.js sw.js vietā) noņem sw.js un tā kešus.
// Lietošana: node tests/offline-smoke.js <repo mape> <izvades prefikss>  → <prefikss>.json, <prefikss>.png
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';   // service worker pieprasījumi arī caur ctx.route
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const [ROOT, OUT] = process.argv.slice(2);
// Kartes stils: testa stils ar avotu „t” ielādēts (nevis rezerves klasiskais). map.isStyleLoaded() gaida arī visus avotus un
// attēlus, ko lietotne visu laiku atjauno, — tas nav stabils signāls (lokāli ≈ 1 no 7 reizēm false 30 s).
const STYLE = {
  version: 8,
  sources: { t: { type: 'vector', tiles: ['https://tiles.openfreemap.org/planet/test/{z}/{x}/{y}.pbf'], maxzoom: 14 } },
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#dde' } }],
};
const mime = f => /\.m?js$/.test(f) ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : f.endsWith('.html') ? 'text/html; charset=utf-8'
  : f.endsWith('.json') ? 'application/json' : f.endsWith('.webmanifest') ? 'application/manifest+json' : f.endsWith('.svg') ? 'image/svg+xml'
  : f.endsWith('.png') ? 'image/png' : 'application/octet-stream';

let swOverride = null;   // 5) avārijas izslēgšana: sw.js vietā tools/sw-kill.js
function serve(port) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/sw.js' && swOverride) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(swOverride); }
    const f = path.join(path.resolve(ROOT), decodeURIComponent(u.pathname.endsWith('/') ? u.pathname + 'index.html' : u.pathname));
    if (!f.startsWith(path.resolve(ROOT)) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'content-type': mime(f), 'cache-control': 'max-age=600', date: new Date().toUTCString() });
    res.end(fs.readFileSync(f));
  });
  return new Promise(r => srv.listen(port, '127.0.0.1', () => r(srv)));
}

(async () => {
  const res = {}, logs = [];
  let srv = await serve(0);
  const port = srv.address().port, base = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 860 } });
  const authSrc = fs.readFileSync(path.join(__dirname, '..', 'auth.js'), 'utf8');
  const consentV = { terms: (authSrc.match(/CZ_TERMS_VERSION = '([^']+)'/) || [])[1], privacy: (authSrc.match(/CZ_PRIVACY_VERSION = '([^']+)'/) || [])[1] };
  await ctx.addInitScript(v => { try { localStorage.setItem('cz.consent', JSON.stringify({ terms: v.terms, privacy: v.privacy, at: 'x' })); } catch (e) {} }, consentV);
  const ext = new Set();
  await ctx.route(u => u.hostname !== '127.0.0.1', route => {
    const u = new URL(route.request().url());
    if (u.hostname === 'tiles.openfreemap.org' && u.pathname.startsWith('/styles/'))
      return route.fulfill({ status: 200, body: JSON.stringify(STYLE), headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', date: new Date().toUTCString() } });
    if (u.hostname === 'tiles.openfreemap.org' && u.pathname.startsWith('/planet/test/'))
      return route.fulfill({ status: 200, body: Buffer.alloc(0), headers: { 'content-type': 'application/x-protobuf', 'access-control-allow-origin': '*', date: new Date().toUTCString() } });
    ext.add(u.hostname);
    return route.fulfill({ status: 503, body: '', headers: { 'access-control-allow-origin': '*' } });
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => logs.push('PAGEERROR: ' + String(e && e.stack || e).slice(0, 400)));
  page.on('console', m => { if (m.type() === 'error') logs.push('error: ' + m.text().slice(0, 200)); });

  const step = m => process.stderr.write('[' + m + '] ');   // kur tests apstājās, ja apstājas
  // 1) Ar tīklu
  await page.goto(base);
  step('goto');
  res.registered = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return !!(r && r.active); });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
  step('ready');
  res.controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  await page.waitForFunction(() => (typeof map !== 'undefined' && map && map.style && map.style._loaded && !!map.getStyle().sources.t), null, { timeout: 30000 }).catch(() => {});
  step('style');
  res.styleOnline = await page.evaluate(() => !!(typeof map !== 'undefined' && map && map.style && map.style._loaded && !!map.getStyle().sources.t));
  // Otrā atvēršana ar tīklu (pirmajā lapa vēl nav kontrolēta — stils un flīzes iet garām sw.js)
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => (typeof map !== 'undefined' && map && map.style && map.style._loaded && !!map.getStyle().sources.t), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  res.caches = await page.evaluate(async () => {
    const out = {};
    for (const n of await caches.keys()) out[n] = (await (await caches.open(n)).keys()).map(r => r.url);
    return out;
  });
  const all = Object.values(res.caches).flat();
  res.shellCount = (res.caches['cz-shell-v1'] || []).length;
  res.forbidden = all.filter(u => /supabase|admin\.|mapillary\.com|\/sw\.js|challenges\.cloudflare/.test(u));
  res.hasIndex = all.includes(base + 'index.html');
  res.hasAppGl = all.some(u => /\/app-gl\.js\?v=[0-9a-z]+$/.test(u));
  res.hasStyle = all.some(u => u.startsWith('https://tiles.openfreemap.org/styles/'));
  res.version = await page.evaluate(() => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = e => r(e.data); navigator.serviceWorker.controller.postMessage('cz-sw-version', [c.port2]); setTimeout(() => r(null), 3000); }));

  step('cached');
  // 2) Bez tīkla: serveris izslēgts, pārlūks offline
  await new Promise(r => srv.close(r));
  await ctx.setOffline(true);
  logs.length = 0;
  await page.reload({ waitUntil: 'load' }).catch(e => logs.push('RELOAD: ' + e.message));
  step('reloaded');
  res.offlineTitle = await page.title().catch(() => '');
  res.offlineScripts = await page.evaluate(() => ['czPwaInit', 'czNetHost', 'czAuthGet'].map(f => typeof window[f] === 'function' || typeof eval(f) === 'function')).catch(e => 'ERR ' + e.message);
  await page.waitForFunction(() => (typeof map !== 'undefined' && map && map.style && map.style._loaded && !!map.getStyle().sources.t), null, { timeout: 20000 }).catch(() => {});
  res.styleOffline = await page.evaluate(() => !!(typeof map !== 'undefined' && map && map.style && map.style._loaded && !!map.getStyle().sources.t)).catch(() => false);
  await page.waitForTimeout(1500);
  res.offlineLazy = await page.evaluate(() => typeof CZ_LAZY !== 'undefined' ? CZ_LAZY.done.size + '/' + CZ_LAZY.queue.length : 'nav').catch(() => 'ERR');   // B15
  res.bannerOffline = await page.evaluate(() => { const b = document.getElementById('offlineBanner'); return b && !b.hidden ? b.textContent : null; });
  res.bannerBox = await page.evaluate(() => { const b = document.getElementById('offlineBanner'), t = document.getElementById('topbar');
    return b && t ? { top: Math.round(b.getBoundingClientRect().top), topbarBottom: Math.round(t.getBoundingClientRect().bottom) } : null; });
  await page.screenshot({ path: OUT + '.png' });
  res.offlineErrors = logs.filter(l => l.startsWith('PAGEERROR') || l.startsWith('RELOAD'));
  // Lapa, kas nav saglabāta (admin.html) — sw.js to neaiztiek, pārlūks rāda savu kļūdu
  const p2 = await ctx.newPage();
  res.adminOffline = await p2.goto(base + 'admin.html').then(r => 'served ' + (r && r.status()), e => 'neatvērās (pareizi)');
  await p2.close();

  step('offline-ok');
  // 3) Tīkls atpakaļ
  srv = await serve(port);
  await ctx.setOffline(false);
  await page.waitForTimeout(800);
  res.bannerOnline = await page.evaluate(() => { const b = document.getElementById('offlineBanner'); return b && !b.hidden ? b.textContent : null; });
  await page.waitForTimeout(3500);
  res.bannerHidden = await page.evaluate(() => { const b = document.getElementById('offlineBanner'); return !b || b.hidden; });

  step('online');
  // 5) Avārijas izslēgšana (README): sw.js → tools/sw-kill.js — sw.js noņemts, tā keši dzēsti, citi paliek
  swOverride = fs.readFileSync(path.join(__dirname, '..', 'tools', 'sw-kill.js'));
  await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); if (r) await r.update(); }).catch(() => {});
  await page.waitForTimeout(4000);
  const navs = []; page.on('framenavigated', f => { if (f === page.mainFrame()) navs.push(f.url()); });
  await page.reload();                                         // nākamā atvēršana — pwa.js reģistrē atkal; nedrīkst pārlādēt cilpā
  await page.waitForTimeout(5000);
  res.killNavs = navs.length;
  res.kill = await page.evaluate(async () => ({ regs: (await navigator.serviceWorker.getRegistrations()).length, caches: await caches.keys() })).catch(e => 'ERR ' + e.message);
  step('kill');
  // 4) Android lietotne (Capacitor): sw.js netiek reģistrēts, vecais tiek noņemts
  const ctx3 = await browser.newContext();
  await ctx3.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, Plugins: {} }; });
  await ctx3.route(u => u.hostname !== '127.0.0.1', r => r.fulfill({ status: 503, body: '' }));
  const p3 = await ctx3.newPage();
  await p3.goto(base);
  await p3.waitForTimeout(2500);
  res.nativeRegs = await p3.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
  await ctx3.close();

  await browser.close();
  srv.close();
  res.external = [...ext];
  fs.writeFileSync(OUT + '.json', JSON.stringify({ res, logs }, null, 1));
  const fails = [];
  const need = (c, m) => { if (!c) fails.push(m); };
  need(res.registered && res.controlled, 'sw.js reģistrēts un kontrolē lapu');
  need(res.version && /^\d+$/.test(res.version), 'sw.js versija');
  need(res.shellCount >= 30 && res.hasIndex && res.hasAppGl, 'lietotnes faili kešā (' + res.shellCount + ')');
  need(res.styleOnline && res.hasStyle, 'kartes stils kešā');
  need(!res.forbidden.length, 'kešā nav Supabase/admin/Mapillary: ' + res.forbidden.join(', '));
  need(res.offlineTitle === 'Ceļa Zīmes', 'bez tīkla lapa atveras (' + res.offlineTitle + ')');
  need(Array.isArray(res.offlineScripts) && res.offlineScripts.every(Boolean), 'bez tīkla skripti strādā');
  need(res.styleOffline, 'bez tīkla karte ielādē saglabāto stilu');
  need(/^(\d+)\/\1$/.test(res.offlineLazy) && parseInt(res.offlineLazy) >= 9, 'bez tīkla vēlā ielāde (B15) no kešatmiņas: ' + res.offlineLazy);
  need(res.bannerOffline && /Nav interneta/.test(res.bannerOffline), '„Nav interneta” redzams');
  need(res.bannerBox && res.bannerBox.top >= res.bannerBox.topbarBottom, 'paziņojums zem augšējās joslas');
  need(!res.offlineErrors.length, 'bez lapas kļūdām: ' + res.offlineErrors.join(' | '));
  need(/neatvērās|served 5/.test(res.adminOffline), 'admin.html netiek rādīts no kešatmiņas (' + res.adminOffline + ')');
  need(res.bannerOnline && /atkal ir/.test(res.bannerOnline) && res.bannerHidden, '„Internets atkal ir” un paslēpjas');
  need(res.kill && res.kill.regs === 0 && !res.kill.caches.some(n => /^cz-(shell|data|tiles)-/.test(n)) && res.kill.caches.includes('cz-api-v1'),
    'avārijas izslēgšana (tools/sw-kill.js): ' + JSON.stringify(res.kill));
  need(res.killNavs === 1, 'pēc izslēgšanas lapa nepārlādējas cilpā (' + res.killNavs + ')');
  need(res.nativeRegs === 0, 'Android lietotnē sw.js nav reģistrēts');
  console.log(JSON.stringify(res, (k, v) => k === 'caches' ? Object.fromEntries(Object.entries(v).map(([n, l]) => [n, l.length])) : v, 1));
  if (fails.length) { console.log('NEIZDEVĀS:\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log('Bezsaistes tests: viss kārtībā');
})().catch(e => { console.error(e); process.exit(1); });
