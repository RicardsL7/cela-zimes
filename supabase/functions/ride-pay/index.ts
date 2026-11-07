// Ceļa Zīmes — kopbraucienu maksājumi ar karti (Supabase Edge Function "ride-pay").
//
// Stripe Connect (Accounts v2 „recipient” konti) + "destination charges": pasažieris maksā cenu, Stripe nosūta šoferim cenu mīnus
// lietotnes komisiju (PAY_FEE_PERCENT, noklusēti 10 %), komisija paliek lietotnes Stripe kontā.
//
// Iestatījumi (Supabase → Edge Functions → Secrets) — tos ieliek lietotnes īpašnieks pats:
//   STRIPE_SECRET_KEY  — Stripe slepenā atslēga. Testa režīmā sk_test_… (vai ierobežotā rk_test_…).
//   PAY_LIVE=yes       — tikai tad, kad apzināti ieslēdz īstus maksājumus (ar sk_live_…).
//   PAY_FEE_PERCENT    — komisija procentos (neobligāti, noklusēti 10).
//
// Atmaksa (F14, darbības "refund" un "refund_sync"; datubāze — supabase/rides-8-refund.sql): Stripe Refund ar
// reverse_transfer (nauda atgūta no šofera konta) un refund_application_fee (atgriež arī komisiju), Idempotency-Key
// "refund-<brauciena ID>" — divreiz neatmaksā. Vai samaksāts / atmaksāts — vienmēr jautā Stripe.
//
// Datubāzei funkcija piekļūst AR LIETOTĀJA PAŠA pieteikšanos (RLS noteikumi supabase/rides-3-pay.sql).
// Vienīgais izņēmums (F17, v113): maksājuma statusa pieraksts rpc/ride_payment_mark — ar Supabase iebūvēto servisa
// atslēgu (SUPABASE_SERVICE_ROLE_KEY), jo pārlūks šo funkciju izsaukt nedrīkst (supabase/rides-11-paymark.sql).
// Vai brauciens samaksāts, funkcija vienmēr jautā Stripe.

const SK = (Deno.env.get('STRIPE_SECRET_KEY') ?? '').trim();
const LIVE_OK = Deno.env.get('PAY_LIVE') === 'yes';
const SB = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
// F17: Supabase iebūvētā servisa atslēga (Edge Function vidē jau ir). Lieto TIKAI maksājuma statusa pierakstam
// (rpc/ride_payment_mark, ko pārlūks izsaukt nevar). Nekad netiek atdota atbildē un nenonāk pārlūkā.
const SRK = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim();
const FEE_PCT = Math.min(30, Math.max(0, Number(Deno.env.get('PAY_FEE_PERCENT') ?? '10') || 0));
const APP_URLS = ['https://growlab.cc/', 'https://www.growlab.cc/', 'https://ricardsl7.github.io/cela-zimes/', 'http://localhost:', 'http://127.0.0.1:'];   // growlab.cc — galvenā adrese (29.10.)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'content-type': 'application/json' } });

class Fail extends Error {
  stripeStatus?: number; stripeType?: string;
  constructor(msg: string, public status = 400) { super(msg); }
}

// Stripe API pieprasījumi (form-urlencoded, ar ligzdotām atslēgām a[b][c]).
function form(obj: Record<string, unknown>, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v != null && typeof v === 'object') form(v as Record<string, unknown>, key, out);
    else if (v != null) out.append(key, String(v));
  }
  return out;
}
// idem — Stripe Idempotency-Key (atkārtots pieprasījums ar to pašu atslēgu neko neizdara otrreiz)
// deno-lint-ignore no-explicit-any
async function stripe(path: string, body?: Record<string, unknown>, idem?: string): Promise<any> {
  const r = await fetch('https://api.stripe.com/v1/' + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + SK, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...(idem ? { 'Idempotency-Key': idem } : {}) },
    body: body ? form(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('Stripe', path, r.status, j?.error?.message);
    const f = new Fail('Stripe: ' + (j?.error?.message || r.status), 502);
    f.stripeStatus = r.status; f.stripeType = j?.error?.type;     // A04: idempotences kļūdu atpazīšanai
    throw f;
  }
  return j;
}

