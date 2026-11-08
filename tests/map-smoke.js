// A07: kartes dūmu tests (Playwright, Chromium). Atver index-gl.html no šīs mapes (MapLibre — no vendor/, A10),
// vienkāršu pamatkartes stilu (ar ļaunprātīgu attribution — XSS pārbaudei), pārējais tīkls bloķēts. Pārbauda kartes
// izveidi, slāņus, kameru, markerus, popup, maršrutu, brīdinājumu ikonas, stila maiņu un ka attribution XSS neizpildās.
// A10: lapas drošības politika (CSP meta tags) ir spēkā — neviens CSP pārkāpums nedrīkst rasties; kartes worker no tās
// pašas adreses; admin/privacy/terms atveras bez pārkāpumiem; lapa svešā rāmī (iframe) netiek rādīta.
// A12: paneļi ar tastatūru — fokuss panelī, fons paslēpts (modāliem), Tab riņķo, Esc aizver, fokuss atpakaļ; piekrišanas ekrāns.
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
  const routeAll = async route => {   // A10: ctx — arī pārējām lapām; A12: arī kontekstam bez piekrišanas
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
  };
  await ctx.route('**/*', routeAll);
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
  // A12: paneļi ar tastatūru — fokuss panelī, fons ekrāna lasītājam paslēpts, Tab riņķo panelī, Esc aizver, fokuss atpakaļ
  res.a11y = {};
  const st = (sheet) => page.evaluate(id => {
    const a = document.activeElement, el = document.getElementById(id);
    return { open: !el.hidden, inside: el.contains(a), active: a ? (a.id || a.tagName) : null, role: el.getAttribute('role'),
      modal: el.getAttribute('aria-modal'), mapHidden: document.getElementById('map').getAttribute('aria-hidden'),
      mapInert: document.getElementById('map').inert };
  }, sheet);
  const tabLoop = async (sheet, n) => { let out = 0; for (let i = 0; i < n; i++) { await page.keyboard.press(i % 7 === 6 ? 'Shift+Tab' : 'Tab');
    if (!(await page.evaluate(id => document.getElementById(id).contains(document.activeElement), sheet))) out++; } return out; };
  for (const [sheet, btn, modal] of [['settings', 'settingsBtn', true], ['reportSheet', 'reportBtn', true], ['parkSheet', 'parkBtn', false]]) {
    const r = {};
    await page.focus('#' + btn); await page.keyboard.press('Enter'); await page.waitForTimeout(400);
    r.opened = await st(sheet);
    r.expanded = await page.getAttribute('#' + btn, 'aria-expanded');
    r.tabOut = modal ? await tabLoop(sheet, 40) : null;
    await page.focus('#' + sheet + ' h2'); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    r.closed = await st(sheet);
    r.closedExpanded = await page.getAttribute('#' + btn, 'aria-expanded');
    res.a11y[sheet] = r;
  }
  // Ar peli atvērts → Esc → fokuss uz pogu, ar ko atvēra
  await page.click('#settingsBtn'); await page.waitForTimeout(300); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  res.a11y.mouse = await page.evaluate(() => document.activeElement && document.activeElement.id);
  // Garāžas pirkuma dialogs Garāžā: fons (arī paneļa pogas) inert, Esc aizver tikai dialogu, fokuss atpakaļ Garāžā
  await page.focus('#garageBtn'); await page.keyboard.press('Enter'); await page.waitForTimeout(400);
  await page.evaluate(() => { const b = document.createElement('button'); b.id = 'a12Buy'; b.textContent = 'Pirkt'; document.getElementById('garageSheet').appendChild(b); b.focus();
    garageConfirmBuy({ id: Object.keys(SKIN_CHARS)[0] + '-1', name: 'Tests', price: 10 }); });
  await page.waitForTimeout(300);
  res.a11y.garageDlg = await page.evaluate(() => ({ inside: document.getElementById('garageDlg').contains(document.activeElement),
    closeInert: document.getElementById('closeGarage').closest('[inert]') !== null, mapInert: document.getElementById('map').inert }));
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  res.a11y.garageDlgClosed = await page.evaluate(() => ({ dlg: document.getElementById('garageDlg').hidden, sheet: document.getElementById('garageSheet').hidden,
    active: document.activeElement && document.activeElement.id, inert: !!document.querySelector('[inert]') }));
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  res.a11y.garageClosed = await page.evaluate(() => ({ sheet: document.getElementById('garageSheet').hidden, active: document.activeElement && document.activeElement.id }));
  // Piekrišanas ekrāns (jauns lietotājs): fokuss tajā, fons inert, Esc neaizver, solis „Nepiekrītu” nepazaudē fokusu
  { const ctx2 = await browser.newContext({ viewport: { width: 420, height: 860 } });
    await ctx2.route('**/*', routeAll);
    const pg = await ctx2.newPage(); const errs = [];
    pg.on('pageerror', e => errs.push(String(e && e.message || e).slice(0, 200)));
    await pg.goto('https://app.test/index-gl.html'); await pg.waitForTimeout(2500);
    const g = () => pg.evaluate(() => ({ open: !document.getElementById('consentGate').hidden, inside: document.getElementById('consentGate').contains(document.activeElement),
      active: document.activeElement && (document.activeElement.id || document.activeElement.tagName), mapInert: document.getElementById('map').inert }));
    const c = { start: await g() };
    await pg.keyboard.press('Escape'); await pg.waitForTimeout(200); c.esc = await g();
    await pg.focus('#consentGate [data-act="decline"]'); await pg.keyboard.press('Enter'); await pg.waitForTimeout(300); c.declined = await g();
    await pg.click('#consentGate [data-act="back"]'); await pg.waitForTimeout(200);
    await pg.click('#consentGate [data-act="accept"]'); await pg.waitForTimeout(300); c.accepted = await g(); c.errs = errs;
    res.a11y.consent = c; await ctx2.close(); }
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
  // A12
  const A = res.a11y || {};
  for (const [sheet, btn, modal] of [['settings', 'settingsBtn', true], ['reportSheet', 'reportBtn', true], ['parkSheet', 'parkBtn', false]]) {
    const r = A[sheet] || {};
    if (!r.opened || !r.opened.open || !r.opened.inside) bad.push(sheet + ': atverot fokuss nav panelī (' + JSON.stringify(r.opened) + ')');
    if (r.opened && r.opened.role !== 'dialog') bad.push(sheet + ': nav role="dialog"');
    if (modal && r.opened && (r.opened.modal !== 'true' || r.opened.mapHidden !== 'true')) bad.push(sheet + ': modālam fons nav paslēpts / nav aria-modal');
    if (!modal && r.opened && (r.opened.modal || r.opened.mapHidden)) bad.push(sheet + ': ne-modālam panelim fons paslēpts');
    if (r.expanded !== 'true' || r.closedExpanded !== 'false') bad.push(sheet + ': aria-expanded ' + r.expanded + ' → ' + r.closedExpanded);
    if (modal && r.tabOut) bad.push(sheet + ': Tab izgāja no paneļa ' + r.tabOut + ' reizes');
    if (!r.closed || r.closed.open || r.closed.active !== btn || r.closed.mapHidden) bad.push(sheet + ': Esc → ' + JSON.stringify(r.closed));
  }
  if (A.mouse !== 'settingsBtn') bad.push('ar peli atvērts panelis: fokuss pēc Esc uz ' + A.mouse);
  if (!A.garageDlg || !A.garageDlg.inside || !A.garageDlg.closeInert || !A.garageDlg.mapInert) bad.push('Garāžas dialogs: ' + JSON.stringify(A.garageDlg));
  if (!A.garageDlgClosed || !A.garageDlgClosed.dlg || A.garageDlgClosed.sheet || A.garageDlgClosed.active !== 'a12Buy' || A.garageDlgClosed.inert) bad.push('Garāžas dialogs aizverot: ' + JSON.stringify(A.garageDlgClosed));
  if (!A.garageClosed || !A.garageClosed.sheet || A.garageClosed.active !== 'garageBtn') bad.push('Garāža aizverot: ' + JSON.stringify(A.garageClosed));
  const C = A.consent || {};
  if (!C.start || !C.start.open || !C.start.inside || !C.start.mapInert) bad.push('piekrišana: ' + JSON.stringify(C.start));
  if (!C.esc || !C.esc.open) bad.push('piekrišana aizvērās ar Esc');
  if (!C.declined || !C.declined.inside) bad.push('piekrišana „Nepiekrītu”: fokuss pazuda ' + JSON.stringify(C.declined));
  if (!C.accepted || C.accepted.open || C.accepted.mapInert) bad.push('piekrišana pēc „Piekrītu”: ' + JSON.stringify(C.accepted));
  if (C.errs && C.errs.length) bad.push('piekrišanas lapā kļūda: ' + C.errs[0]);
  for (const n of net) if (/^404 /.test(n) && !/favicon/.test(n)) bad.push('trūkst faila: ' + n.slice(4));
  if (bad.length) { console.error('KARTES TESTS NEIZDEVĀS:\n  ' + bad.join('\n  ')); process.exit(1); }
  console.log('Kartes tests: viss kārtībā (MapLibre ' + res.version + ')');
})().catch(e => { console.error(e); process.exit(1); });
