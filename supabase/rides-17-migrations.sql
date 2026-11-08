-- Ceļa Zīmes — 17. daļa: migrāciju uzskaite (audits A09, 08.11.2026).
--
-- KĀ PALAIST: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run. Var palaist atkārtoti.
-- Palaist PĒDĒJO — pēc visiem failiem no supabase/ORDER.txt līdz rides-16-checkout.sql.
--
-- Ko tas dara:
--   1) Tabula cz_migrations — kuri faili no supabase/ORDER.txt ir palaisti un kad. Lietotnei (anon/authenticated)
--      tā nav redzama; to lasa tikai īpašnieks SQL redaktorā un supabase/status.sql.
--   2) Atzīmē visus iepriekšējos failus (1–25) kā palaistus (pirms uzskaites — laiks nav zināms).
--   3) No šī brīža vecie faili, kuru atkārtota palaišana atjaunotu vecākas funkciju versijas (sk. MIGRATIONS.md),
--      paši atsakās darboties (pārbaude faila sākumā), ja jau palaisti jaunāki.
--   4) Funkcijas nākamajām migrācijām: cz_migration_begin(nr, nosaukums) faila sākumā un cz_migration_done(…) beigās.
-- Datus nemaina, neko nedzēš.

-- Visi iepriekšējie faili jau palaisti? (pēdējais — rides-16-checkout.sql)
do $$ begin
  if to_regprocedure('public.ride_checkout_save(uuid, text, integer)') is null
     or to_regprocedure('public.ride_offer_accept(uuid)') is null
     or not exists (select 1 from pg_trigger where tgname = 'ride_offers_guard_trip') then
    raise exception 'Vispirms palaid visus iepriekšējos failus līdz rides-16-checkout.sql (secība — supabase/ORDER.txt).';
  end if;
end $$;

create table if not exists public.cz_migrations (
  seq        int primary key,
  name       text not null unique,
  applied_at timestamptz not null default now(),
  note       text
);
alter table public.cz_migrations enable row level security;      -- bez politikām: lietotnei nekas nav redzams
revoke all on public.cz_migrations from public, anon, authenticated;

insert into public.cz_migrations (seq, name, note) values
  (1, 'rides.sql', 'pirms uzskaites'), (2, 'rides-2-chat-trip.sql', 'pirms uzskaites'),
  (3, 'rides-3-pay.sql', 'pirms uzskaites'), (4, 'rides-4-expire.sql', 'pirms uzskaites'),
  (5, 'rides-5-reoffer.sql', 'pirms uzskaites'), (6, 'rides-6-price.sql', 'pirms uzskaites'),
  (7, 'rides-7-account.sql', 'pirms uzskaites'), (8, 'radars.sql', 'pirms uzskaites'),
  (9, 'traffic.sql', 'pirms uzskaites'), (10, 'traffic-2-helpers.sql', 'pirms uzskaites'),
  (11, 'reports.sql', 'pirms uzskaites'), (12, 'rides-8-refund.sql', 'pirms uzskaites'),
  (13, 'rides-9-ratings.sql', 'pirms uzskaites'), (14, 'rides-10-declined.sql', 'pirms uzskaites'),
  (15, 'stats-f16.sql', 'pirms uzskaites'), (16, 'rides-11-paymark.sql', 'pirms uzskaites'),
  (17, 'rides-12-webhook.sql', 'pirms uzskaites'), (18, 'stats-2-f23.sql', 'pirms uzskaites'),
  (19, 'coins-1.sql', 'pirms uzskaites'), (20, 'coins-2-presence.sql', 'pirms uzskaites'),
  (21, 'coins-3-skins.sql', 'pirms uzskaites'), (22, 'rides-13-guard.sql', 'pirms uzskaites'),
  (23, 'rides-14-accept.sql', 'pirms uzskaites'), (24, 'rides-15-trip.sql', 'pirms uzskaites'),
  (25, 'rides-16-checkout.sql', 'pirms uzskaites')
on conflict (seq) do nothing;

-- Nākamajām migrācijām (18, 19, …): faila sākumā  select public.cz_migration_begin(18, 'faila-nosaukums.sql');
--                                   faila beigās   select public.cz_migration_done(18, 'faila-nosaukums.sql');
-- begin atsakās, ja jau palaists jaunāks fails (atkārtoti var palaist tikai pēdējo, vai ar set cz.allow_rerun = 'on').
create or replace function public.cz_migration_begin(p_seq int, p_name text) returns void
  language plpgsql set search_path = public as
$$ begin
  if exists (select 1 from cz_migrations where seq > p_seq)
     and coalesce(current_setting('cz.allow_rerun', true), '') <> 'on' then
    raise exception '% (Nr. %) ir vecs migrācijas fails, un pēc tā jau palaisti jaunāki — atkārtoti to palaist nedrīkst. Sk. supabase/MIGRATIONS.md.', p_name, p_seq;
  end if;
  if exists (select 1 from cz_migrations where seq = p_seq and name <> p_name) then
    raise exception 'Numurs % jau aizņemts ar citu failu — pārbaudi supabase/ORDER.txt.', p_seq;
  end if;
end $$;
create or replace function public.cz_migration_done(p_seq int, p_name text) returns void
  language sql set search_path = public as
$$ insert into cz_migrations (seq, name) values (p_seq, p_name)
   on conflict (seq) do update set applied_at = now() where cz_migrations.name = excluded.name $$;
revoke all on function public.cz_migration_begin(int, text) from public, anon, authenticated;
revoke all on function public.cz_migration_done(int, text) from public, anon, authenticated;

select public.cz_migration_done(26, 'rides-17-migrations.sql');

-- PĀRBAUDE PĒC PALAIŠANAS:  select * from public.cz_migrations order by seq;   (26 rindas)
-- Pilna pārbaude, vai datubāze sakrīt ar repozitoriju: supabase/status.sql
-- ATCELŠANA: drop function public.cz_migration_begin(int, text); drop function public.cz_migration_done(int, text);
--            drop table public.cz_migrations;   (vecie faili tad atkal ļaus sevi palaist atkārtoti — bez aizsardzības)
