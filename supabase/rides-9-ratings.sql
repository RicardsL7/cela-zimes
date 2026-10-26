-- Ceļa Zīmes — kopbraucieni, 9. daļa (labojums F13): vērtējumi pēc brauciena, ziņošana par lietotāju,
-- „Mani braucieni” (vēsture).
--
-- KĀ PALAIST: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run.
-- Jāpalaiž PĒC rides.sql … rides-8-refund.sql (un reports.sql, ja tas ir palaists). Var palaist atkārtoti.
--
-- Kā tas strādā:
--   • ride_ratings — pēc pabeigta brauciena pasažieris vērtē šoferi un šoferis pasažieri (1–5 zvaigznes,
--     neobligāts komentārs). Viens vērtējums uz braucienu katram; mainīt vai dzēst nevar.
--   • user_reports — „Ziņot par problēmu” (arī par atceltu braucienu). Ziņojumus redz tikai pats ziņotājs
--     un lietotnes īpašnieks (Supabase panelī); citi lietotāji — nē. Ne vairāk kā 10 ziņojumi dienā.
--   • Kurš tiek vērtēts / par kuru ziņo (rated_id / reported_id), aizpilda datubāze pati (triggeris) —
--     klienta sūtītajai vērtībai netic.
--   • rating_summary(ids) — vidējais vērtējums un pabeigto braucienu skaits (bez atsevišķiem komentāriem).
--   • my_ride_history(lim) — mani pabeigtie un atceltie braucieni abās lomās (ar otras puses vārdu).

-- ---------- Vai piedāvājums kādreiz bija pieņemts (tad tas ir „brauciens”, nevis tikai piedāvājums) ----------
alter table public.ride_offers add column if not exists was_accepted boolean not null default false;
update public.ride_offers o set was_accepted = true
  where not o.was_accepted
    and (o.status = 'accepted' or o.trip <> '' or exists (select 1 from public.ride_payments p where p.offer_id = o.id));

create or replace function public.ride_offer_mark_accepted() returns trigger
  language plpgsql set search_path = public as
$$ begin
  if new.status = 'accepted' then new.was_accepted := true;
  elsif tg_op = 'UPDATE' then new.was_accepted := old.was_accepted or new.was_accepted;
  else new.was_accepted := false;                                  -- jauns piedāvājums vienmēr sākas kā nepieņemts
  end if;
  return new;
end $$;
drop trigger if exists ride_offer_mark_accepted on public.ride_offers;
create trigger ride_offer_mark_accepted before insert or update on public.ride_offers
  for each row execute function public.ride_offer_mark_accepted();

-- ---------- Vērtējumi ----------
create table if not exists public.ride_ratings (
  id         bigint generated always as identity primary key,
  offer_id   uuid not null references public.ride_offers on delete cascade,
  rater_id   uuid not null default auth.uid() references public.profiles on delete cascade,
  rated_id   uuid not null references public.profiles on delete cascade,
  stars      smallint not null check (stars between 1 and 5),
  comment    text not null default '' check (char_length(comment) <= 200),
  created_at timestamptz not null default now(),
  unique (offer_id, rater_id)
);
create index if not exists ride_ratings_rated on public.ride_ratings (rated_id);
alter table public.ride_ratings enable row level security;

-- Aizpilda vērtētāju un vērtējamo (otra brauciena puse); pārbauda, ka brauciens pabeigts.
create or replace function public.ride_rating_fill() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid(); drv uuid; pas uuid; ost text; otrip text;
begin
  if me is null then raise exception 'Nav pieteicies'; end if;
  select o.driver_id, r.user_id, o.status, o.trip into drv, pas, ost, otrip
    from ride_offers o join ride_requests r on r.id = o.request_id where o.id = new.offer_id;
  if drv is null then raise exception 'Brauciens nav atrasts'; end if;
  if me = drv then new.rated_id := pas;
  elsif me = pas then new.rated_id := drv;
  else raise exception 'Tu nebiji šī brauciena dalībnieks';
  end if;
  if ost <> 'accepted' or otrip <> 'done' then raise exception 'Novērtēt var tikai pabeigtu braucienu'; end if;
  if new.rated_id = me then raise exception 'Sevi novērtēt nevar'; end if;
  new.rater_id := me;
  new.comment := btrim(coalesce(new.comment, ''));
  new.created_at := now();
  return new;
