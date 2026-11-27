// B17 (audits 2): E2E — kopbrauciena plūsma caur īsto lietotni (Playwright, Chromium) pret īstu Supabase Auth +
// PostgREST + visām migrācijām (tests/e2e/stack.js). Divi cilvēki divos pārlūka kontekstos, viss caur lietotnes pogām:
//   piekrišana → anonīms konts (Auth) → profils → pieprasījums (pasažieris) → šoferis redz tikai aptuveni → piedāvājums →
//   pieņemšana → šoferis redz vārdu → čats abos virzienos → svešs konts ziņas neredz (RLS) → atcelšana → konta dzēšana.
// Pārbauda arī: piekrišanas ieraksti serverī, nav lapas kļūdu un CSP pārkāpumu. Maksājumi (Stripe, ride-pay) — nav (vajag
// Stripe atslēgas); tos pārbauda tests/run.js (ride-pay loģika) un SQL scenāriji.
// Lietošana: PGHOST=… PGUSER=… PGPASSWORD=… CZ_E2E_BIN=<mape ar auth, postgrest> node tests/e2e/rides-flow.js [<lietotnes mape>]
// Lietotnes mape — repozitorijs (noklusēti) vai būvētā vietne. Kods 1, ja kāds solis neizdodas.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const { czE2eStart } = require('./stack.js');

const SITE = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const T = 40000;                      // gaidīšana vienam solim (lietotne atjauno datus ik 4–15 s)
const STYLE = { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#dde' } }] };
const PHOTON = { type: 'FeatureCollection', features: [
  { type: 'Feature', geometry: { type: 'Point', coordinates: [24.355, 56.862] }, properties: { name: 'Salaspils', city: 'Salaspils', country: 'Latvija', osm_key: 'place', osm_value: 'town', type: 'city' } }] };
const mime = f => /\.m?js$/.test(f) ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : f.endsWith('.html') ? 'text/html'
  : f.endsWith('.json') || f.endsWith('.webmanifest') ? 'application/json' : f.endsWith('.svg') ? 'image/svg+xml' : f.endsWith('.png') ? 'image/png' : 'application/octet-stream';

const results = [];
let failed = 0;
function step(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok || !detail ? '' : '\n      ' + String(detail).slice(0, 600)));
}

