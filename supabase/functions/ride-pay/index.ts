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
// Datubāzei funkcija piekļūst AR LIETOTĀJA PAŠA pieteikšanos (RLS noteikumi supabase/rides-3-pay.sql),
// nevis ar servisa atslēgu. Vai brauciens samaksāts, funkcija vienmēr jautā Stripe.

const SK = (Deno.env.get('STRIPE_SECRET_KEY') ?? '').trim();
const LIVE_OK = Deno.env.get('PAY_LIVE') === 'yes';
const SB = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
const FEE_PCT = Math.min(30, Math.max(0, Number(Deno.env.get('PAY_FEE_PERCENT') ?? '10') || 0));
const APP_URLS = ['https://ricardsl7.github.io/cela-zimes/', 'http://localhost:', 'http://127.0.0.1:'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'content-type': 'application/json' } });

class Fail extends Error {
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
    throw new Fail('Stripe: ' + (j?.error?.message || r.status), 502);
  }
  return j;
}

function withQ(url: string, q: string) {
  const u = new URL(url);
  for (const k of ['pay', 'r']) u.searchParams.delete(k);
  for (const [k, v] of new URLSearchParams(q)) u.searchParams.set(k, v);
  return u.toString();
}
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

// Maksājuma stāvoklis no Stripe: Checkout sesija → PaymentIntent → maksājums (charge) → atmaksas
type PayInfo = { ok: boolean; paid: boolean; amount: number | null; pi: string | null;
  refundedCents: number; refundId: string | null; refundReason: string | null };
