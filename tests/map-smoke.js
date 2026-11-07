// A07: kartes dūmu tests (Playwright, Chromium). Atver index-gl.html no šīs mapes ar MapLibre no lokālas dist mapes,
// vienkāršu pamatkartes stilu (ar ļaunprātīgu attribution — XSS pārbaudei), pārējais tīkls bloķēts. Pārbauda kartes
// izveidi, slāņus, kameru, markerus, popup, maršrutu, brīdinājumu ikonas, stila maiņu un ka attribution XSS neizpildās.
// Lietošana: node tests/map-smoke.js <repo mape> <maplibre dist mape> <izvades prefikss>
//   dist — no https://github.com/maplibre/maplibre-gl-js/releases/download/v6.15.0/dist.zip (izpakots /dist)
// Rezultāts: <prefikss>.json (res.xss jābūt 0, res.app visi „ok”/skaitļi, nav PAGEERROR) un <prefikss>.png
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const [,, ROOT, DIST, OUT] = process.argv;
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
  const page = await ctx.newPage();
  const logs = [], net = new Set();
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.type() + ': ' + m.text().slice(0, 300)); });
  page.on('pageerror', e => logs.push('PAGEERROR: ' + String(e && e.stack || e).slice(0, 500)));
  await page.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.hostname === 'app.test') {
      const f = path.join(ROOT, decodeURIComponent(u.pathname === '/' ? '/index-gl.html' : u.pathname));
      if (fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ status: 200, body: fs.readFileSync(f), headers: { 'content-type': mime(f) } });
      return route.fulfill({ status: 404, body: 'nf' });
    }
    if (u.hostname === 'unpkg.com' && /maplibre-gl@/.test(u.pathname)) {
      const name = u.pathname.split('/').pop();
      const f = path.join(DIST, name);
      net.add('unpkg ' + u.pathname + (fs.existsSync(f) ? '' : ' MISSING'));
      if (fs.existsSync(f)) return route.fulfill({ status: 200, body: fs.readFileSync(f), headers: { 'content-type': mime(f), 'access-control-allow-origin': '*' } });
      return route.fulfill({ status: 404, body: 'nf' });
    }
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
  await page.evaluate(() => { map.jumpTo({ center: [24.101, 56.951], zoom: 16, pitch: 0, bearing: 0 }); });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: OUT + '.png' });
  fs.writeFileSync(OUT + '.json', JSON.stringify({ res, logs, net: [...net] }, null, 1));
  console.log(JSON.stringify({ res: { ...res, layers: Array.isArray(res.layers) ? res.layers.length : res.layers }, nlogs: logs.length }, null, 1));
  await browser.close();
  // A08: spriedums (GitHub Actions) — kods 1, ja karte neielādējās, kāds solis kļūdījās, XSS izpildījās vai lapā bija kļūda
  const bad = [];
  if (!res.styleLoaded) bad.push('karte neielādējās');
  if (res.xss) bad.push('attribution XSS izpildījās');
  const want = (fs.readFileSync(path.join(ROOT, 'index-gl.html'), 'utf8').match(/maplibre-gl@(\d+\.\d+\.\d+)\/dist\/maplibre-gl\.mjs/) || [])[1];
  if (want && res.version !== want) bad.push('MapLibre versija ' + res.version + ', gaidīta ' + want);
  for (const [k, v] of Object.entries({ ...res.steps, ...(res.app || {}) })) if (typeof v === 'string' && v.startsWith('ERR')) bad.push(k + ': ' + v);
  for (const k of ['popup', 'routeAfterStyle']) if (res.app && res.app[k] !== 'true') bad.push(k + ': ' + (res.app && res.app[k]));
  if (res.app && !/alert:police/.test(res.app.alertImg || '')) bad.push('brīdinājuma ikona netika uzzīmēta');
  if (!Array.isArray(res.layers) || res.layers.length < 10) bad.push('par maz slāņu: ' + JSON.stringify(res.layers).slice(0, 80));
  for (const l of logs) if (l.startsWith('PAGEERROR')) bad.push(l.slice(0, 200));
  if (bad.length) { console.error('KARTES TESTS NEIZDEVĀS:\n  ' + bad.join('\n  ')); process.exit(1); }
  console.log('Kartes tests: viss kārtībā (MapLibre ' + res.version + ')');
})().catch(e => { console.error(e); process.exit(1); });