end
$$;
drop trigger if exists ride_rating_fill on public.ride_ratings;
create trigger ride_rating_fill before insert on public.ride_ratings
  for each row execute function public.ride_rating_fill();

drop policy if exists ratings_insert on public.ride_ratings;
create policy ratings_insert on public.ride_ratings for insert to authenticated
  with check (rater_id = auth.uid() and public.is_offer_party(offer_id));
drop policy if exists ratings_read_own on public.ride_ratings;
create policy ratings_read_own on public.ride_ratings for select to authenticated using (rater_id = auth.uid());
-- update / delete politiku nav: vērtējumu mainīt vai dzēst nevar

-- ---------- Ziņojumi par lietotāju („Ziņot par problēmu”) ----------
-- Nosaukums user_reports — tabula „reports” jau ir ceļa ziņojumiem (reports.sql).
create table if not exists public.user_reports (
  id          bigint generated always as identity primary key,
  offer_id    uuid references public.ride_offers on delete set null,
  reporter_id uuid default auth.uid() references auth.users on delete cascade,
  reported_id uuid references auth.users on delete set null,      -- dzēšot kontu, ziņojums paliek anonīms
  reason      text not null check (reason in ('dangerous_driving', 'behaviour', 'no_show', 'payment', 'other')),
  details     text not null default '' check (char_length(details) <= 500),
  status      text not null default 'new' check (status in ('new', 'reviewed', 'closed')),
  created_at  timestamptz not null default now()
);
create index if not exists user_reports_reporter on public.user_reports (reporter_id, created_at desc);
create index if not exists user_reports_reported on public.user_reports (reported_id);
alter table public.user_reports enable row level security;

create or replace function public.user_report_fill() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid(); drv uuid; pas uuid; ost text; otrip text; rst text;
begin
  if me is null then raise exception 'Nav pieteicies'; end if;
  select o.driver_id, r.user_id, o.status, o.trip, r.status into drv, pas, ost, otrip, rst
    from ride_offers o join ride_requests r on r.id = o.request_id where o.id = new.offer_id;
  if drv is null then raise exception 'Brauciens nav atrasts'; end if;
  if me = drv then new.reported_id := pas;
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
drop trigger if exists user_report_fill on public.user_reports;
create trigger user_report_fill before insert on public.user_reports
  for each row execute function public.user_report_fill();

drop policy if exists user_reports_insert on public.user_reports;
create policy user_reports_insert on public.user_reports for insert to authenticated with check (reporter_id = auth.uid());
drop policy if exists user_reports_read_own on public.user_reports;
create policy user_reports_read_own on public.user_reports for select to authenticated using (reporter_id = auth.uid());

-- ---------- Vidējais vērtējums (profilā un piedāvājuma kartītē) ----------
-- rides — pabeigto braucienu skaits abās lomās. Atsevišķi komentāri netiek atdoti.
create or replace function public.rating_summary(ids uuid[])
  returns table (user_id uuid, avg numeric, count int, rides int)
  language sql stable security definer set search_path = public as
$$
  select u.id,
         (select round(avg(t.stars)::numeric, 1) from ride_ratings t where t.rated_id = u.id),
         (select count(*)::int from ride_ratings t where t.rated_id = u.id),
         (select count(*)::int from ride_offers o join ride_requests r on r.id = o.request_id
            where o.status = 'accepted' and o.trip = 'done' and (o.driver_id = u.id or r.user_id = u.id))
  from (select distinct x as id from unnest(coalesce(ids[1:100], '{}')) x where x is not null) u
  where auth.uid() is not null
$$;

