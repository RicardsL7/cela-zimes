-- Ceļa Zīmes — F19 (v115): Stripe webhook (servera funkcija stripe-webhook) un īpašnieka „Sinhronizēt ar Stripe”.
-- Palaid PĒC rides-11-paymark.sql. Supabase → SQL Editor → New query → ielīmē → Run.
--
-- stripe_events — apstrādāto Stripe notikumu ID (Stripe vienu notikumu var atsūtīt vairākas reizes).
-- Pieeja tikai servera funkcijām ar service_role (RLS ieslēgts, politiku nav; anon/authenticated tiesību nav).
-- Statusu pašu raksta ride_payment_mark (rides-11-paymark.sql) — tikai uz priekšu (created → paid → refunded).

create table if not exists public.stripe_events (
  id text primary key check (id ~ '^evt_[A-Za-z0-9]{6,200}$'),
  type text not null check (char_length(type) <= 100),
  offer_id uuid,
  result text check (char_length(result) <= 40),
  created_at timestamptz not null default now()
);
alter table public.stripe_events enable row level security;
revoke all on table public.stripe_events from public, anon, authenticated;
grant select, insert on table public.stripe_events to service_role;

-- Vecākus par 90 dienām var droši dzēst (Stripe atkārto notikumus tikai ~3 dienas)
create index if not exists stripe_events_created on public.stripe_events (created_at);

-- Pārbaude (pēc palaišanas): jāatgriež false, false, true
--   select has_table_privilege('authenticated', 'public.stripe_events', 'select'),
--          has_table_privilege('anon', 'public.stripe_events', 'insert'),
--          has_table_privilege('service_role', 'public.stripe_events', 'insert');
