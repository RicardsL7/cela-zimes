-- Ceļa Zīmes — kopbraucieni, 5. daļa: šoferis var piedāvāt vēlreiz, ja savu piedāvājumu bija atcēlis.
-- Supabase → SQL Editor → Run. Var palaist atkārtoti.
--
-- Agrāk: viens šoferis vienam pieprasījumam — tikai viena rinda (arī atcelta). Pēc "Atcelt" poga
-- "Paņemšu" vairs nestrādāja. Tagad: vienlaikus tikai viens AKTĪVS piedāvājums (nav atcelts);
-- noraidīts piedāvājums joprojām bloķē atkārtotu piedāvājumu (pasažieris jau atteica).

alter table public.ride_offers drop constraint if exists ride_offers_request_id_driver_id_key;
create unique index if not exists ride_offers_one_active
  on public.ride_offers (request_id, driver_id) where status <> 'cancelled';