function withQ(url: string, q: string) {
  const u = new URL(url);
  for (const k of ['pay', 'r']) u.searchParams.delete(k);
  for (const [k, v] of new URLSearchParams(q)) u.searchParams.set(k, v);
  return u.toString();
}
// <checkout-flow> — A04: maksājuma lapa (Stripe Checkout) bez dublikātiem. Testi (tests/run.js) šo bloku izpilda tieši no šī faila.
//
// Problēma: divi vienlaicīgi „Maksāt ar karti” klikšķi (divas cilnes, dubultklikšķis, atkārtots pieprasījums pēc tīkla
// kļūmes) izveidoja divas Stripe maksājuma sesijas vienam braucienam — pasažieris varēja samaksāt divreiz, un datubāzē
// palika tikai viena no tām.
// Risinājums:
//   • Katram braucienam ir mēģinājuma numurs (ride_payments.attempt, supabase/rides-16-checkout.sql). Jaunu sesiju veido
//     ar Stripe Idempotency-Key „cz-checkout-<brauciens>-<numurs>”: vienlaicīgi pieprasījumi ar to pašu atslēgu saņem
//     VIENU UN TO PAŠU sesiju (Stripe to garantē), nevis divas.
//   • Jaunu sesiju veido tikai tad, ja iepriekšējā vairs nav apmaksājama (beigusies). Atvērtu sesiju atdod atkārtoti;
//     ja to tomēr jāaizstāj (cita summa), veco vispirms aizver (expire) — vienlaikus apmaksājama ir tikai viena.
//   • Ja Stripe neatbild par veco sesiju, jaunu NEVEIDO (vecā vēl varētu būt apmaksājama).
//   • Saglabā datubāzē ar salīdzināšanu (ride_checkout_save): vecāks mēģinājums nekad nepārraksta jaunāku.
// Bloks nezina neko par HTTP vai atslēgām — visu saņem kā funkcijas.
const CHECKOUT_KEY_PREFIX = 'cz-checkout-';
const checkoutKey = (oid: string, attempt: number) => `${CHECKOUT_KEY_PREFIX}${oid}-${attempt}`;

class CheckoutError extends Error {
  status: number; code: string;
  constructor(msg: string, status = 409, code = 'checkout') { super(msg); this.status = status; this.code = code; }
}
type CkErr = { stripeStatus?: number; stripeType?: string } | null | undefined;
// „Tā pati atslēga vēl tiek apstrādāta” (409) vai „atslēga jau lietota ar citiem datiem” (400)
const isIdemInFlight = (e: CkErr) => !!e && e.stripeStatus === 409;
const isIdemMismatch = (e: CkErr) => !!e && e.stripeType === 'idempotency_error' && e.stripeStatus !== 409;

type CkSession = { id: string; url: string; status: string; payment_status: string; amount_total: number; metadata?: { offer_id?: string } };
type CkDeps = {
  begin: () => Promise<{ session_id: string | null; attempt: number } | null>;   // datubāze, tikai pasažieris
  retrieve: (id: string) => Promise<CkSession | null>;                             // null — Stripe neatbild
  create: (params: unknown, key: string) => Promise<CkSession>;                    // ar Idempotency-Key
  expire: (id: string) => Promise<unknown>;
  save: (id: string, attempt: number) => Promise<boolean>;                         // false — jau ir jaunāks mēģinājums
  sleep: (ms: number) => Promise<unknown>;
};

async function checkoutFlow(deps: CkDeps, o: { oid: string; price_cents: number }, params: unknown) {
  const usable = (s: CkSession | null) => !!s && !!s.metadata && s.metadata.offer_id === o.oid;
  const reuse = async (id: string) => {
    const s = await deps.retrieve(id);
    if (!s) throw new CheckoutError('Neizdevās sazināties ar Stripe — mēģini vēlreiz.', 502, 'stripe_unreachable');
    if (!usable(s)) return { s, ok: false };
    if (s.payment_status === 'paid') throw new CheckoutError('Šis brauciens jau ir samaksāts', 409, 'already_paid');
    if (s.status === 'complete') throw new CheckoutError('Maksājums vēl tiek apstrādāts — pagaidi brīdi.', 409, 'processing');
    if (s.status === 'open' && s.amount_total === o.price_cents) return { s, ok: true };
    return { s, ok: false };
  };

  for (let round = 0; round < 3; round++) {
    const cur = await deps.begin();
    const attempt = Number(cur && cur.attempt) || 0;
    if (cur && cur.session_id) {
      const r = await reuse(cur.session_id);
      if (r.ok) return { url: r.s.url, session_id: r.s.id, reused: true };
      if (r.s.status === 'open' && usable(r.s)) await deps.expire(r.s.id);   // cita summa — veco aizver
    }
    const next = attempt + 1;
    let s: CkSession | null = null;
    for (let i = 0; i < 4 && !s; i++) {
      try {
        s = await deps.create(params, checkoutKey(o.oid, next));
      } catch (e) {
        if (isIdemInFlight(e as CkErr)) { await deps.sleep(600 * (i + 1)); continue; }   // otrs pieprasījums to pašu veido tieši tagad
        if (isIdemMismatch(e as CkErr)) throw new CheckoutError('Maksājuma lapa jau tiek atvērta citā logā — atjauno lapu un mēģini vēlreiz.', 409, 'in_other_tab');
        throw e;
      }
    }
    if (!s) throw new CheckoutError('Maksājuma lapa jau tiek sagatavota — mēģini pēc brīža.', 409, 'busy');
    const saved = await deps.save(s.id, next);
    if (saved && s.status === 'open') return { url: s.url, session_id: s.id, reused: false };
    if (saved) continue;              // atslēga atdeva vecu, jau beigušos sesiju (pēc ~24 h) — nākamais numurs
    // Kāds jau saglabāja jaunāku mēģinājumu: mūsējo aizver (ja tā nav tā pati) un nākamajā kārtā atdod saglabāto
    const again = await deps.begin();
    if (again && again.session_id && again.session_id !== s.id && s.status === 'open') await deps.expire(s.id);
  }
  throw new CheckoutError('Maksājuma lapa jau tiek sagatavota — mēģini pēc brīža.', 409, 'busy');
}
// </checkout-flow>