-- ---------- „Mani braucieni” ----------
-- Pabeigtie un atceltie braucieni, kuros esmu pasažieris vai šoferis (jaunākie augšā),
-- un pasažiera atceltie / novecojušie pieprasījumi, kurus neviens nepieņēma.
create or replace function public.my_ride_history(lim int default 50)
  returns table (offer_id uuid, request_id uuid, role text, status text, trip text, depart_at timestamptz,
                 from_name text, to_name text, from_lat double precision, from_lng double precision,
                 to_lat double precision, to_lng double precision, seats smallint, price_cents int,
                 pay_status text, refund_cents int, other_id uuid, other_name text, other_car text,
                 my_stars smallint, my_comment text, reported boolean)
  language sql stable security definer set search_path = public as
$$
  with me as (select auth.uid() as id),
  rides as (
    select o.id as offer_id, r.id as request_id,
           case when o.driver_id = me.id then 'driver' else 'passenger' end as role,
           case when o.status = 'accepted' and o.trip = 'done' then 'done' else 'cancelled' end as status,
           o.trip, r.depart_at, r.from_name, r.to_name, r.from_lat, r.from_lng, r.to_lat, r.to_lng, r.seats, o.price_cents,
           p.status as pay_status, p.refund_cents,
           case when o.driver_id = me.id then r.user_id else o.driver_id end as other_id
    from me, ride_offers o
      join ride_requests r on r.id = o.request_id
      left join ride_payments p on p.offer_id = o.id
    where o.was_accepted and (o.driver_id = me.id or r.user_id = me.id)
      and (r.status in ('done', 'cancelled') or o.status = 'cancelled' or (o.status = 'accepted' and o.trip = 'done'))
    union all
    select null, r.id, 'passenger', 'cancelled', '', r.depart_at, r.from_name, r.to_name, r.from_lat, r.from_lng,
           r.to_lat, r.to_lng, r.seats, null, null, null, null
    from me, ride_requests r
    where r.user_id = me.id and r.status = 'cancelled'
      and not exists (select 1 from ride_offers o where o.request_id = r.id and o.was_accepted)
  )
  select x.offer_id, x.request_id, x.role, x.status, x.trip, x.depart_at, x.from_name, x.to_name,
         x.from_lat, x.from_lng, x.to_lat, x.to_lng, x.seats, x.price_cents, x.pay_status, x.refund_cents,
         x.other_id, pr.name, pr.car, rt.stars, rt.comment,
         exists (select 1 from user_reports u, me where u.offer_id = x.offer_id and u.reporter_id = me.id)
  from rides x
    left join profiles pr on pr.id = x.other_id
    left join ride_ratings rt on rt.offer_id = x.offer_id and rt.rater_id = (select id from me)
  where (select id from me) is not null
  order by x.depart_at desc
  limit greatest(1, least(coalesce(lim, 50), 200))
$$;

revoke all on function public.rating_summary(uuid[]) from public, anon;
revoke all on function public.my_ride_history(int) from public, anon;
grant execute on function public.rating_summary(uuid[]) to authenticated;
grant execute on function public.my_ride_history(int) to authenticated;

