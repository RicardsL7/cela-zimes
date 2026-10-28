// Ceļa Zīmes — Stripe webhook (Supabase Edge Function "stripe-webhook"), F19 (v115).
//
// Stripe pats paziņo par samaksu un atmaksu — maksājuma statuss datubāzē (ride_payments.status) atjaunojas uzreiz,
// arī ja neviens dalībnieks lietotni vairs neatver. Lietotnes pašas pārbaude (ride-pay 'status') paliek kā rezerve.
//
// IZVIETOŠANA: supabase functions deploy stripe-webhook --no-verify-jwt
//   (Stripe nesūta Supabase JWT; drošību nodrošina Stripe paraksts). ride-pay JWT pārbaude paliek ieslēgta.
// IESTATĪJUMI (Supabase → Edge Functions → Secrets):
//   STRIPE_WEBHOOK_SECRET — Stripe paneļa webhook „Signing secret” (whsec_…). Testa un īstajam režīmam — atšķirīgi.
//   STRIPE_SECRET_KEY     — tas pats, ko lieto ride-pay (maksājuma stāvokli vienmēr vēlreiz pārbauda Stripe).
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — Supabase ieliek pats. Servisa atslēga nekad nenonāk atbildē.
//
// Maksājumi ir „destination charges” (ride-pay: payment_intent_data.transfer_data.destination) — maksājums un atmaksa
// notiek PLATFORMAS kontā, tāpēc pietiek ar parasto webhook (nevajag „Connected accounts” notikumus).
//
// Notikumi: checkout.session.completed (ja payment_status = paid), checkout.session.async_payment_succeeded → „paid”;
// charge.refunded (pilna atmaksa) → „refunded”; daļēja atmaksa — tikai žurnālā; async_payment_failed / expired — lietotnē
// tāda statusa nav, tikai žurnālā. Pārējie — 200 un ignorē.
// Statusu raksta ride_payment_mark (tikai service_role, tikai uz priekšu — „refunded” nekad nekļūst atpakaļ par „paid”).
// Pirms rakstīšanas maksājuma stāvokli vēlreiz nolasa no Stripe (notikumu secība un atkārtojumi nav svarīgi).
// Atkārtots notikums (tas pats event.id, tabula stripe_events) — neko nedara.

import Stripe from 'npm:stripe@17.7.0';

const SK = (Deno.env.get('STRIPE_SECRET_KEY') ?? '').trim();
const WHSEC = (Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '').trim();
const SB = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
const SRK = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASONS = ['cancelled_before_pickup', 'driver_refund', 'stripe_dashboard'];

const stripeLib = new Stripe(SK || 'sk_test_unset', { httpClient: Stripe.createFetchHttpClient() });
const cryptoProvider = Stripe.createSubtleCryptoProvider();

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