// Accounts v2 (šoferu konti): JSON + Stripe-Version
const V2 = '2026-09-30.endive';
// deno-lint-ignore no-explicit-any
async function stripeV2(path: string, body?: Record<string, unknown>): Promise<any> {
  const r = await fetch('https://api.stripe.com/v2/' + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + SK, 'Stripe-Version': V2, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('Stripe v2', path, r.status, j?.error?.message);
    throw new Fail('Stripe: ' + (j?.error?.message || r.status), 502);
  }
  return j;
}
// Šofera konts: vai pieder šim lietotājam un vai var saņemt pārskaitījumus
// deno-lint-ignore no-explicit-any
async function driverAccount(acct: string): Promise<{ owner: string | null; ready: boolean } | null> {
  const a = await stripeV2(`core/accounts/${acct}?include=configuration.recipient`).catch(() => null);
  if (!a) return null;
  const st = a.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status;
  return { owner: a.metadata?.cz_user ?? null, ready: st === 'active' };
}
const short = (s: string) => (s || '').split(',')[0].slice(0, 40) || '—';

// <refund-state> — A05: VIENA atmaksas stāvokļa loģika abām servera funkcijām (ride-pay un stripe-webhook).
// Šis bloks abos failos ir burtiski vienāds (to pārbauda tests/run.js) un testi to izpilda tieši no faila.
// Stripe atmaksas statusi: succeeded — nauda atdota; pending / requires_action — vēl apstrādē (var arī neizdoties);
// failed / canceled — nav atdots. Agrāk jebkura atmaksa (arī daļēja vai vēl gaidoša) tika uzskatīta par pilnu.
type RfRefund = { id?: string; amount?: number; status?: string; created?: number; metadata?: { cz_reason?: string } | null };
type RefundState = {
  amount: number;          // samaksātā summa (centi)
  refunded: number;        // jau atdots (tikai succeeded)
  pending: number;         // vēl apstrādē
  failed: number;          // neizdevušos / atcelto atmaksu skaits
  remaining: number;       // vēl atmaksājams (amount − refunded − pending)
  full: boolean;           // atdota visa summa — tikai tad datubāzē „refunded”
  state: 'none' | 'partial' | 'pending' | 'full';
  refundId: string | null; // jaunākā izdevusies atmaksa (pierakstam datubāzē)
  reason: string | null;
};
function refundState(amount: number, refunds: RfRefund[]): RefundState {
  const amt = Math.max(0, Math.round(Number(amount) || 0));
  const list = (refunds || []).filter((r) => r && typeof r === 'object');
  const sum = (xs: RfRefund[]) => xs.reduce((a, r) => a + Math.max(0, Math.round(Number(r.amount) || 0)), 0);
  const ok = list.filter((r) => r.status === 'succeeded');
  const pend = list.filter((r) => r.status === 'pending' || r.status === 'requires_action');
  const failed = list.filter((r) => r.status === 'failed' || r.status === 'canceled').length;
  const refunded = sum(ok), pending = sum(pend);
  const full = amt > 0 && refunded >= amt;
  const last = ok.slice().sort((a, b) => (Number(b.created) || 0) - (Number(a.created) || 0))[0];
  return {
    amount: amt, refunded, pending, failed, remaining: Math.max(0, amt - refunded - pending), full,
    state: full ? 'full' : pending > 0 ? 'pending' : refunded > 0 ? 'partial' : 'none',
    refundId: last && typeof last.id === 'string' ? last.id : null,
    reason: (last && last.metadata && typeof last.metadata.cz_reason === 'string') ? last.metadata.cz_reason : null,
  };
}
// Stripe Idempotency-Key atmaksai: vienāds vienlaicīgiem klikšķiem, jauns pēc katras izmaiņas (daļēja atmaksa vai neizdevusies)
const refundKey = (oid: string, st: RefundState) => `refund-${oid}-${st.refunded}-${st.failed}`;
// </refund-state>

// Maksājuma stāvoklis no Stripe: Checkout sesija → PaymentIntent → maksājums (charge) → atmaksas (A05: refundState)
type PayInfo = { ok: boolean; paid: boolean; amount: number | null; pi: string | null; rs: RefundState };
async function payInfo(sessionId: string, oid: string): Promise<PayInfo | null> {
  const s = await stripe('checkout/sessions/' + sessionId + '?expand[]=payment_intent.latest_charge.refunds').catch(() => null);
  if (!s) return null;
  const ok = s.metadata?.offer_id === oid;
  const pi = s.payment_intent && typeof s.payment_intent === 'object' ? s.payment_intent : null;
  const ch = pi && pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  let refunds: RfRefund[] = ch?.refunds?.data ?? [];
  if (ch && ch.refunds?.has_more) {                              // vairāk par 10 atmaksām — nolasa visas
    const all = await stripe('refunds?charge=' + ch.id + '&limit=100').catch(() => null);
    if (!all) return null;
    refunds = all.data ?? refunds;
  }
  const paid = ok && s.payment_status === 'paid';
  return {
    ok, paid, amount: ok ? s.amount_total : null,
    pi: pi ? pi.id : (typeof s.payment_intent === 'string' ? s.payment_intent : null),
    rs: refundState(paid ? Number(ch?.amount ?? s.amount_total) : 0, ok ? refunds : []),
  };
}
const REASONS = ['cancelled_before_pickup', 'driver_refund', 'stripe_dashboard'];

