// A07: kartes dūmu tests (Playwright, Chromium). Atver index-gl.html no šīs mapes (MapLibre — no vendor/, A10),
// vienkāršu pamatkartes stilu (ar ļaunprātīgu attribution — XSS pārbaudei), pārējais tīkls bloķēts. Pārbauda kartes
// izveidi, slāņus, kameru, markerus, popup, maršrutu, brīdinājumu ikonas, stila maiņu un ka attribution XSS neizpildās.
// A10: lapas drošības politika (CSP meta tags) ir spēkā — neviens CSP pārkāpums nedrīkst rasties; kartes worker no tās
// pašas adreses; admin/privacy/terms atveras bez pārkāpumiem; lapa svešā rāmī (iframe) netiek rādīta.
// Lietošana: node tests/map-smoke.js <repo mape> <izvades prefikss>   (vendor/ jābūt — bash tools/vendor.sh)
// Rezultāts: <prefikss>.json (res.xss jābūt 0, res.app visi „ok”/skaitļi, nav PAGEERROR, res.csp tukšs) un <prefikss>.png
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const ARGS = process.argv.slice(2);
const ROOT = ARGS[0], OUT = ARGS[ARGS.length - 1];   // vecais izsaukums ar 3 argumentiem (dist mape vidū) arī der
const STYLE = {
  version: 8, glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    openmaptiles: { type: 'geojson', data: { type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { class: 'primary', name: 'Brīvības iela' }, geometry: { type: 'LineString', coordinates: [[24.10, 56.95], [24.12, 56.96], [24.14, 56.97]] } } ] },
      attribution: '<a href="https://openfreemap.org">OpenFreeMap</a> <details open ontoggle="window.__xss=1" onload="x"></details>' },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#dde' } },
    { id: 'road', type: 'line', source: 'openmaptiles', paint: { 'line-color': '#999', 'line-width': 6 } },
  ],
};
const mime = f => f.endsWith('.js') || f.endsWith('.mjs') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : f.endsWith('.html') ? 'text/html' : f.endsWith('.json') ? 'application/json' : f.endsWith('.svg') ? 'image/svg+xml' : f.endsWith('.png') ? 'image/png' : 'application/octet-stream';
(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 860 }, geolocation: { latitude: 56.95, longitude: 24.11 }, permissions: ['geolocation'] });
  await ctx.addInitScript(() => { try { localStorage.setItem('cz.consent', JSON.stringify({ terms: '2026-10-23', privacy: '2026-11-01', at: 'x' })); } catch (e) {} });
  // A10: visi CSP pārkāpumi (arī workerā neredzamie ielādes atteikumi lapā) — jābūt 0
  await ctx.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.effectiveDirective + ' ' + (e.blockedURI || '') + ' ' + location.pathname)); });
  const page = await ctx.newPage();
  const logs = [], net = new Set(), served = new Set();
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.type() + ': ' + m.text().slice(0, 300)); });
  page.on('pageerror', e => logs.push('PAGEERROR: ' + String(e && e.stack || e).slice(0, 500)));
  await ctx.route('**/*', async route => {   // A10: ctx — arī pārējām lapām
    const u = new URL(route.request().url());
    if (u.hostname === 'app.test') {
      const f = path.join(ROOT, decodeURIComponent(u.pathname === '/' ? '/index-gl.html' : u.pathname));
      served.add(u.pathname);
      if (fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ status: 200, body: fs.readFileSync(f), headers: { 'content-type': mime(f) } });
      net.add('404 ' + u.pathname);
      return route.fulfill({ status: 404, body: 'nf' });
    }
    if (u.hostname === 'evil.test') return route.fulfill({ status: 200, body: '<!doctype html><iframe id="f" src="https://app.test/privacy.html" width="400" height="300"></iframe>', headers: { 'content-type': 'text/html' } });
    if (u.hostname === 'tiles.openfreemap.org' && u.pathname.startsWith('/styles/')) return route.fulfill({ status: 200, body: JSON.stringify(STYLE), headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
    net.add('blocked ' + u.hostname);
    return route.fulfill({ status: 503, body: '', headers: { 'access-control-allow-origin': '*' } });
  });
  await page.goto('https://app.test/index-gl.html');
  const res = {};
  try {
    await page.waitForFunction(() => typeof map !== 'undefined' && map && map.isStyleLoaded && map.isStyleLoaded(), null, { timeout: 30000 });
    res.styleLoaded = true;
  } catch (e) { res.styleLoaded = false; }
  await page.waitForTimeout(3000);
  res.version = await page.evaluate(() => (window.maplibregl && maplibregl.getVersion ? maplibregl.getVersion() : null));
  res.layers = await page.evaluate(() => { try { return map.getStyle().layers.map(l => l.id); } catch (e) { return 'ERR ' + e.message; } });
  res.sources = await page.evaluate(() => { try { return Object.keys(map.getStyle().sources); } catch (e) { return 'ERR ' + e.message; } });
  // Exercise: zoom through marker thresholds, rotate/pitch, flyTo, resize, click, basemap switch
  const steps = [
    ['zoom14', () => map.jumpTo({ zoom: 14 })], ['zoom16', () => map.jumpTo({ zoom: 16 })], ['zoom15.4', () => map.jumpTo({ zoom: 15.4 })],
    ['pitch', () => map.jumpTo({ pitch: 50, bearing: 30 })], ['easeTo', () => map.easeTo({ center: [24.12, 56.96], duration: 300 })],
    ['resize', () => map.resize()],
    ['project', () => JSON.stringify(map.project([24.12, 56.96]))], ['unproject', () => JSON.stringify(map.unproject([100, 100]))],
    ['qrf', () => map.queryRenderedFeatures().length],
    ['marker', () => { const m = new maplibregl.Marker({ element: document.createElement('div') }).setLngLat([24.1, 56.95]).addTo(map); m.setRotation(10); m.remove(); return 'ok'; }],
    ['popup', () => { const p = new maplibregl.Popup({ closeButton: false }).setLngLat([24.1, 56.95]).setDOMContent(document.createElement('div')).addTo(map); p.remove(); return 'ok'; }],
    ['bounds', () => JSON.stringify(map.getBounds().toArray())],
    ['fitBounds', () => map.fitBounds([[24.0, 56.9], [24.2, 57.0]], { padding: 40, duration: 0 })],
    ['getCanvas', () => map.getCanvas().width],
  ];
  res.steps = {};
  for (const [n, fn] of steps) {
    res.steps[n] = await page.evaluate(`(() => { try { const r = (${fn.toString()})(); return (r === undefined || (r && typeof r === 'object')) ? 'ok' : r; } catch (e) { return 'ERR ' + e.message; } })()`);
    await page.waitForTimeout(400);
  }
  // app-level: basemap switch if function exists
  res.basemap = await page.evaluate(async () => {
    try { if (typeof applyBasemap === 'function') { await applyBasemap('dark'); return 'applyBasemap'; } if (typeof setBasemapChoice === 'function') { await setBasemapChoice('dark'); return 'setBasemapChoice'; } return 'none'; } catch (e) { return 'ERR ' + e.message; }
  });
  await page.waitForTimeout(3000);
  // App-level flows: GPS fixes (arrow marker), route draw + progress, alerts with icons, alert popup, sign image load
  res.app = await page.evaluate(async () => {
    const out = {}; const T = ms => new Promise(r => setTimeout(r, ms));
    const tryit = async (n, f) => { try { const r = await f(); out[n] = (r === undefined || (r && typeof r === 'object')) ? 'ok' : r; } catch (e) { out[n] = 'ERR ' + e.message; } };
    await tryit('fix1', () => onFix(56.9500, 24.1000, 30, 45, 900, 10));
    await T(500);
    await tryit('fix2', () => onFix(56.9505, 24.1010, 40, 50, 900, 10));
    await T(500);
    await tryit('route', () => {
      const r = parseOsrmRoute({ distance: 2500, duration: 300, legs: [{ steps: [
        { geometry: { coordinates: [[24.10, 56.95], [24.12, 56.96]] }, maneuver: { type: 'depart', location: [24.10, 56.95] }, distance: 1500, duration: 150, name: 'A' },
        { geometry: { coordinates: [[24.12, 56.96], [24.14, 56.97]] }, maneuver: { type: 'turn', modifier: 'left', location: [24.12, 56.96] }, distance: 1000, duration: 150, name: 'B' },
        { geometry: { coordinates: [[24.14, 56.97], [24.14, 56.97]] }, maneuver: { type: 'arrive', location: [24.14, 56.97] }, distance: 0, duration: 0, name: '' } ] }] });
      state.nav.route = r; drawRoute(r, 300); return 'drawn ' + r.coords.length;
    });
    await T(500);
    await tryit('routeData', () => JSON.stringify(map.querySourceFeatures('route').length));
    await tryit('alert', () => { alerts.add({ id: 'rep:t1', rid: 't1', type: 'police', lat: 56.951, lng: 24.101, source: 'server', createdAt: Date.now(), expiresAt: Date.now() + 3600e3, still: 0 }); refreshAlerts(); return 'added'; });
    await T(1500);
    await tryit('alertImg', () => String(map.listImages().filter(x => /^alert:/.test(x)).join(',')));
    await tryit('alertSrc', () => String(map.querySourceFeatures('alerts').length));
    await tryit('popup', () => { showAlertPopup('rep:t1', [24.101, 56.951]); return String(!!document.querySelector('.maplibregl-popup')); });
    await T(300);
    await tryit('zoomDots', () => { map.jumpTo({ center: [24.101, 56.951], zoom: 13 }); });
    await T(1200);
    await tryit('zoomIcons', () => { map.jumpTo({ zoom: 17 }); });
    await T(1200);
    await tryit('markers', () => String(document.querySelectorAll('.maplibregl-marker').length));
    await tryit('setStyleAgain', async () => { await applyBasemap('light'); });
    await T(3000);
    await tryit('routeAfterStyle', () => String(!!map.getSource('route')));
    await tryit('alertImgAfter', () => String(map.listImages().filter(x => /^alert:/.test(x)).length));
    return out;
  });
  res.layersAfter = await page.evaluate(() => { try { return map.getStyle().layers.length; } catch (e) { return 'ERR ' + e.message; } });
  res.xss = await page.evaluate(() => window.__xss || 0);
  res.attrib = await page.evaluate(() => { const a = document.querySelector('.maplibregl-ctrl-attrib-inner'); return a ? a.innerHTML.slice(0, 300) : null; });
  res.overscale = await page.evaluate(() => String(map._zoomLevelsToOverscale));
  res.images = await page.evaluate(() => { try { return map.listImages().length; } catch (e) { return 'ERR ' + e.message; } });
  res.csp = await page.evaluate(() => window.__csp || ['nav __csp']);
  res.worker = [...served].filter(p => /maplibre-gl-worker\.mjs$/.test(p));
  await page.evaluate(() => { map.jumpTo({ center: [24.101, 56.951], zoom: 16, pitch: 0, bearing: 0 }); });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: OUT + '.png' });
  // A10: pārējās lapas ar savu CSP — bez pārkāpumiem un lapas kļūdām; lapa svešā rāmī ir paslēpta
  res.pages = {};
  for (const p of ['admin.html', 'privacy.html', 'terms.html']) {
    const pg = await ctx.newPage(); const errs = [];
    pg.on('pageerror', e => errs.push(String(e && e.message || e).slice(0, 200)));
    await pg.goto('https://app.test/' + p); await pg.waitForTimeout(1500);
    res.pages[p] = { csp: await pg.evaluate(() => window.__csp || ['nav __csp']), errs, title: await pg.title() };
    await pg.close();
  }
  { const pg = await ctx.newPage();
    await pg.goto('https://evil.test/'); await pg.waitForTimeout(1500);
    const fr = pg.frames().find(fr => /app\.test\/privacy\.html/.test(fr.url()));
    res.framed = fr ? await fr.evaluate(() => getComputedStyle(document.documentElement).display) : 'rāmis nav atrasts';
    await pg.close(); }
  fs.writeFileSync(OUT + '.json', JSON.stringify({ res, logs, net: [...net] }, null, 1));
  console.log(JSON.stringify({ res: { ...res, layers: Array.isArray(res.layers) ? res.layers.length : res.layers }, nlogs: logs.length }, null, 1));
  await browser.close();
  // A08: spriedums (GitHub Actions) — kods 1, ja karte neielādējās, kāds solis kļūdījās, XSS izpildījās vai lapā bija kļūda
  const bad = [];
  if (!res.styleLoaded) bad.push('karte neielādējās');
  if (res.xss) bad.push('attribution XSS izpildījās');
  const want = (fs.readFileSync(path.join(ROOT, 'maplibre-load.js'), 'utf8').match(/vendor\/maplibre-gl-(\d+\.\d+\.\d+)\/maplibre-gl\.mjs/) || [])[1];
  if (!want) bad.push('maplibre-load.js: nav atrasta MapLibre versija');
  if (want && res.version !== want) bad.push('MapLibre versija ' + res.version + ', gaidīta ' + want);
  for (const [k, v] of Object.entries({ ...res.steps, ...(res.app || {}) })) if (typeof v === 'string' && v.startsWith('ERR')) bad.push(k + ': ' + v);
  for (const k of ['popup', 'routeAfterStyle']) if (res.app && res.app[k] !== 'true') bad.push(k + ': ' + (res.app && res.app[k]));
  if (res.app && !/alert:police/.test(res.app.alertImg || '')) bad.push('brīdinājuma ikona netika uzzīmēta');
  if (!Array.isArray(res.layers) || res.layers.length < 10) bad.push('par maz slāņu: ' + JSON.stringify(res.layers).slice(0, 80));
  for (const l of logs) if (l.startsWith('PAGEERROR')) bad.push(l.slice(0, 200));
  // A10
  if (res.csp.length) bad.push('CSP pārkāpumi: ' + res.csp.slice(0, 5).join(' | '));
  for (const l of logs) if (/Content Security Policy/i.test(l)) bad.push('CSP konsolē: ' + l.slice(0, 200));
  if (!res.worker.length) bad.push('kartes worker netika ielādēts no lapas adreses (vendor/)');
  for (const [p, r] of Object.entries(res.pages)) {
    if (r.csp.length) bad.push(p + ': CSP pārkāpumi: ' + r.csp.slice(0, 3).join(' | '));
    if (r.errs.length) bad.push(p + ': ' + r.errs[0]);
  }
  if (res.framed !== 'none') bad.push('lapa svešā rāmī ir redzama (display: ' + res.framed + ')');
  for (const n of net) if (/^404 /.test(n) && !/favicon/.test(n)) bad.push('trūkst faila: ' + n.slice(4));
  if (bad.length) { console.error('KARTES TESTS NEIZDEVĀS:\n  ' + bad.join('\n  ')); process.exit(1); }
  console.log('Kartes tests: viss kārtībā (MapLibre ' + res.version + ')');
})().catch(e => { console.error(e); process.exit(1); });