// deno-lint-ignore no-explicit-any
async function stripe(path: string): Promise<any> {
  const r = await fetch('https://api.stripe.com/v1/' + path, { headers: { Authorization: 'Bearer ' + SK } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Stripe ' + path.split('?')[0] + ' ' + r.status + ' ' + (j?.error?.message ?? ''));
  return j;
}
// Datubāze ar servisa atslēgu (tikai servera pusē)
// deno-lint-ignore no-explicit-any
async function sdb(path: string, init: RequestInit = {}): Promise<any> {
  const h: Record<string, string> = { apikey: SRK, 'content-type': 'application/json', ...((init.headers as Record<string, string>) ?? {}) };
  if (SRK.startsWith('eyJ')) h.Authorization = 'Bearer ' + SRK;      // vecā tipa (JWT) atslēga; jaunā sb_secret_ — tikai apikey
  const r = await fetch(SB + '/rest/v1/' + path, { ...init, headers: h });
  const t = await r.text();
  if (!r.ok) throw new Error('DB ' + path.split('?')[0] + ' ' + r.status + ' ' + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}

// Maksājuma stāvoklis no Stripe (tā pati loģika kā ride-pay payInfo)
type PayInfo = { ok: boolean; paid: boolean; amount: number | null; refundedCents: number; refundId: string | null; refundReason: string | null };
async function payInfo(sessionId: string, oid: string): Promise<PayInfo> {
  const s = await stripe('checkout/sessions/' + sessionId + '?expand[]=payment_intent.latest_charge.refunds');
  const ok = s.metadata?.offer_id === oid;
  const pi = s.payment_intent && typeof s.payment_intent === 'object' ? s.payment_intent : null;
  const ch = pi && pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  // deno-lint-ignore no-explicit-any
  const refunds: any[] = ch?.refunds?.data ?? [];
  const okRefunds = refunds.filter((r) => r.status === 'succeeded' || r.status === 'pending');
  return {
    ok, paid: ok && s.payment_status === 'paid', amount: ok ? s.amount_total : null,
    refundedCents: ok ? Number(ch?.amount_refunded ?? 0) || okRefunds.reduce((a, r) => a + (r.amount || 0), 0) : 0,
    refundId: okRefunds[0]?.id ?? null, refundReason: okRefunds[0]?.metadata?.cz_reason ?? null,
  };
}

// Brauciena maksājumu salīdzina ar Stripe un pieraksta (tikai uz priekšu). sessionHint — sesija no notikuma
// (ja pasažieris bija atvēris vairākas maksājuma lapas, samaksātā var atšķirties no pēdējās datubāzē).
async function syncOffer(oid: string, sessionHint: string | null = null): Promise<string> {
  const [row] = await sdb(`ride_payments?offer_id=eq.${oid}&select=session_id,status,offer:ride_offers(request:ride_requests(user_id))`);
  if (!row) return 'no_row';
  const passenger: string | undefined = row.offer?.request?.user_id;
  if (!passenger) return 'no_offer';
  let info = await payInfo(row.session_id, oid);
  if (!info.paid && sessionHint && sessionHint !== row.session_id) {
    const alt = await payInfo(sessionHint, oid);
    if (alt.paid) info = alt;
  }
  if (!info.ok) return 'mismatch';
  const mark = (status: 'paid' | 'refunded', refundId: string | null = null, reason: string | null = null, cents: number | null = null) =>
    sdb('rpc/ride_payment_mark', { method: 'POST', body: JSON.stringify({ p_user_id: passenger, oid, p_status: status, p_refund_id: refundId,
      p_reason: reason && REASONS.includes(reason) ? reason : (status === 'refunded' ? 'stripe_dashboard' : null), p_cents: cents }) });
  if (info.refundedCents > 0) {
    if (info.amount != null && info.refundedCents < info.amount) { console.log('daļēja atmaksa — netiek atzīmēta', oid, info.refundedCents, info.amount); return 'partial'; }
    if (row.status === 'refunded') return 'same';
    if (!info.refundId) return 'no_refund_id';
    return (await mark('refunded', info.refundId, info.refundReason, info.refundedCents)) ? 'refunded' : 'same';
  }
  if (info.paid && row.status === 'created') return (await mark('paid')) ? 'paid' : 'same';
  return 'same';
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Tikai POST' }, 405);
  if (!WHSEC || !SK || !SRK || !SB) {
    console.error('stripe-webhook: trūkst iestatījumu', { whsec: !!WHSEC, sk: !!SK, srk: !!SRK, sb: !!SB });   // tikai vai ir, nekad vērtības
    return json({ error: 'Nav iestatīts' }, 500);                       // Stripe atkārtos vēlāk
  }
  const body = await req.text();                                       // neapstrādāts teksts — parakstam
  const sig = req.headers.get('stripe-signature') ?? '';
  let event: Stripe.Event;
  try {
    event = await stripeLib.webhooks.constructEventAsync(body, sig, WHSEC, undefined, cryptoProvider);
  } catch {
    return json({ error: 'Nederīgs paraksts' }, 400);                   // neko neraksta
  }

  try {
    const seen = await sdb(`stripe_events?id=eq.${encodeURIComponent(event.id)}&select=id`);
    if (seen?.length) return json({ received: true, duplicate: true });

    let oid: string | null = null, result = 'ignored';
    // deno-lint-ignore no-explicit-any
    const obj: any = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        oid = String(obj.metadata?.offer_id ?? obj.client_reference_id ?? '');
        if (!UUID.test(oid)) { oid = null; result = 'not_ride'; break; }
        result = obj.payment_status === 'paid' ? await syncOffer(oid, obj.id) : 'unpaid';
        break;
      }
      case 'checkout.session.async_payment_failed':
      case 'checkout.session.expired': {
        oid = UUID.test(String(obj.metadata?.offer_id ?? '')) ? String(obj.metadata.offer_id) : null;
        result = 'logged';                                             // lietotnē „neizdevies / beidzies” statusa nav
        console.log(event.type, oid);
        break;
      }
      case 'charge.refunded': {
        oid = String(obj.metadata?.offer_id ?? '');
        if (!UUID.test(oid) && obj.payment_intent) {
          const pi = await stripe('payment_intents/' + (typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent.id));
          oid = String(pi.metadata?.offer_id ?? '');
        }
        if (!UUID.test(oid)) { oid = null; result = 'not_ride'; break; }
        if (Number(obj.amount_refunded) < Number(obj.amount)) { console.log('daļēja atmaksa — netiek atzīmēta', oid, obj.amount_refunded, obj.amount); result = 'partial'; break; }
        result = await syncOffer(oid);
        break;
      }
    }
    await sdb('stripe_events', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ id: event.id, type: event.type.slice(0, 100), offer_id: oid, result: result.slice(0, 40) }) });
    return json({ received: true, result });
  } catch (e) {
    console.error('stripe-webhook', event.type, event.id, e);
    return json({ error: 'Apstrāde neizdevās' }, 500);                 // nepieraksta — Stripe atkārtos
  }
});
