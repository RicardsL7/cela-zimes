-- Ceļa Zīmes — kopbraucieni, 4. daļa: novecojušu braucienu automātiska atcelšana / pabeigšana.
-- Palaist PĒC rides.sql, rides-2-chat-trip.sql (Supabase → SQL Editor → Run). Var palaist atkārtoti.
--
-- Noteikumi (skaitot no plānotā izbraukšanas laika):
--   1. Pieprasījums, kuru neviens nav pieņēmis 1 h pēc izbraukšanas laika → atcelts.
--   2. Piedāvājums, uz kuru pasažieris nav atbildējis 1 h pēc izbraukšanas laika → noraidīts.
--   3. Saskaņots brauciens, kas nav sācies (šoferis nav paņēmis pasažieri) 2 h pēc izbraukšanas
--      laika un šoferis pēdējo stundu nav kustējies lietotnē → atcelts.
--   4. Brauciens "Ceļā", par kuru šoferis 4 h nav devis ziņu (nav atjaunojis atrašanās vietu) → pabeigts.
-- Lietotne šo funkciju izsauc ik pa laikam; tā ir ātra un droša atkārtotai izsaukšanai.

create or replace function public.ride_expire() returns int
  language plpgsql security definer set search_path = public as
$$
declare n int := 0; k int; ids uuid[]; rids uuid[];
begin
  -- 4. Ceļā pārāk ilgi bez ziņām → pabeigts
  with x as (
    update ride_offers o set trip = 'done'
    from ride_requests r
    where r.id = o.request_id and o.status = 'accepted' and o.trip = 'onboard'
      and greatest(r.depart_at, coalesce(o.drv_at, r.depart_at)) < now() - interval '4 hours'
    returning o.request_id)
  update ride_requests set status = 'done' where id in (select request_id from x) and status <> 'done';
  get diagnostics k = row_count; n := n + k;

  -- 3. Saskaņots, bet nesācies → abi atcelti
  --    (piedāvājuma atcelšana caur trigeri pieprasījumu atver no jauna, tāpēc pēc tam to atceļam)
  select coalesce(array_agg(o.id), '{}'), coalesce(array_agg(o.request_id), '{}') into ids, rids
  from ride_offers o join ride_requests r on r.id = o.request_id
  where o.status = 'accepted' and o.trip in ('', 'coming', 'arrived')
    and r.depart_at < now() - interval '2 hours'
    and coalesce(o.drv_at, r.depart_at) < now() - interval '1 hour';
  update ride_offers set status = 'cancelled' where id = any(ids);
  get diagnostics k = row_count; n := n + k;
  update ride_requests set status = 'cancelled' where id = any(rids) and status in ('open', 'matched');

  -- 1. Neviens nav pieņēmis → pieprasījums atcelts
  update ride_requests set status = 'cancelled'
  where status = 'open' and depart_at < now() - interval '1 hour';
  get diagnostics k = row_count; n := n + k;

  -- 2. Neatbildēti piedāvājumi → noraidīti
  update ride_offers o set status = 'declined'
  from ride_requests r
  where r.id = o.request_id and o.status = 'pending'
    and (r.status <> 'open' or r.depart_at < now() - interval '1 hour');
  get diagnostics k = row_count; n := n + k;

  return n;
end
$$;
revoke all on function public.ride_expire() from public, anon;
grant execute on function public.ride_expire() to authenticated;

-- Uzreiz sakārto jau novecojušos braucienus
select public.ride_expire();