(async () => {
  const st = await czE2eStart({ log: m => console.log('  · ' + m) });
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = {};
  const config = `const RIDES_CONFIG = { url: 'https://app.test', anonKey: '${st.anonKey}', captchaSiteKey: '' };\n`;

  // Lietotne no https://app.test (tā pati adrese = CSP 'self'); /auth/v1 un /rest/v1 — uz lokālo Auth un PostgREST
  // (kā Supabase vārteja: apikey obligāts; bez Authorization — anon loma no apikey).
  async function route(r) {
    const req = r.request(), u = new URL(req.url());
    if (u.hostname === 'app.test') {
      const api = /^\/(auth|rest)\/v1(\/.*)$/.exec(u.pathname);
      if (api) {
        const h = { ...req.headers() };
        if (h.apikey !== st.anonKey) return r.fulfill({ status: 401, body: '{"message":"Invalid API key"}', headers: { 'content-type': 'application/json' } });
        if (!h.authorization) h.authorization = 'Bearer ' + st.anonKey;
        const target = (api[1] === 'auth' ? st.authUrl : st.restUrl) + api[2] + u.search;
        try { return r.fulfill({ response: await r.fetch({ url: target, headers: h }) }); }
        catch (e) { return r.fulfill({ status: 502, body: String(e) }); }
      }
      if (u.pathname.startsWith('/functions/v1/')) return r.fulfill({ status: 503, body: '{"error":"nav E2E testā"}', headers: { 'content-type': 'application/json' } });
      if (u.pathname === '/rides-config.js') return r.fulfill({ status: 200, body: config, headers: { 'content-type': 'text/javascript' } });
      const f = path.join(SITE, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
      if (f.startsWith(SITE) && fs.existsSync(f) && fs.statSync(f).isFile()) return r.fulfill({ status: 200, body: fs.readFileSync(f), headers: { 'content-type': mime(f) } });
      return r.fulfill({ status: 404, body: 'nf' });
    }
    if (u.hostname === 'tiles.openfreemap.org' && u.pathname.startsWith('/styles/')) return r.fulfill({ status: 200, body: JSON.stringify(STYLE), headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
    if (u.hostname === 'photon.komoot.io') return r.fulfill({ status: 200, body: JSON.stringify(PHOTON), headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
    return r.fulfill({ status: 503, body: '', headers: { 'access-control-allow-origin': '*' } });
  }
  async function person(name, lat, lng) {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 420, height: 860 }, geolocation: { latitude: lat, longitude: lng }, permissions: ['geolocation'], locale: 'lv-LV' });
    await ctx.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.effectiveDirective + ' ' + (e.blockedURI || ''))); });
    await ctx.route('**/*', route);
    const page = await ctx.newPage();
    errors[name] = [];
    page.on('pageerror', e => errors[name].push(String(e && e.stack || e).slice(0, 400)));
    await page.goto('https://app.test/');
    return page;
  }
  // Lietotne ir gatava: kopbraucienu kods ielādēts (vēlā ielāde) un ir GPS vieta (kā telefonā pēc atvēršanas)
  async function ready(p) {
    await p.waitForFunction(() => typeof rides !== 'undefined' && rides.ready && typeof state !== 'undefined' && !!state.me, null, { timeout: T });
  }
  const body = p => p.locator('#ridesBody');
  const click = (p, text) => body(p).getByRole('button', { name: text, exact: true }).first().click();
  const ok = async (name, fn) => { try { const r = await fn(); step(name, r !== false, r === false ? 'false' : ''); return true; } catch (e) { step(name, false, e && e.message || e); return false; } };
  const userId = p => p.evaluate(() => rides.store.id);
  const q = s => st.sql(s).trim();

  try {
    // ---------- Pasažieris ----------
    const P = await person('pasažieris', 56.9500, 24.1100);
    await ok('piekrišanas ekrāns pirmajā atvēršanā → „Piekrītu”', async () => {
      await P.locator('#consentGate').waitFor({ state: 'visible', timeout: T });
      await P.locator('#consentGate button[data-act="accept"]').click();
      await P.locator('#consentGate').waitFor({ state: 'hidden', timeout: T });
    });
    await ok('pasažieris: „Kopā” → anonīms konts (Auth) → profila forma', async () => {
      await ready(P);
      await P.locator('#ridesBtn').click();
      await P.locator('#rpName').waitFor({ timeout: T });
    });
    const pid = await userId(P);
    step('konts serverī: anonīms, piekrišanas ierakstītas', q(`select is_anonymous from auth.users where id = '${pid}'`) === 't'
      && q(`select string_agg(kind, ',' order by kind) from user_consents where user_id = '${pid}'`) === 'privacy,terms', q(`select kind from user_consents where user_id = '${pid}'`));
    await ok('profils saglabāts (vārds, tālrunis)', async () => {
      await P.fill('#rpName', 'Anna'); await P.fill('#rpPhone', '+371 20000001');
      await click(P, 'Saglabāt');
      await P.locator('#rqTo').waitFor({ timeout: T });
    });
    await ok('pieprasījums: galamērķis no meklēšanas → „Meklēt šoferi”', async () => {
      await P.locator('#rqTo').pressSequentially('Salaspils', { delay: 30 });
      await body(P).locator('.r-suggest button').first().click({ timeout: T });
      await P.fill('#rqNote', 'pie veikala ieejas');
      await click(P, 'Meklēt šoferi');
      await body(P).getByText('Meklē šoferi…').waitFor({ timeout: T });
    });
    step('serverī: 1 atvērts pieprasījums ar precīzu vietu', q(`select count(*) from ride_requests where user_id = '${pid}' and status = 'open' and to_name = 'Salaspils'`) === '1');

    // ---------- Šoferis (~1 km attālumā) ----------
    const D = await person('šoferis', 56.9560, 24.1250);
    await ok('šoferis: piekrišana, „Kopā” → „Es braucu”, profils ar auto', async () => {
      await D.locator('#consentGate button[data-act="accept"]').click({ timeout: T });
      await ready(D);
      await D.locator('#ridesBtn').click();
      await D.locator('#tabDrive').click();
      await D.locator('#rpName').waitFor({ timeout: T });
      await D.fill('#rpName', 'Jānis'); await D.fill('#rpPhone', '+371 20000002'); await D.fill('#rpCar', 'pelēka Škoda');
      await click(D, 'Saglabāt');
    });
    await ok('šoferis redz pieprasījumu tikai aptuveni (bez vārda un piezīmes)', async () => {
      try { await body(D).getByRole('button', { name: 'Paņemšu', exact: true }).waitFor({ timeout: T }); }
      catch (e) { throw new Error(e.message.split('\n')[0] + ' | ' + JSON.stringify(await D.evaluate(() => ({ me: state.me && [state.me.lat, state.me.lng], center: map.getCenter(), tab: rides.tab, open: rides.openList.length, prof: !!rides.profile, text: document.getElementById('ridesBody').innerText.slice(0, 300) })))); }
      const t = await body(D).innerText();
      if (/Anna|pie veikala/.test(t) || !/aptuveni/.test(t)) throw new Error('kartītē: ' + t.slice(0, 400));
    });
    await ok('šoferis: „Paņemšu” → piedāvājums nosūtīts', async () => {
      await click(D, 'Paņemšu');
      await body(D).getByText('Gaida pasažiera atbildi').waitFor({ timeout: T });
    });
    const did = await userId(D);

    // ---------- Pieņemšana ----------
    await ok('pasažieris redz piedāvājumu (šofera vārds) → „Pieņemt”', async () => {
      await body(P).getByRole('button', { name: 'Pieņemt', exact: true }).waitFor({ timeout: T });
      if (!/Jānis/.test(await body(P).innerText())) throw new Error('nav šofera vārda');
      await click(P, 'Pieņemt');
      await body(P).getByText('Šoferis atrasts').first().waitFor({ timeout: T });
    });
    await ok('pēc pieņemšanas pasažieris redz šofera tālruni', async () => { await body(P).locator('a.r-call[href="tel:+37120000002"]').waitFor({ timeout: T }); });
    await ok('pēc pieņemšanas šoferis redz pasažiera vārdu, tālruni, piezīmi', async () => {
      await body(D).getByText('Pasažieris gaida tevi').waitFor({ timeout: T });
      await body(D).getByText('Anna').first().waitFor({ timeout: T });
      await body(D).locator('a.r-call[href="tel:+37120000001"]').waitFor({ timeout: T });
    });
    step('serverī: piedāvājums accepted, pieprasījums matched', q(`select o.status || '/' || r.status from ride_offers o join ride_requests r on r.id = o.request_id where o.driver_id = '${did}'`) === 'accepted/matched');

    // ---------- Čats ----------
    await ok('čats: pasažieris → šoferis', async () => {
      await click(P, 'Čats');
      await P.fill('#rcInput', 'Sveiki! Gaidu pie veikala.');
      await P.locator('#rcInput').press('Enter');
      await body(P).locator('.r-msg.mine', { hasText: 'Sveiki! Gaidu pie veikala.' }).waitFor({ timeout: T });
      await click(D, 'Čats');
      await body(D).locator('.r-msg.theirs', { hasText: 'Sveiki! Gaidu pie veikala.' }).waitFor({ timeout: T });
    });
    await ok('čats: šoferis → pasažieris (ātrā atbilde)', async () => {
      await click(D, 'Būšu pēc 5 min');
      await body(P).locator('.r-msg.theirs', { hasText: 'Būšu pēc 5 min' }).waitFor({ timeout: T });
    });

    // ---------- Svešs konts (RLS caur īsto REST API) ----------
    const I = await person('svešais', 57.10, 24.50);
    await I.locator('#consentGate button[data-act="accept"]').click({ timeout: T });
    await I.waitForFunction(() => typeof czAuthGet === 'function' && czAuthGet(), null, { timeout: T });
    const spy = await I.evaluate(async () => {
      const a = czAuthGet(); const tok = await a.token({ create: true });
      const h = { apikey: RIDES_CONFIG.anonKey, Authorization: 'Bearer ' + tok, 'content-type': 'application/json' };
      const g = async p => { const r = await fetch('/rest/v1/' + p, { headers: h }); return r.ok ? (await r.json()).length : 'HTTP ' + r.status; };
      return { msgs: await g('ride_messages?select=id'), reqs: await g('ride_requests?select=id'), offers: await g('ride_offers?select=id'),
        profiles: await g('profiles?select=id'), contacts: await g('contacts?select=id') };
    });
    step('svešs konts neredz ziņas, pieprasījumus, piedāvājumus, profilus, tālruņus', spy.msgs === 0 && spy.reqs === 0 && spy.offers === 0 && spy.profiles === 0 && spy.contacts === 0, JSON.stringify(spy));
    const offerId = q(`select id from ride_offers where driver_id = '${did}'`);
    const write = await I.evaluate(async oid => {
      const tok = await czAuthGet().token();
      const h = { apikey: RIDES_CONFIG.anonKey, Authorization: 'Bearer ' + tok, 'content-type': 'application/json', Prefer: 'return=minimal' };
      const m = await fetch('/rest/v1/ride_messages', { method: 'POST', headers: h, body: JSON.stringify({ offer_id: oid, sender: czAuthGet().userId, body: 'svešs' }) });
      const o = await fetch('/rest/v1/ride_offers?id=eq.' + oid, { method: 'PATCH', headers: { ...h, Prefer: 'return=representation' }, body: JSON.stringify({ status: 'cancelled' }) });
      return { msg: m.status, offer: o.status, offerRows: o.ok ? (await o.json()).length : -1 };
    }, offerId);
    step('svešs konts nevar rakstīt čatā un mainīt piedāvājumu', write.msg >= 400 && (write.offerRows === 0 || write.offer >= 400)
      && q(`select status from ride_offers where id = '${offerId}'`) === 'accepted' && q(`select count(*) from ride_messages where body = 'svešs'`) === '0', JSON.stringify(write));

    // ---------- Atcelšana ----------
    await ok('pasažieris atceļ braucienu („Atcelt” → „Jā, atcelt”)', async () => {
      await click(P, '← Atpakaļ');
      await click(P, 'Atcelt');
      await click(P, 'Jā, atcelt');
      await body(P).getByText('Šoferis atrasts').first().waitFor({ state: 'detached', timeout: T });
    });
    step('serverī: pieprasījums cancelled', q(`select status from ride_requests where user_id = '${pid}'`) === 'cancelled');
    await ok('šoferis vairs neredz aktīvo braucienu', async () => {
      await click(D, '← Atpakaļ').catch(() => {});
      await body(D).getByText('Pasažieris gaida tevi').waitFor({ state: 'detached', timeout: T });
    });

    // ---------- Konta dzēšana ----------
    await ok('pasažieris dzēš kontu („Saglabāt kontu” → „Dzēst kontu” → apstiprina)', async () => {
      await click(P, 'Saglabāt kontu');
      await click(P, 'Dzēst kontu');
      await click(P, 'Jā, dzēst neatgriezeniski');
      await body(P).getByText('Konts un tā dati ir dzēsti').waitFor({ timeout: T });
    });
    step('serverī: konts, profils, tālrunis, ziņas dzēsti; šoferis paliek',
      q(`select (select count(*) from auth.users where id = '${pid}') || '/' || (select count(*) from profiles where id = '${pid}') || '/' || (select count(*) from contacts where id = '${pid}') || '/' || (select count(*) from ride_messages where sender = '${pid}') || '/' || (select count(*) from auth.users where id = '${did}')`) === '0/0/0/0/1',
      q(`select (select count(*) from auth.users where id = '${pid}'), (select count(*) from ride_messages where sender = '${pid}')`));
    step('pēc dzēšanas lokālā sesija notīrīta', await P.evaluate(() => !czAuthGet().hasSession()));

    // ---------- Kļūdas ----------
    for (const [who, p] of [['pasažieris', P], ['šoferis', D], ['svešais', I]]) {
      const csp = await p.evaluate(() => window.__csp);
      step(who + ': nav lapas kļūdu un CSP pārkāpumu', !errors[who].length && !csp.length, JSON.stringify({ errors: errors[who], csp }));
    }
  } catch (e) {
    step('E2E izpilde', false, e && e.stack || e);
  } finally {
    await browser.close().catch(() => {});
    if (failed) console.log('\nAuth žurnāls:\n' + st.out.auth.slice(-1500) + '\nPostgREST žurnāls:\n' + st.out.rest.slice(-1500));
    await st.stop();
  }
  console.log(`\nE2E: ${results.length - failed} izdevās, ${failed} neizdevās`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
