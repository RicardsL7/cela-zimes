-- Ceļa Zīmes — maksājumu pārbaude (audits 2, B18). TIKAI LASA — neko nemaina.
-- KĀ LIETOT: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run. Pēc katra Stripe testa soļa (PAYMENTS-TEST.md).
-- Rezultāts — viena tabula: pārbaude | skaits | piemērs. Visām „problēma:” rindām jābūt 0.
-- Pēdējo braucienu maksājumi pa vienam — tools/pay-recent.sql.
with
pay as (
  select p.*, o.status as offer_status, o.trip, o.price_cents, r.status as req_status
  from public.ride_payments p
  join public.ride_offers o on o.id = p.offer_id
  left join public.ride_requests r on r.id = o.request_id
),
ev as (select * from public.stripe_events where created_at > now() - interval '90 days'),
checks(ord, kas, skaits, piemers) as (
  select 1, 'maksājumi kopā (created / paid / refunded)', count(*),
         count(*) filter (where status = 'created') || ' / ' || count(*) filter (where status = 'paid') || ' / ' || count(*) filter (where status = 'refunded')
  from pay
  union all
  select 2, 'Stripe notikumi 90 dienās (webhook strādā, ja > 0 pēc testa maksājuma)', count(*),
         coalesce(max(created_at)::text, '—') from ev
  union all
  select 3, 'problēma: webhook pierakstīja samaksu, bet datubāzē vēl „created”', count(*), min(p.offer_id::text)
  from pay p where p.status = 'created'
    and exists (select 1 from ev e where e.offer_id = p.offer_id and e.result = 'paid')
  union all
  select 4, 'problēma: „refunded” bez Stripe atmaksas ID, summas vai laika', count(*), min(offer_id::text)
  from pay where status = 'refunded' and (refund_id is null or refund_cents is null or refunded_at is null)
  union all
  select 5, 'problēma: atmaksāts vairāk nekā brauciena cena', count(*), min(offer_id::text)
  from pay where refund_cents > price_cents
  union all
  select 6, 'gaida atmaksu: atcelts pirms iekāpšanas, bet vēl „paid” (pēc „Kopā” atvēršanas jābūt 0)', count(*), min(offer_id::text)
  from pay where status = 'paid' and (offer_status = 'cancelled' or req_status = 'cancelled') and trip in ('', 'coming', 'arrived')
  union all
  select 8, 'strīdi (chargeback) 90 dienās — atbildēt Stripe panelī līdz termiņam', count(distinct offer_id),
         string_agg(distinct result, ', ')
  from ev where type like 'charge.dispute.%'
  union all
  select 9, 'webhook notikumi, kas nav par braucienu (not_ride / mismatch / no_row)', count(*), string_agg(distinct type, ', ')
  from ev where result in ('not_ride', 'mismatch', 'no_row', 'no_offer', 'no_refund_id')
)
select kas as "pārbaude", skaits, coalesce(piemers, '') as "piemērs" from checks order by ord;