async function payInfo(sessionId: string, oid: string): Promise<PayInfo | null> {
  const s = await stripe('checkout/sessions/' + sessionId + '?expand[]=payment_intent.latest_charge.refunds').catch(() => null);
  if (!s) return null;
  const ok = s.metadata?.offer_id === oid;
  const pi = s.payment_intent && typeof s.payment_intent === 'object' ? s.payment_intent : null;
  const ch = pi && pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  // deno-lint-ignore no-explicit-any
  const refunds: any[] = ch?.refunds?.data ?? [];
  const okRefunds = refunds.filter((r) => r.status === 'succeeded' || r.status === 'pending');
  return {
    ok, paid: ok && s.payment_status === 'paid', amount: ok ? s.amount_total : null,
    pi: pi ? pi.id : (typeof s.payment_intent === 'string' ? s.payment_intent : null),
    refundedCents: ok ? Number(ch?.amount_refunded ?? 0) || okRefunds.reduce((a, r) => a + (r.amount || 0), 0) : 0,
    refundId: okRefunds[0]?.id ?? null,
    refundReason: okRefunds[0]?.metadata?.cz_reason ?? null,
  };
}
const REASONS = ['cancelled_before_pickup', 'driver_refund', 'stripe_dashboard'];

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

    // Maksājuma statusa pieraksts datubāzē (tikai uz priekšu; kļūda nav kritiska — patiesība ir Stripe)
    const mark = (oid: string, status: 'paid' | 'refunded', refundId: string | null = null, reason: string | null = null, cents: number | null = null) =>
      db('rpc/ride_payment_mark', { method: 'POST', body: JSON.stringify({ oid, p_status: status, p_refund_id: refundId,
        p_reason: reason && REASONS.includes(reason) ? reason : (status === 'refunded' ? 'stripe_dashboard' : null), p_cents: cents }) })
        .catch((e: unknown) => console.error('mark', oid, e));

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
      if (info.refundedCents > 0) {                          // jau atmaksāts (arī, ja to izdarīja Stripe panelī)
        if (p.status !== 'refunded' && info.refundId) await mark(oid, 'refunded', info.refundId, info.refundReason, info.refundedCents);
        if (mode === 'driver') throw new Fail('Šis brauciens jau ir atmaksāts.', 409);
        return { refunded: true, already: true, amount: info.refundedCents, reason: info.refundReason || reason };
      }
      let r;
      try {
        r = await stripe('refunds', {
          payment_intent: info.pi, reverse_transfer: 'true', refund_application_fee: 'true', reason: 'requested_by_customer',
          metadata: { offer_id: oid, cz_reason: reason, cz_by: uid },
        }, 'refund-' + oid);
      } catch (e) {
        console.error('refund', oid, e);
        throw new Fail('Atmaksa neizdevās — Stripe to noraidīja. Mēģini vēlāk vai sazinies ar lietotnes īpašnieku.', 502);
      }
      if (r.status === 'failed' || r.status === 'canceled') {
        throw new Fail('Atmaksa neizdevās — Stripe to noraidīja. Mēģini vēlāk vai sazinies ar lietotnes īpašnieku.', 502);
      }
      await mark(oid, 'refunded', r.id, reason, r.amount);
      return { refunded: true, already: false, amount: r.amount, reason, status: r.status };
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

        const [p] = await db(`ride_payments?offer_id=eq.${oid}&select=session_id`);
        if (p) {
          const s = await stripe('checkout/sessions/' + p.session_id).catch(() => null);
          if (s && s.metadata?.offer_id === oid && s.payment_status === 'paid') throw new Fail('Šis brauciens jau ir samaksāts', 409);
          if (s && s.metadata?.offer_id === oid && s.status === 'open' && s.amount_total === o.price_cents) return json({ url: s.url });
        }
        const acct = await db('rpc/ride_driver_acct', { method: 'POST', body: JSON.stringify({ oid }) });
        if (!acct) throw new Fail('Šoferis vēl nav pieslēdzis kartes maksājumus — vari samaksāt skaidrā naudā.', 409);
        const a = await driverAccount(acct);
        if (!a || !a.ready || !(await ownerOk(acct, a.owner, o.driver_id))) {
          throw new Fail('Šoferis vēl nav pabeidzis kartes maksājumu pieslēgšanu — vari samaksāt skaidrā naudā.', 409);
        }
        const fee = Math.round(o.price_cents * FEE_PCT / 100);
        const s = await stripe('checkout/sessions', {
          mode: 'payment', locale: 'auto', client_reference_id: oid,
          line_items: { 0: { quantity: 1, price_data: { currency: 'eur', unit_amount: o.price_cents,
            product_data: { name: `Kopbrauciens: ${short(o.request.from_name)} → ${short(o.request.to_name)}` } } } },
          payment_intent_data: { application_fee_amount: fee, transfer_data: { destination: acct }, metadata: { offer_id: oid } },
          metadata: { offer_id: oid },
          success_url: withQ(ret, 'pay=ok'), cancel_url: withQ(ret, 'pay=cancel'),
        });
        await db('ride_payments', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ offer_id: oid, session_id: s.id }) });
        return json({ url: s.url });
      }

      // Abiem: vai braucieni samaksāti (patiesība — no Stripe)
      case 'status': {
        const ids = (Array.isArray(body.offer_ids) ? body.offer_ids : []).map(String).filter((x: string) => UUID.test(x)).slice(0, 20);
        const out: Record<string, { paid: boolean; amount: number | null; refunded: boolean; refund_cents: number }> = {};
        if (ids.length) {
          const rows = await db(`ride_payments?offer_id=in.(${ids.join(',')})&select=offer_id,session_id,status`);
          for (const r of rows ?? []) {
            const i = await payInfo(r.session_id, r.offer_id);
            if (!i) continue;
            out[r.offer_id] = { paid: i.paid, amount: i.amount, refunded: i.refundedCents > 0, refund_cents: i.refundedCents };
            // Pieraksts datubāzē — arī, ja atmaksāts manuāli Stripe panelī
            if (i.paid && r.status === 'created') await mark(r.offer_id, 'paid');
            if (i.refundedCents > 0 && r.status !== 'refunded' && i.refundId) await mark(r.offer_id, 'refunded', i.refundId, i.refundReason, i.refundedCents);
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

      // Atverot „Kopā”: automātiski atmaksā visus maniem braucieniem, kas atcelti pirms iekāpšanas, bet vēl nav atmaksāti
      // (piem. ja atcelšanas brīdī nebija interneta vai brauciens atcelts automātiski), un atgriež nesenās atmaksas.
      case 'refund_sync': {
        const cand: string[] = ((await db('rpc/ride_refund_candidates', { method: 'POST', body: '{}' })) ?? []).map(String).filter((x: string) => UUID.test(x));
        const done: unknown[] = [];
        for (const oid of cand) {
          try { const r = await refund(oid, 'auto'); if (r && !r.already) done.push({ offer_id: oid, ...r }); }
          catch (e) { if (!(e instanceof Fail) || e.status >= 500) console.error('refund_sync', oid, e); }   // nav samaksāts u.tml. — izlaiž
        }
        // Datubāzes ierakstam par atmaksu neuzticas (to var pierakstīt brauciena dalībnieks) — katru pārbauda Stripe
        const rec: { offer_id: string; refund_cents: number }[] = ((await db('rpc/ride_refunds_recent', { method: 'POST', body: '{}' })) ?? [])
          .filter((x: { offer_id: string }) => UUID.test(String(x.offer_id)));
        const recent: unknown[] = [];
        if (rec.length) {
          const rows = await db(`ride_payments?offer_id=in.(${rec.map((x) => x.offer_id).join(',')})&select=offer_id,session_id`);
          const sid = new Map((rows ?? []).map((r: { offer_id: string; session_id: string }) => [r.offer_id, r.session_id]));
          for (const x of rec) {
            const s = sid.get(x.offer_id);
            const i = s ? await payInfo(s as string, x.offer_id) : null;
            if (i && i.refundedCents > 0) recent.push({ ...x, refund_cents: i.refundedCents });
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
