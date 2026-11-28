-- Ceļa Zīmes — pēdējo 20 brauciena maksājumu stāvoklis (audits 2, B18). TIKAI LASA — neko nemaina.
-- KĀ LIETOT: Supabase → SQL Editor → New query → ielīmē → Run. Bez vārdiem, tālruņiem un adresēm (tikai ID un statusi).
-- Kolonnas: brauciena ID, cena, maksājums (created / paid / refunded), cik maksājuma lapas atvērtas, atmaksa (summa, iemesls),
-- brauciena stāvoklis un webhook notikumi pēc kārtas (tips → rezultāts).
select p.offer_id,
       o.price_cents as cena_c,
       p.status as maksajums,
       p.attempt as lapas,
       p.created_at,
       p.refund_cents as atmaksa_c,
       p.refund_reason as atmaksas_iemesls,
       o.status || ' / ' || coalesce(nullif(o.trip, ''), '—') || ' / ' || coalesce(r.status, 'pasažieris dzēsts') as brauciens,
       (select string_agg(e.type || ' → ' || coalesce(e.result, ''), '; ' order by e.created_at)
          from public.stripe_events e where e.offer_id = p.offer_id) as webhook
from public.ride_payments p
join public.ride_offers o on o.id = p.offer_id
left join public.ride_requests r on r.id = o.request_id
order by p.created_at desc
limit 20;