-- ---------- Kontu apvienošana (F1): pārceļ arī vērtējumus un ziņojumus ----------
-- Tā pati funkcija kā rides-7-account.sql / reports.sql, papildināta ar ride_ratings un user_reports.
create or replace function public.account_transfer_claim(code text) returns jsonb
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid(); src uuid; n_req int := 0; n_off int := 0; n_msg int := 0; stripe_note text := null;
begin
  if me is null then raise exception 'Nav pieteicies'; end if;
  select from_user into src from account_transfers
    where code_hash = encode(sha256(convert_to(coalesce(code, ''), 'UTF8')), 'hex') and expires_at > now();
  if src is null then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  delete from account_transfers where from_user = src;
  if src = me then return jsonb_build_object('ok', true, 'same', true); end if;
  if not coalesce((select is_anonymous from auth.users where id = src), false) then
    return jsonb_build_object('ok', false, 'reason', 'not_anonymous');
  end if;

  -- Profils: ja jaunajam kontam profila nav, pārņem anonīmā konta vārdu, auto un tālruni
  if not exists (select 1 from profiles where id = me) and exists (select 1 from profiles where id = src) then
    insert into profiles (id, name, car) select me, name, car from profiles where id = src;
    insert into contacts (id, phone) select me, phone from contacts where id = src on conflict (id) do nothing;
  end if;

  if exists (select 1 from profiles where id = src) then
    update ride_requests set user_id = me where user_id = src;
    get diagnostics n_req = row_count;
    -- Ja abi konti piedāvājuši vienu un to pašu braucienu — anonīmā konta piedāvājumu atceļ (aktīvs drīkst būt viens)
    update ride_offers o set status = 'cancelled'
      where o.driver_id = src and o.status <> 'cancelled'
        and exists (select 1 from ride_offers x where x.request_id = o.request_id and x.driver_id = me and x.status <> 'cancelled');
    update ride_offers set driver_id = me where driver_id = src;
    get diagnostics n_off = row_count;
    update ride_messages set sender = me where sender = src;
    get diagnostics n_msg = row_count;
    if exists (select 1 from driver_accounts where user_id = src) then
      if not exists (select 1 from driver_accounts where user_id = me) then
        update driver_accounts set user_id = me where user_id = src;
        stripe_note := 'moved';
      else
        insert into account_closures (acct) select acct from driver_accounts where user_id = src on conflict do nothing;
        stripe_note := 'duplicate';
      end if;
    end if;
    -- F13: vērtējumi (dots un saņemtie). Ja abi konti novērtējuši vienu braucienu — paliek jaunā konta vērtējums.
    delete from ride_ratings t where t.rater_id = src
      and exists (select 1 from ride_ratings x where x.offer_id = t.offer_id and x.rater_id = me);
    update ride_ratings set rater_id = me where rater_id = src;
    update ride_ratings set rated_id = me where rated_id = src;
    delete from ride_ratings where rater_id = rated_id;            -- abi konti bija viena brauciena puses
  end if;

  -- F13: ziņojumi par lietotājiem
  update user_reports set reporter_id = me where reporter_id = src;
  update user_reports set reported_id = me where reported_id = src;

  -- Ziņojumi uz ceļa (reports.sql): pārceļ ziņojumus; balsojumus — ja tie nedublējas un nav par paša ziņojumu
  if to_regclass('public.reports') is not null then
    update reports set user_id = me where user_id = src;
    delete from report_votes v where v.user_id = src
      and (exists (select 1 from report_votes x where x.report_id = v.report_id and x.user_id = me)
           or exists (select 1 from reports r where r.id = v.report_id and r.user_id = me));
    update report_votes set user_id = me where user_id = src;
  end if;

  update user_consents set user_id = me where user_id = src;
  insert into account_aliases (old_user, new_user) values (src, me)
    on conflict (old_user) do update set new_user = excluded.new_user;
  delete from auth.users where id = src;            -- atlikušais (anonīmais profils) tiek dzēsts kaskādē
  return jsonb_build_object('ok', true, 'requests', n_req, 'offers', n_off, 'messages', n_msg, 'stripe', stripe_note);
end
$$;

-- ---------- Konta dzēšana (GDPR, F1): arī vērtējumi un ziņojumi ----------
-- Dzēš manus dotos un saņemtos vērtējumus un manus ziņojumus. Ziņojumi par mani paliek anonīmi
-- (bez konta ID) — lai īpašnieks var izvērtēt drošības problēmas.
create or replace function public.delete_my_account(p_unclosed_acct text default null) returns boolean
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Nav pieteicies'; end if;
  if p_unclosed_acct is not null and exists (select 1 from driver_accounts where user_id = me and acct = p_unclosed_acct) then
    insert into account_closures (acct) values (p_unclosed_acct) on conflict do nothing;
  end if;
  delete from ride_ratings where rater_id = me or rated_id = me;
  delete from user_reports where reporter_id = me;
  update user_reports set reported_id = null where reported_id = me;
  delete from traffic_quota where uid = me;
  delete from account_transfers where from_user = me;
  delete from auth.users where id = me;
  return true;
end
$$;

revoke all on function public.account_transfer_claim(text) from public, anon;
revoke all on function public.delete_my_account(text) from public, anon;
grant execute on function public.account_transfer_claim(text) to authenticated;
grant execute on function public.delete_my_account(text) to authenticated;
