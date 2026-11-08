-- Ceļa Zīmes — konta dzēšana neizdzēš otra cilvēka braucienu un maksājumu (audits A15, 08.11.2026).
--
-- KĀ PALAIST: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run. Var palaist atkārtoti (kamēr nav jaunāku).
-- Palaist PĒC cleanup-1.sql (secība — supabase/ORDER.txt, Nr. 28).
--
-- Problēma: dzēšot kontu, datubāze kaskādē izdzēsa arī OTRA brauciena dalībnieka datus — pasažiera braucienu ar visiem
-- šoferu piedāvājumiem, šofera braucienus ar pasažieru maksājumu ierakstiem (ride_payments), čatu un vērtējumus.
-- Pēc tam otrs cilvēks vairs neredzēja savu braucienu, un samaksātam braucienam pazuda saite ar Stripe (atmaksa,
-- Stripe paziņojumi). Kontu varēja dzēst arī brauciena vidū vai, kamēr atmaksa vēl nav pabeigta.
--
-- Labojums (īpašnieka lēmums 08.11.2026 — „anonīms ieraksts”):
--   1) Pārbaudes pirms dzēšanas — account_delete_check(); delete_my_account() bez tām nedzēš:
--        active_ride   — saskaņots brauciens vēl nav beidzies (jāpabeidz vai jāatceļ; aizmirstus ride_expire slēdz pats);
--        payment_open  — maksājuma lapa atvērta pēdējās 24 h (Stripe to vēl var samaksāt);
--        refund_due    — samaksāts brauciens atcelts pirms iekāpšanas, bet atmaksa vēl nav pabeigta.
--   2) Profila dzēšana (jebkurā veidā — arī Supabase panelī) vairs nedzēš otra cilvēka datus (trigeris
--      ride_profile_erase + ārējās atslēgas ON DELETE SET NULL). Dzēstā lietotāja:
--        – braucieni, kurus neviens nebija pieņēmis un nav maksājuma — dzēsti pilnībā;
--        – braucieni ar vēsturi — otram paliek MINIMĀLS ieraksts: datums, cena, cilvēku skaits, maksājuma statuss,
--          maršruts noapaļots līdz ~1 km bez adreses un piezīmes; vārda vietā — „Dzēsts lietotājs” (lietotāja ID = NULL);
--          pēdējās atrašanās vietas — dzēstas;
--        – čata ziņas, tālrunis, profils, Stripe konta piesaiste — dzēsti; viņa doto vērtējumu zvaigznes paliek
--          (bez komentāra un bez autora), lai otram nemainītos vērtējums; vērtējumi par viņu — dzēsti;
--        – ja otrs dalībnieks jau dzēsis kontu — brauciens dzēsts pilnībā (nevienam vairs nevajag).
--      Stripe maksājuma ieraksti paliek Stripe (kā līdz šim); ride_payments rinda ar sesijas numuru paliek pie
--      anonīmā brauciena, lai Stripe paziņojumi un otra dalībnieka „Kopā” to joprojām atrastu.
--   3) Vērtēt dzēstu lietotāju nevar (skaidra kļūda); ziņot par braucienu ar dzēstu lietotāju — var.

do $$ begin
  if to_regprocedure('public.cz_migration_begin(integer, text)') is null then
    raise exception 'Vispirms palaid visus iepriekšējos failus līdz cleanup-1.sql (secība — supabase/ORDER.txt).';
  end if;
end $$;
select public.cz_migration_begin(28, 'account-1-delete.sql');

