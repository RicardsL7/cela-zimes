// Ceļa Zīmes — laikapstākļi caur Open-Meteo maksas plānu (Supabase Edge Function "weather"). Audits 2, B04.
//
// KĀPĒC: bezmaksas Open-Meteo API ir tikai nekomerciālai lietošanai. Kad lietotne ieslēdz īstus maksājumus
// (PAY_LIVE — lietotne kļūst komerciāla), laikapstākļiem jāiet caur maksas plānu ar atslēgu. Atslēgu pārlūkā likt nedrīkst
// (to varētu nokopēt un iztērēt mūsu limitu), tāpēc pārlūks jautā šai funkcijai, un atslēga ir tikai Supabase Secrets.
//
// KAMĒR NAV VAJADZĪGA, NAV IZVIETOTA. Lietotne pēc noklusējuma jautā bezmaksas API tieši (services.js → CZ_SERVICES.weather).
//
// IESLĒGŠANA (lietotnes īpašnieks — README „Ārējie servisi: pāreja uz komerciālu lietošanu”):
//   1) open-meteo.com → API Standard abonements → atslēga.
//   2) Supabase → Edge Functions → Secrets: OPEN_METEO_KEY = <atslēga>   (nekad pārlūkā, HTML, JS vai repozitorijā)
//   3) Izvieto šo funkciju ar "Verify JWT" IZSLĒGTU (laikapstākļi vajadzīgi arī nepieteikušamies lietotājam).
//   4) services.js: weather: 'https://pkqusuoicxmwcgwsrdqy.supabase.co/functions/v1/weather' (+ jauna ?v= versija).
//
// AIZSARDZĪBA (lai mūsu limitu nevar viegli iztērēt):
//   • tikai GET, tikai tie lauki, ko lietotne prasa (WEATHER_FIELDS — tie paši app-gl.js); citi parametri tiek ignorēti;
//   • vieta noapaļota līdz 0,01° (~1 km) — mazāk dažādu pieprasījumu un nav precīzas atrašanās vietas;
//   • atbilde 10 min kešatmiņā (funkcijā un pārlūkā — Cache-Control);
//   • ≤ 30 pieprasījumi minūtē no vienas IP adreses vienā funkcijas instancē;
//   • CORS — tikai lietotnes adreses (pārlūkiem; citus ierobežo iepriekšējie punkti).
// Atslēga nekad netiek atdota atbildē un nenonāk žurnālā.

const KEY = (Deno.env.get('OPEN_METEO_KEY') ?? '').trim();
const UPSTREAM = 'https://customer-api.open-meteo.com/v1/forecast';
const WEATHER_FIELDS = 'temperature_2m,precipitation,rain,showers,snowfall,weather_code,wind_gusts_10m,visibility';
const ORIGINS = ['https://growlab.cc', 'https://www.growlab.cc', 'https://ricardsl7.github.io'];
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const TTL_MS = 10 * 60 * 1000, CACHE_MAX = 2000, PER_MIN = 30;

const cache = new Map<string, { t: number; body: string }>();
const hits = new Map<string, { t: number; n: number }>();

function corsFor(origin: string | null): Record<string, string> {
  const ok = origin && (ORIGINS.includes(origin) || LOCAL.test(origin));
  return {
    'Access-Control-Allow-Origin': ok ? origin! : ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
  };
}
const reply = (body: string, status: number, cors: Record<string, string>, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { ...cors, 'content-type': 'application/json', ...extra } });
const err = (msg: string, status: number, cors: Record<string, string>) => reply(JSON.stringify({ error: msg }), status, cors);

// Koordināta → noapaļota līdz 0,01°; ārpus robežām vai nav skaitlis → null
export function coord(v: string | null, lim: number): number | null {
  if (v == null || !/^-?\d{1,3}(\.\d+)?$/.test(v.trim())) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > lim) return null;
  return Math.round(n * 100) / 100;
}

export function limited(ip: string, now = Date.now()): boolean {
  const h = hits.get(ip);
  if (!h || now - h.t > 60000) { hits.set(ip, { t: now, n: 1 }); if (hits.size > 5000) hits.clear(); return false; }
  h.n++;
  return h.n > PER_MIN;
}

export async function handle(req: Request): Promise<Response> {
  const cors = corsFor(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'GET') return err('Tikai GET', 405, cors);
  if (!KEY) return err('Laikapstākļu atslēga nav iestatīta (OPEN_METEO_KEY)', 503, cors);

  const u = new URL(req.url);
  const lat = coord(u.searchParams.get('latitude'), 90), lng = coord(u.searchParams.get('longitude'), 180);
  if (lat == null || lng == null) return err('Nepareiza vieta', 400, cors);

  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'nav';
  if (limited(ip)) return err('Par daudz pieprasījumu — pamēģini pēc minūtes', 429, { ...cors, 'Retry-After': '60' });

  const k = lat.toFixed(2) + ',' + lng.toFixed(2);
  const now = Date.now();
  const c = cache.get(k);
  if (c && now - c.t < TTL_MS) return reply(c.body, 200, cors, { 'Cache-Control': 'public, max-age=600', 'X-Cache': 'hit' });

  const q = new URLSearchParams({ latitude: lat.toFixed(2), longitude: lng.toFixed(2), current: WEATHER_FIELDS,
    wind_speed_unit: 'ms', timezone: 'auto', apikey: KEY });
  let r: Response;
  try {
    r = await fetch(UPSTREAM + '?' + q, { signal: AbortSignal.timeout(7000) });
  } catch {
    return err('Laikapstākļu serveris neatbild', 502, cors);
  }
  if (!r.ok) {
    console.warn('Open-Meteo atbilde', r.status);      // bez URL — tajā ir atslēga
    return err('Laikapstākļu serveris: ' + r.status, r.status === 429 ? 429 : 502, cors);
  }
  const body = await r.text();
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(k, { t: now, body });
  return reply(body, 200, cors, { 'Cache-Control': 'public, max-age=600', 'X-Cache': 'miss' });
}

// Testos (CZ_TEST=1) serveri neieslēdz — tie izsauc handle() tieši
if (Deno.env.get('CZ_TEST') !== '1') Deno.serve(handle);
