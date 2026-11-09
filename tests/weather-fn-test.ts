// Edge funkcijas „weather” tests (B04). Bez tīkla — fetch aizstāts. Palaišana: deno run --allow-env --allow-read tests/weather-fn-test.ts
// Atslēga šeit ir izdomāta testa vērtība.
Deno.env.set('CZ_TEST','1'); Deno.env.set('OPEN_METEO_KEY','k_test_123');
const calls: string[] = [];
globalThis.fetch = (async (u: string) => { calls.push(String(u)); return new Response('{"current":{"temperature_2m":5}}', { status: 200 }); }) as typeof fetch;
const m = await import(new URL('../supabase/functions/weather/index.ts', import.meta.url).href);
const R = (q: string, h: Record<string,string> = {}, method = 'GET') => m.handle(new Request('https://x.supabase.co/functions/v1/weather' + q, { method, headers: h }));
const check = (c: boolean, n: string) => console.log((c ? 'PASS ' : 'FAIL ') + n);
let r = await R('?latitude=56.9496&longitude=24.1052&current=everything&apikey=evil', { origin: 'https://growlab.cc', 'x-forwarded-for': '1.1.1.1' });
check(r.status === 200 && r.headers.get('access-control-allow-origin') === 'https://growlab.cc', 'ok + cors');
const body = await r.text();
check(!body.includes('k_test_123'), 'key not in body');
check(calls.length === 1 && calls[0].includes('latitude=56.95') && calls[0].includes('longitude=24.11') && calls[0].includes('apikey=k_test_123') && !calls[0].includes('evil') && !calls[0].includes('everything') && calls[0].startsWith('https://customer-api.open-meteo.com/'), 'upstream url sanitized+rounded: ' + calls[0].replace('k_test_123','***'));
r = await R('?latitude=56.951&longitude=24.1061', { 'x-forwarded-for': '1.1.1.1' });
check(r.headers.get('x-cache') === 'hit' && calls.length === 1, 'cache hit for same ~1 km');
check(r.headers.get('access-control-allow-origin') === 'https://growlab.cc', 'no origin -> default');
r = await R('?latitude=abc&longitude=24', {}); check(r.status === 400, 'bad lat');
r = await R('?latitude=95&longitude=24', {}); check(r.status === 400, 'lat out of range');
r = await R('?latitude=56&longitude=24', {}, 'POST'); check(r.status === 405, 'POST refused');
r = await R('', {}, 'OPTIONS'); check(r.status === 204, 'preflight');
r = await R('?latitude=1&longitude=1', { origin: 'https://evil.example' }); check(r.headers.get('access-control-allow-origin') === 'https://growlab.cc', 'foreign origin not reflected');
let last = 0; for (let i = 0; i < 31; i++) { last = (await R('?latitude=' + (10 + i) + '&longitude=1', { 'x-forwarded-for': '9.9.9.9' })).status; }
check(last === 429, '31st per minute -> 429');
check(m.coord('56.123', 90) === 56.12 && m.coord('1e5', 90) === null && m.coord('-200', 180) === null, 'coord');