-- ---------- 1) Ārējās atslēgas: dzēšot profilu, brauciens paliek (dalībnieks = NULL) ----------
alter table public.ride_requests alter column user_id drop not null;
alter table public.ride_offers alter column driver_id drop not null;
alter table public.ride_ratings alter column rater_id drop not null;
-- Visas esošās ārējās atslēgas uz šīm kolonnām (arī, ja produkcijā tām būtu cits nosaukums) → viena ar SET NULL
do $$
declare x record;
begin
  for x in select c.conrelid::regclass as t, c.conname
           from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
           where c.contype = 'f' and array_length(c.conkey, 1) = 1
             and (c.conrelid, a.attname) in (('public.ride_requests'::regclass, 'user_id'), ('public.ride_offers'::regclass, 'driver_id'),
                                             ('public.ride_ratings'::regclass, 'rater_id'))
  loop
    execute format('alter table %s drop constraint %I', x.t, x.conname);
  end loop;
end $$;
alter table public.ride_requests
  add constraint ride_requests_user_id_fkey foreign key (user_id) references public.profiles(id) on delete set null;
alter table public.ride_offers
  add constraint ride_offers_driver_id_fkey foreign key (driver_id) references public.profiles(id) on delete set null;
alter table public.ride_ratings
  add constraint ride_ratings_rater_id_fkey foreign key (rater_id) references public.profiles(id) on delete set null;
-- ride_messages.sender un ride_ratings.rated_id paliek ON DELETE CASCADE: dzēstā čata ziņas un vērtējumi par viņu pazūd.

-- ---------- 2) Pārbaudes pirms dzēšanas ----------
create or replace function public.account_delete_blockers(me uuid) returns jsonb
  language sql stable security definer set search_path = public as
$$
  with mine as (
    select o.id, o.status, o.trip, o.onboard_at, r.status as rstatus, r.depart_at,
           case when o.driver_id = me then 'driver' else 'passenger' end as role
    from ride_offers o join ride_requests r on r.id = o.request_id
    where me is not null and (o.driver_id = me or r.user_id = me)
  ), b as (
    -- Saskaņots brauciens vēl nav beidzies
    select 'active_ride' as kind, m.id, m.role, m.depart_at, null::timestamptz as until
    from mine m where m.status = 'accepted' and m.trip <> 'done' and m.rstatus in ('open', 'matched')
    union all
    -- Maksājuma lapa vēl derīga (Stripe Checkout sesija dzīvo līdz 24 h)
    select 'payment_open', m.id, m.role, m.depart_at, p.created_at + interval '24 hours'
    from mine m join ride_payments p on p.offer_id = m.id
    where p.status = 'created' and p.created_at > now() - interval '24 hours'
    union all
    -- Samaksāts, atcelts pirms iekāpšanas, bet nauda vēl nav atgriezta pilnībā (tas pats nosacījums kā ride_refund_candidates)
    select 'refund_due', m.id, m.role, m.depart_at, null
    from mine m join ride_payments p on p.offer_id = m.id
    where p.status = 'paid' and (m.status = 'cancelled' or m.rstatus = 'cancelled')
      and m.onboard_at is null and m.trip in ('', 'coming', 'arrived')
  )
  select jsonb_build_object('ok', count(*) = 0,
    'blockers', coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'offer_id', id, 'role', role, 'depart_at', depart_at, 'until', until)
                                   order by depart_at), '[]'::jsonb))
  from b
$$;
revoke all on function public.account_delete_blockers(uuid) from public, anon, authenticated;

-- Lietotnei un ride-pay (pirms Stripe konta slēgšanas): vai pieteikušos lietotāju drīkst dzēst
create or replace function public.account_delete_check() returns jsonb
  language plpgsql stable security definer set search_path = public as
$$
begin
  if auth.uid() is null then raise exception 'Nav pieteicies'; end if;
  return account_delete_blockers(auth.uid());
end
$$;
revoke all on function public.account_delete_check() from public, anon;
grant execute on function public.account_delete_check() to authenticated;