// F17/F19: datubāze ar servisa atslēgu — TIKAI maksājuma statusa pierakstam un īpašnieka sinhronizācijai.
// deno-lint-ignore no-explicit-any
async function sdb(path: string, init: RequestInit = {}): Promise<any> {
  const h: Record<string, string> = { apikey: SRK, 'content-type': 'application/json', ...((init.headers as Record<string, string>) ?? {}) };
  if (SRK.startsWith('eyJ')) h.Authorization = 'Bearer ' + SRK;   // vecā tipa (JWT) atslēga; jaunā sb_secret_ — tikai apikey
  const r = await fetch(SB + '/rest/v1/' + path, { ...init, headers: h });
  const t = await r.text();
  if (!r.ok) throw new Error('DB ' + path.split('?')[0] + ' ' + r.status + ' ' + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}
// Statusa pieraksts (rpc/ride_payment_mark — tikai service_role, tikai uz priekšu). userId — pārbaudīts brauciena dalībnieks.
async function markPay(userId: string, oid: string, status: 'paid' | 'refunded', refundId: string | null = null, reason: string | null = null, cents: number | null = null) {
  if (!SRK) { console.error('mark: nav SUPABASE_SERVICE_ROLE_KEY'); return false; }
  return await sdb('rpc/ride_payment_mark', { method: 'POST',
    body: JSON.stringify({ p_user_id: userId, oid, p_status: status, p_refund_id: refundId,
      p_reason: reason && REASONS.includes(reason) ? reason : (status === 'refunded' ? 'stripe_dashboard' : null), p_cents: cents }) }) === true;
}
const SYNC_MAX = 40;

// F16: Rīgas dienas / mēneša sākums (sekundes, UTC) — Stripe `created` salīdzināšanai
function rigaStart(unit: 'day' | 'month', now = Date.now()): number {
  const parts = (t: number) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Riga', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(t)).map((p) => [p.type, Number(p.value)]));
  const p = parts(now);
  const guess = Date.UTC(p.year, p.month - 1, unit === 'day' ? p.day : 1);
  const q = parts(guess);                                         // Rīgas pulkstenis brīdī `guess` → nobīde
  const off = Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second) - guess;
  return Math.floor((guess - off) / 1000);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    if (req.method !== 'POST') throw new Fail('Tikai POST', 405);
    const test = /^(sk|rk)_test_/.test(SK);
    if (!test && !(LIVE_OK && /^(sk|rk)_live_/.test(SK))) {
      // Kāda veida atslēga ielikta — tikai veids, nekad pati atslēga
      const kind = !SK ? 'nav ielikta' : /^pk_/.test(SK) ? 'ielikta publiskā (pk_) atslēga — vajag slepeno sk_test_' :
        /^(sk|rk)_live_/.test(SK) ? 'ielikta īstā (live) atslēga — testam vajag sk_test_' : 'atslēga neizskatās pēc Stripe slepenās atslēgas (sk_test_…)';
      throw new Fail('Kartes maksājumi vēl nav ieslēgti: ' + kind + '.', 503);
    }

    // Lietotājs — no viņa paša pieteikšanās
    const apikey = req.headers.get('apikey') ?? '';
    const auth = req.headers.get('authorization') ?? '';
    const ur = await fetch(SB + '/auth/v1/user', { headers: { apikey, Authorization: auth } });
    if (!ur.ok) throw new Fail('Nav pieteicies', 401);
    const uid: string = (await ur.json()).id;

    // deno-lint-ignore no-explicit-any
    const db = async (path: string, init: RequestInit = {}): Promise<any> => {
      const r = await fetch(SB + '/rest/v1/' + path, {
        ...init,
        headers: { apikey, Authorization: auth, 'content-type': 'application/json', ...(init.headers ?? {}) },
      });
      const t = await r.text();
      if (!r.ok) { console.error('DB', path, r.status, t.slice(0, 300)); throw new Fail('Datubāzes kļūda', 500); }
      return t ? JSON.parse(t) : null;
    };

    // Stripe konta īpašnieks: konta ID metadatos vai — ja anonīmais konts apvienots ar pastāvīgo (F1) —
    // vecais ID, kas datubāzē piesaistīts jaunajam (account_aliases). Tad metadatus atjauno.
    const ownerOk = async (acct: string, owner: string | null, expected: string) => {
      if (owner === expected) return true;
      if (!owner || !UUID.test(owner)) return false;
      const ok = await db('rpc/account_alias_ok', { method: 'POST', body: JSON.stringify({ old_id: owner, new_id: expected }) }).catch(() => false);
      if (ok === true) { await stripeV2(`core/accounts/${acct}`, { metadata: { cz_user: expected } }).catch(() => null); return true; }
      return false;
    };

    // Maksājuma statusa pieraksts datubāzē (tikai uz priekšu; kļūda nav kritiska — patiesība ir Stripe).
    // F17: izsauc ar servisa atslēgu; lietotāja ID — pārbaudītais uid no pieprasījuma JWT (nevis no pārlūka datiem).
    // Šeit nonāk tikai pēc Stripe pārbaudes: 'paid' — Checkout Session payment_status = 'paid';
    // 'refunded' — pēc veiksmīga Stripe Refund vai ja Stripe rāda atmaksu (charge refunds).
    const mark = (oid: string, status: 'paid' | 'refunded', refundId: string | null = null, reason: string | null = null, cents: number | null = null) =>
      markPay(uid, oid, status, refundId, reason, cents).catch((e: unknown) => console.error('mark', oid, e));

    // ---------- Atmaksa (F14) ----------
    // mode 'driver' — šoferis nospieda „Atmaksāt” (tikai šī brauciena šoferis);
    // mode 'auto'   — brauciens atcelts PIRMS iekāpšanas: atmaksu izraisa atcelšana (jebkurš brauciena dalībnieks),
    //                 bet serveris pats pārbauda, ka brauciens tiešām atcelts un pasažieris nebija iekāpis.
    const refund = async (oid: string, mode: 'driver' | 'auto') => {
      const [o] = await db(`ride_offers?id=eq.${oid}&select=id,status,trip,price_cents,driver_id,request:ride_requests(user_id,status)`);
      if (!o || !o.request) throw new Fail('Brauciens nav atrasts', 404);
      const isDriver = o.driver_id === uid, isPassenger = o.request.user_id === uid;
      const cancelledBefore = (o.status === 'cancelled' || o.request.status === 'cancelled') && ['', 'coming', 'arrived'].includes(o.trip);
      let reason: string;
      if (mode === 'driver') {
        if (!isDriver) throw new Fail('Atmaksāt var tikai šī brauciena šoferis.', 403);
        reason = cancelledBefore ? 'cancelled_before_pickup' : 'driver_refund';
      } else {
        if (!isDriver && !isPassenger) throw new Fail('Brauciens nav atrasts', 404);
        if (!cancelledBefore) throw new Fail('Automātiski atmaksā tikai braucienu, kas atcelts pirms iekāpšanas.', 403);
        reason = 'cancelled_before_pickup';
      }
      const [p] = await db(`ride_payments?offer_id=eq.${oid}&select=session_id,status`);
      if (!p) throw new Fail('Šis brauciens nav samaksāts ar karti.', 409);
      const info = await payInfo(p.session_id, oid);
      if (!info) throw new Fail('Neizdevās sazināties ar Stripe — mēģini vēlreiz.', 502);
      if (!info.ok || !info.paid || !info.pi) throw new Fail('Šis brauciens nav samaksāts ar karti.', 409);
      const st = info.rs;
      const result = (x: RefundState, already: boolean, extra: Record<string, unknown> = {}) => ({
        refunded: x.full, pending: !x.full && x.pending > 0, partial: !x.full && x.pending === 0 && x.refunded > 0, already,
        amount: x.full ? x.refunded : (x.pending > 0 ? x.pending : x.refunded), refunded_cents: x.refunded, pending_cents: x.pending,
        reason: x.reason || reason, ...extra });
      if (st.full) {                                          // jau atmaksāts pilnībā (arī, ja to izdarīja Stripe panelī)
        if (p.status !== 'refunded' && st.refundId) await mark(oid, 'refunded', st.refundId, st.reason, st.refunded);
        if (mode === 'driver') throw new Fail('Šis brauciens jau ir atmaksāts.', 409);
        return result(st, true);
      }
      if (st.pending > 0) return result(st, true);            // atmaksa jau tiek apstrādāta — otru neveido
      // Nav atmaksāts vai atmaksāts daļēji → atmaksā ATLIKUMU (Stripe bez summas atmaksā visu, kas vēl nav atmaksāts)
      let r;
      try {
        r = await stripe('refunds', {
          payment_intent: info.pi, reverse_transfer: 'true', refund_application_fee: 'true', reason: 'requested_by_customer',
          metadata: { offer_id: oid, cz_reason: reason, cz_by: uid },
        }, refundKey(oid, st));
      } catch (e) {
        console.error('refund', oid, e);
        // Varbūt otrs dalībnieks tieši tagad atmaksāja (tā pati atslēga ar citiem datiem) — pārbauda vēlreiz
        const again = await payInfo(p.session_id, oid);
        if (again && (again.rs.full || again.rs.pending > 0)) {
          if (again.rs.full && again.rs.refundId) await mark(oid, 'refunded', again.rs.refundId, again.rs.reason, again.rs.refunded);
          return result(again.rs, true);
        }
        throw new Fail('Atmaksa neizdevās — Stripe to noraidīja. Mēģini vēlāk vai sazinies ar lietotnes īpašnieku.', 502);
      }
      if (r.status === 'failed' || r.status === 'canceled') {
        throw new Fail('Atmaksa neizdevās — Stripe to noraidīja. Mēģini vēlāk vai sazinies ar lietotnes īpašnieku.', 502);
      }
      // Jaunais stāvoklis = iepriekšējās atmaksas + šī (tā pati funkcija, kas visur citur)
      const prev: RfRefund[] = [];
      if (st.refunded > 0) prev.push({ id: st.refundId ?? undefined, amount: st.refunded, status: 'succeeded', created: 0 });
      const st2 = refundState(st.amount, [...prev, { id: r.id, amount: r.amount, status: r.status, created: r.created ?? 1, metadata: { cz_reason: reason } }]);
      if (st2.full) await mark(oid, 'refunded', r.id, reason, st2.refunded);   // „refunded” — tikai, kad visa nauda atdota
      return result(st2, false, { status: r.status });
    };

    const body = await req.json().catch(() => ({}));
    const ret = String(body.return_url ?? '');
    const retOk = APP_URLS.some((a) => ret.startsWith(a));

    switch (body.action) {
      case 'config':
        return json({ test, fee_pct: FEE_PCT });

      // Šoferis: izveido / turpina Stripe konta pieslēgšanu
      case 'connect': {
        if (!retOk) throw new Fail('Nederīga atgriešanās adrese');
        let [row] = await db(`driver_accounts?user_id=eq.${uid}&select=acct`);
        if (row) {
          const a = await driverAccount(row.acct);
          if (!a || !(await ownerOk(row.acct, a.owner, uid))) {
            await db(`driver_accounts?user_id=eq.${uid}`, { method: 'DELETE' });
            row = null;
          }
        }
        if (!row) {
          const email = String(body.email ?? '').trim().toLowerCase();
          if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/.test(email)) throw new Fail('Ieraksti savu e-pastu — uz to Stripe sūtīs paziņojumus par izmaksām.');
          const [prof] = await db(`profiles?id=eq.${uid}&select=name`);
          const a = await stripeV2('core/accounts', {
            contact_email: email, display_name: (prof?.name || 'Šoferis').slice(0, 40),
            dashboard: 'express',
            identity: { country: 'lv', entity_type: 'individual' },
            defaults: { currency: 'eur', responsibilities: { fees_collector: 'application', losses_collector: 'application' } },
            configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
            metadata: { cz_user: uid },
          });
          await db('driver_accounts', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ user_id: uid, acct: a.id }) });
          row = { acct: a.id };
        }
        const link = await stripeV2('core/account_links', {
          account: row.acct,
          use_case: { type: 'account_onboarding', account_onboarding: {
            refresh_url: withQ(ret, 'pay=connect-retry'), return_url: withQ(ret, 'pay=connected'),
          } },
        });
        return json({ url: link.url });
      }

      // Pēc kontu apvienošanas: Stripe kontā ieraksta jauno lietotāja ID
      case 'adopt': {
        const [row] = await db(`driver_accounts?user_id=eq.${uid}&select=acct`);
        if (!row) return json({ ok: true, none: true });
        const a = await driverAccount(row.acct);
        return json({ ok: !!a && await ownerOk(row.acct, a.owner, uid) });
      }

      // Konta dzēšana: slēdz šofera Stripe kontu (dati datubāzē tiek dzēsti pēc tam — delete_my_account)
      case 'close': {
        const [row] = await db(`driver_accounts?user_id=eq.${uid}&select=acct`);
        if (!row) return json({ closed: false, none: true });
        const a = await driverAccount(row.acct);
        if (a && !(await ownerOk(row.acct, a.owner, uid))) throw new Fail('Konts nepieder šim lietotājam', 403);
        try {
          await stripeV2(`core/accounts/${row.acct}/close`, {});
          return json({ closed: true });
        } catch {
          return json({ closed: false });           // lietotne to pieraksta īpašniekam (account_closures)
        }
      }

      case 'driver_status': {
        const [row] = await db(`driver_accounts?user_id=eq.${uid}&select=acct`);
        if (!row) return json({ connected: false, test, fee_pct: FEE_PCT });
        const a = await driverAccount(row.acct);
        if (!a) return json({ connected: false, test, fee_pct: FEE_PCT });
        return json({ connected: true, ready: a.ready, test, fee_pct: FEE_PCT });
      }

      // Pasažieris: maksājuma lapa saskaņotam braucienam
      case 'checkout': {
        if (!retOk) throw new Fail('Nederīga atgriešanās adrese');
        const oid = String(body.offer_id ?? '');
        if (!UUID.test(oid)) throw new Fail('Nederīgs brauciens');
        const [o] = await db(`ride_offers?id=eq.${oid}&select=id,status,price_cents,driver_id,request:ride_requests(user_id,from_name,to_name)`);
        if (!o || !o.request || o.request.user_id !== uid) throw new Fail('Brauciens nav atrasts', 404);
        if (o.status !== 'accepted') throw new Fail('Maksāt var tikai par saskaņotu braucienu');
        if (!(o.price_cents >= 100)) throw new Fail('Šim braucienam nav norādīta cena');

        // Šofera konta pārbaude — tikai, ja vajadzēs jaunu sesiju (atvērtu sesiju atdod bez tās, kā līdz šim)
        let acct: string | null = null;
        const needAcct = async () => {
          if (acct) return acct;
          const id = await db('rpc/ride_driver_acct', { method: 'POST', body: JSON.stringify({ oid }) });
          if (!id) throw new Fail('Šoferis vēl nav pieslēdzis kartes maksājumus — vari samaksāt skaidrā naudā.', 409);
          const a = await driverAccount(id);
          if (!a || !a.ready || !(await ownerOk(id, a.owner, o.driver_id))) {
            throw new Fail('Šoferis vēl nav pabeidzis kartes maksājumu pieslēgšanu — vari samaksāt skaidrā naudā.', 409);
          }
          return (acct = id);
        };
        const fee = Math.round(o.price_cents * FEE_PCT / 100);
        // A04: parametri ir vienādi visiem vienlaicīgajiem pieprasījumiem (citādi Stripe idempotences atslēga tos atraida)
        const params = (destination: string) => ({
          mode: 'payment', locale: 'auto', client_reference_id: oid,
          line_items: { 0: { quantity: 1, price_data: { currency: 'eur', unit_amount: o.price_cents,
            product_data: { name: `Kopbrauciens: ${short(o.request.from_name)} → ${short(o.request.to_name)}` } } } },
          payment_intent_data: { application_fee_amount: fee, transfer_data: { destination }, metadata: { offer_id: oid } },
          metadata: { offer_id: oid },
          success_url: withQ(ret, 'pay=ok'), cancel_url: withQ(ret, 'pay=cancel'),
        });
        try {
          const r = await checkoutFlow({
            begin: () => db('rpc/ride_checkout_begin', { method: 'POST', body: JSON.stringify({ oid }) }),
            retrieve: (id: string) => stripe('checkout/sessions/' + id).catch(() => null),
            create: async (_p: unknown, key: string) => stripe('checkout/sessions', params(await needAcct()), key),
            expire: (id: string) => stripe('checkout/sessions/' + id + '/expire', {}).catch((e: unknown) => console.error('expire', id, e)),
            save: async (id: string, attempt: number) =>
              (await db('rpc/ride_checkout_save', { method: 'POST', body: JSON.stringify({ oid, p_session: id, p_attempt: attempt }) })) === true,
            sleep: (ms: number) => new Promise((res) => setTimeout(res, ms)),
          }, { oid, price_cents: o.price_cents }, null);
          return json({ url: r.url });
        } catch (e) {
          if (e instanceof CheckoutError) throw new Fail(e.message, e.status);
          throw e;
        }
      }

      // Abiem: vai braucieni samaksāti (patiesība — no Stripe)
      case 'status': {
        const ids = (Array.isArray(body.offer_ids) ? body.offer_ids : []).map(String).filter((x: string) => UUID.test(x)).slice(0, 20);
        const out: Record<string, { paid: boolean; amount: number | null; refunded: boolean; refund_cents: number;
          refund_pending_cents: number; refund_state: string }> = {};
        if (ids.length) {
          const rows = await db(`ride_payments?offer_id=in.(${ids.join(',')})&select=offer_id,session_id,status`);
          for (const r of rows ?? []) {
            const i = await payInfo(r.session_id, r.offer_id);
            if (!i) continue;
            // A05: refunded — tikai pilna atmaksa; daļēja un gaidoša — atsevišķi
            out[r.offer_id] = { paid: i.paid, amount: i.amount, refunded: i.rs.full, refund_cents: i.rs.refunded,
              refund_pending_cents: i.rs.pending, refund_state: i.rs.state };
            // Pieraksts datubāzē — arī, ja atmaksāts manuāli Stripe panelī
            if (i.paid && r.status === 'created') await mark(r.offer_id, 'paid');
            if (i.rs.full && r.status !== 'refunded' && i.rs.refundId) await mark(r.offer_id, 'refunded', i.rs.refundId, i.rs.reason, i.rs.refunded);
          }
        }
        // F11: vai šoferis var pieņemt karti — tikai PASAŽIERA vēl nesamaksātiem braucieniem. Tikai true/false
        // (šofera konta ID netiek atdots). Ja Stripe neatbild — lauku neliek (nav zināms), nevis false.
        const drv: Record<string, boolean> = {};
        const todo = ids.filter((x: string) => !(out[x] && out[x].paid));
        if (todo.length) {
          const offers = await db(`ride_offers?id=in.(${todo.join(',')})&select=id,driver_id,status,request:ride_requests(user_id)`).catch(() => []);
          for (const o of offers ?? []) {
            if (!o.request || o.request.user_id !== uid || o.status !== 'accepted') continue;   // šoferim / svešam — nerēķina
            const acct = await db('rpc/ride_driver_acct', { method: 'POST', body: JSON.stringify({ oid: o.id }) }).catch(() => undefined);
            if (acct === undefined) continue;
            if (!acct) { drv[o.id] = false; continue; }                                         // nav pieslēdzis
            const a = await driverAccount(acct);
            if (!a) continue;                                                                    // Stripe neatbild
            drv[o.id] = a.ready && await ownerOk(acct, a.owner, o.driver_id);
          }
        }
        return json({ pay: out, drv, test, fee_pct: FEE_PCT });
      }

      // Šoferis: „Atmaksāt” (body.auto = true — atcelšana pirms iekāpšanas, to var izraisīt arī pasažieris)
      case 'refund': {
        const oid = String(body.offer_id ?? '');
        if (!UUID.test(oid)) throw new Fail('Nederīgs brauciens');
        return json(await refund(oid, body.auto === true ? 'auto' : 'driver'));
      }

      // F16: lietotnes komisijas no Stripe — TIKAI īpašniekam (app_admins, supabase/stats-f16.sql). Pārbaude pirms Stripe izsaukuma.
      case 'admin_stats': {
        const isAdmin = await db('rpc/is_app_admin', { method: 'POST', body: '{}' }).catch(() => false);
        if (isAdmin !== true) throw new Fail('Nav piekļuves', 403);
        const d0 = rigaStart('day'), m0 = rigaStart('month');
        let today = 0, month = 0, total = 0, n = 0, after = '', more = true, pages = 0;
        while (more && pages < 20) {                                   // līdz 2000 komisijām; vairāk — total_partial
          const j = await stripe('application_fees?limit=100' + (after ? '&starting_after=' + after : ''));
          for (const f of j.data ?? []) {
            const net = (Number(f.amount) || 0) - (Number(f.amount_refunded) || 0);
            total += net; n++;
            if (f.created >= m0) month += net;
            if (f.created >= d0) today += net;
          }
          more = !!j.has_more && (j.data ?? []).length > 0;
          after = more ? j.data[j.data.length - 1].id : '';
          pages++;
        }
        return json({ fees: { today, month, total }, count: n, total_partial: more, fee_pct: FEE_PCT, test });
      }

      // F19: „Sinhronizēt ar Stripe” — TIKAI īpašniekam (is_app_admin pēc pieslēgtā konta, servera pusē). Visus maksājumus, kas
      // nav galīgi (created; paid — vai nav atmaksāts), pārbauda Stripe un pieraksta tāpat kā webhook. Pa daļām (offset).
      case 'sync': {
        const isAdmin = await db('rpc/is_app_admin', { method: 'POST', body: '{}' }).catch(() => false);
        if (isAdmin !== true) throw new Fail('Nav piekļuves', 403);
        if (!SRK) throw new Fail('Serverim nav servisa atslēgas', 500);
        const offset = Math.max(0, Math.min(100000, Number(body.offset) || 0));
        const rows = await sdb(`ride_payments?status=in.(created,paid)&select=offer_id,session_id,status,offer:ride_offers(request:ride_requests(user_id))` +
          `&order=created_at.asc,offer_id.asc&limit=${SYNC_MAX}&offset=${offset}`);
        let checked = 0, updated = 0, failed = 0;
        for (const r of rows ?? []) {
          const passenger = r.offer?.request?.user_id;
          const i = await payInfo(r.session_id, r.offer_id);
          if (!i || !passenger) { failed++; continue; }
          checked++;
          try {
            if (i.rs.full) {                                       // A05: tikai pilna atmaksa; daļēja / gaidoša paliek „paid”
              if (i.rs.refundId && await markPay(passenger, r.offer_id, 'refunded', i.rs.refundId, i.rs.reason, i.rs.refunded)) updated++;
            } else if (i.paid && r.status === 'created') {
              if (await markPay(passenger, r.offer_id, 'paid')) updated++;
            }
          } catch (e) { failed++; console.error('sync', r.offer_id, e); }
        }
        return json({ checked, updated, failed, more: (rows ?? []).length === SYNC_MAX, next: offset + SYNC_MAX });
      }

      // Atverot „Kopā”: automātiski atmaksā visus maniem braucieniem, kas atcelti pirms iekāpšanas, bet vēl nav atmaksāti
      // (piem. ja atcelšanas brīdī nebija interneta vai brauciens atcelts automātiski), un atgriež nesenās atmaksas.
      case 'refund_sync': {
        const cand: string[] = ((await db('rpc/ride_refund_candidates', { method: 'POST', body: '{}' })) ?? []).map(String).filter((x: string) => UUID.test(x));
        const done: unknown[] = [];
        for (const oid of cand) {
          try { const r = await refund(oid, 'auto'); if (r && !r.already && (r.refunded || r.pending)) done.push({ offer_id: oid, ...r }); }
          catch (e) { if (!(e instanceof Fail) || e.status >= 500) console.error('refund_sync', oid, e); }   // nav samaksāts u.tml. — izlaiž
        }
        // Datubāzes ierakstam par atmaksu neuzticas — katru vēlreiz pārbauda Stripe
        const rec: { offer_id: string; refund_cents: number }[] = ((await db('rpc/ride_refunds_recent', { method: 'POST', body: '{}' })) ?? [])
          .filter((x: { offer_id: string }) => UUID.test(String(x.offer_id)));
        const recent: unknown[] = [];
        if (rec.length) {
          const rows = await db(`ride_payments?offer_id=in.(${rec.map((x) => x.offer_id).join(',')})&select=offer_id,session_id`);
          const sid = new Map((rows ?? []).map((r: { offer_id: string; session_id: string }) => [r.offer_id, r.session_id]));
          for (const x of rec) {
            const s = sid.get(x.offer_id);
            const i = s ? await payInfo(s as string, x.offer_id) : null;
            if (i && i.rs.full) recent.push({ ...x, refund_cents: i.rs.refunded });
          }
        }
        return json({ done, recent });
      }
    }
    throw new Fail('Nezināma darbība');
  } catch (e) {
    const err = e instanceof Fail ? e : new Fail('Servera kļūda', 500);
    if (!(e instanceof Fail)) console.error(e);
    return json({ error: err.message }, err.status);
  }
});