-- ---------- 3) Profila dzēšana: otra dalībnieka dati paliek anonīmi ----------
create or replace function public.ride_profile_erase() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare me uuid := old.id;
begin
  -- a) Bez vēstures (neviens nepieņēma, nav maksājuma) — dzēš pilnībā. Šoferu neatbildētie piedāvājumi pazūd kopā ar pieprasījumu.
  delete from ride_requests r where r.user_id = me
    and not exists (select 1 from ride_offers o where o.request_id = r.id
                    and (o.was_accepted or exists (select 1 from ride_payments p where p.offer_id = o.id)));
  delete from ride_offers o where o.driver_id = me and not o.was_accepted
    and not exists (select 1 from ride_payments p where p.offer_id = o.id);

  -- b) Ja otrs dalībnieks jau dzēsis kontu — brauciens nevienam vairs nav vajadzīgs
  delete from ride_offers o using ride_requests r
    where r.id = o.request_id and ((r.user_id = me and o.driver_id is null) or (o.driver_id = me and r.user_id is null));
  delete from ride_requests r where (r.user_id = me or r.user_id is null)
    and not exists (select 1 from ride_offers o where o.request_id = r.id);

  -- c) Atlikušie braucieni ar vēsturi. Parasti tie jau beigušies (account_delete_check); ja kontu dzēš īpašnieks
  --    panelī brauciena laikā — brauciens tiek atcelts (lai nepaliek „aktīvs” brauciens ar dzēstu cilvēku).
  update ride_offers o set status = 'declined'
    from ride_requests r where r.id = o.request_id and r.user_id = me and o.status = 'pending';
  update ride_offers o set status = 'cancelled'
    from ride_requests r where r.id = o.request_id and o.status = 'accepted' and o.trip <> 'done'
      and (r.user_id = me or o.driver_id = me);
  -- (pasažiera pieprasījums pēc šofera atcelšanas atveras no jauna — kā parasti, kad šoferis atceļ: reopen_on_cancel)
  update ride_requests set status = 'cancelled' where user_id = me and status in ('open', 'matched');

  -- d) Minimālais ieraksts otram: bez adreses, piezīmes un precīzām koordinātām; bez pēdējām atrašanās vietām
  update ride_requests set note = '', from_name = '', to_name = '',
      from_lat = round(from_lat::numeric, 2)::double precision, from_lng = round(from_lng::numeric, 2)::double precision,
      to_lat = round(to_lat::numeric, 2)::double precision, to_lng = round(to_lng::numeric, 2)::double precision
    where user_id = me;
  update ride_offers o set note = case when o.driver_id = me then '' else o.note end,
      drv_lat = null, drv_lng = null, drv_heading = null, drv_at = null, pas_lat = null, pas_lng = null, pas_at = null
    from ride_requests r where r.id = o.request_id and (o.driver_id = me or r.user_id = me);

  -- e) Vērtējumi: viņa dotie paliek bez komentāra (autors kļūst NULL — ārējā atslēga), par viņu — dzēsti (kaskāde)
  update ride_ratings set comment = '' where rater_id = me;
  return old;
end
$$;
revoke all on function public.ride_profile_erase() from public, anon, authenticated;
drop trigger if exists profiles_erase_rides on public.profiles;
create trigger profiles_erase_rides before delete on public.profiles
  for each row execute function public.ride_profile_erase();

-- ---------- 4) Konta dzēšana: vispirms pārbaudes ----------
create or replace function public.delete_my_account(p_unclosed_acct text default null) returns boolean
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid(); chk jsonb;
begin
  if me is null then raise exception 'Nav pieteicies'; end if;
  perform pg_advisory_xact_lock(hashtext('cz-delete-' || me::text));
  chk := account_delete_blockers(me);
  if not (chk->>'ok')::boolean then
    raise exception 'account_busy: kontu dzēst vēl nevar — ir aktīvs brauciens vai nepabeigts maksājums'
      using errcode = 'P0001', detail = (chk->'blockers')::text;
  end if;
  if p_unclosed_acct is not null and exists (select 1 from driver_accounts where user_id = me and acct = p_unclosed_acct) then
    insert into account_closures (acct) values (p_unclosed_acct) on conflict do nothing;
  end if;
  delete from user_stat_counters where user_id = me;                -- F16
  delete from user_reports where reporter_id = me;
  update user_reports set reported_id = null where reported_id = me;
  delete from traffic_quota where uid = me;
  delete from account_transfers where from_user = me;
  delete from auth.users where id = me;                             -- profils → ride_profile_erase (3. punkts)
  return true;
end
$$;
revoke all on function public.delete_my_account(text) from public, anon;
grant execute on function public.delete_my_account(text) to authenticated;

-- ---------- 5) Vērtējums / ziņojums par braucienu ar dzēstu lietotāju ----------
create or replace function public.ride_rating_fill() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid(); drv uuid; pas uuid; ost text; otrip text;
begin
  if me is null then raise exception 'Nav pieteicies'; end if;
  select o.driver_id, r.user_id, o.status, o.trip into drv, pas, ost, otrip
    from ride_offers o join ride_requests r on r.id = o.request_id where o.id = new.offer_id;
  if not found then raise exception 'Brauciens nav atrasts'; end if;
  if me = drv then new.rated_id := pas;
  elsif me = pas then new.rated_id := drv;
  else raise exception 'Tu nebiji šī brauciena dalībnieks';
  end if;
  if new.rated_id is null then raise exception 'other_deleted: otrs brauciena dalībnieks ir dzēsis kontu — novērtēt nevar'; end if;
  if ost <> 'accepted' or otrip <> 'done' then raise exception 'Novērtēt var tikai pabeigtu braucienu'; end if;
  if new.rated_id = me then raise exception 'Sevi novērtēt nevar'; end if;
  new.rater_id := me;
  new.comment := btrim(coalesce(new.comment, ''));
  new.created_at := now();
  return new;
end
$$;

create or replace function public.user_report_fill() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid(); drv uuid; pas uuid; ost text; otrip text; rst text;
begin
  if me is null then raise exception 'Nav pieteicies'; end if;
  select o.driver_id, r.user_id, o.status, o.trip, r.status into drv, pas, ost, otrip, rst
    from ride_offers o join ride_requests r on r.id = o.request_id where o.id = new.offer_id;
  if not found then raise exception 'Brauciens nav atrasts'; end if;
  if me = drv then new.reported_id := pas;                          -- NULL, ja otrs dzēsis kontu (ziņot par braucienu var)
  elsif me = pas then new.reported_id := drv;
  else raise exception 'Tu nebiji šī brauciena dalībnieks';
  end if;
  -- pabeigts vai atcelts brauciens (arī šofera atsaukts piedāvājums)
  if not ((ost = 'accepted' and (otrip = 'done' or rst = 'cancelled')) or ost = 'cancelled') then
    raise exception 'Ziņot var par pabeigtu vai atceltu braucienu';
  end if;
  if new.reported_id = me then raise exception 'Par sevi ziņot nevar'; end if;
  if (select count(*) from user_reports where reporter_id = me and created_at > now() - interval '1 day') >= 10 then
    raise exception 'Pārāk daudz ziņojumu — mēģini rīt';
  end if;
  new.reporter_id := me;
  new.details := btrim(coalesce(new.details, ''));
  new.status := 'new';
  new.created_at := now();
  return new;
end
$$;

select public.cz_migration_done(28, 'account-1-delete.sql');

-- PĀRBAUDE PĒC PALAIŠANAS:
--   supabase/status.sql → „VISS KĀRTĪBĀ”
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--     where conname in ('ride_requests_user_id_fkey', 'ride_offers_driver_id_fkey', 'ride_ratings_rater_id_fkey');   -- ON DELETE SET NULL
-- ATCELŠANA: nav ieteicama (atkal dzēstu otra cilvēka braucienus). Ja vajag — ārējās atslēgas atpakaļ uz ON DELETE CASCADE
--   un drop trigger profiles_erase_rides on public.profiles; jau anonimizētie ieraksti tādi paliek.
