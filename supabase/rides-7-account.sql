-- Ceļa Zīmes — 7. daļa (F1): piekrišanas, anonīmā konta datu pārcelšana un konta dzēšana.
-- Supabase → SQL Editor → Run. Var palaist atkārtoti. Esošās tabulas netiek mainītas destruktīvi.
--
-- Kāpēc SQL funkcijas (security definer), nevis servisa atslēga: lietotne ir statiska lapa; pārlūkā nedrīkst būt
-- servisa atslēgas. Šīs funkcijas pašas pārbauda, kas ir pieteicies (auth.uid()), un dara tikai ar viņa datiem.

-- ---------- Piekrišanas (noteikumi, privātums, ātruma dalīšana) ----------
create table if not exists public.user_consents (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  kind       text not null check (kind in ('terms', 'privacy', 'speed_share')),
  version    text not null check (char_length(version) between 1 and 40),
  accepted   boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists user_consents_user on public.user_consents (user_id, kind, created_at desc);
alter table public.user_consents enable row level security;
drop policy if exists consents_insert on public.user_consents;
create policy consents_insert on public.user_consents for insert to authenticated with check (user_id = auth.uid());
drop policy if exists consents_read on public.user_consents;
create policy consents_read on public.user_consents for select to authenticated using (user_id = auth.uid());

-- ---------- Anonīmā konta datu pārcelšana uz pastāvīgu kontu ----------
-- 1) Anonīmais lietotājs (vēl pieteicies) izsauc account_transfer_start() → saņem vienreizēju kodu (der 2 h).
-- 2) Pēc pieslēgšanās esošajam kontam izsauc account_transfer_claim(kods) → dati tiek pārcelti, anonīmais konts dzēsts.
-- Kodu glabā tikai kā SHA-256; bez koda nevar pārcelt cita lietotāja datus.
create table if not exists public.account_transfers (
  code_hash  text primary key,
  from_user  uuid not null references auth.users on delete cascade,
  expires_at timestamptz not null
);
alter table public.account_transfers enable row level security;     -- bez politikām: tikai caur funkcijām

-- Vecais (anonīmais) ID → jaunais: vajadzīgs Stripe šofera kontam, kas izveidots ar veco ID (servera funkcija ride-pay)
create table if not exists public.account_aliases (
  old_user   uuid primary key,
  new_user   uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.account_aliases enable row level security;
drop policy if exists aliases_read on public.account_aliases;
create policy aliases_read on public.account_aliases for select to authenticated using (new_user = auth.uid());

-- Stripe konti, kurus dzēšot kontu neizdevās automātiski slēgt — īpašniekam jāslēdz Stripe panelī
create table if not exists public.account_closures (
  acct         text primary key check (acct ~ '^acct_[A-Za-z0-9]{6,40}$'),
  requested_at timestamptz not null default now()
);
alter table public.account_closures enable row level security;     -- bez politikām: redz tikai īpašnieks (SQL / panelis)

create or replace function public.account_transfer_start() returns text
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid(); code text;
begin
  if me is null then raise exception 'Nav pieteicies'; end if;
  if not coalesce((select is_anonymous from auth.users where id = me), false) then
    raise exception 'Pārcelt var tikai no anonīma konta';
  end if;
  code := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  delete from account_transfers where from_user = me or expires_at < now();
  insert into account_transfers (code_hash, from_user, expires_at)
    values (encode(sha256(convert_to(code, 'UTF8')), 'hex'), me, now() + interval '2 hours');
  return code;
end
$$;

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
  end if;

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

-- Vai old ir pārcelts uz new (servera funkcijai ride-pay: Stripe konts izveidots ar veco ID)
create or replace function public.account_alias_ok(old_id uuid, new_id uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (select 1 from account_aliases where old_user = old_id and new_user = new_id) $$;

-- ---------- Konta dzēšana (GDPR) ----------
-- Dzēš pieteikušos lietotāju: auth.users → kaskādē profils, tālrunis, braucienu pieprasījumi, piedāvājumi,
-- čata ziņas, šofera Stripe konta piesaiste, piekrišanas. Sastrēgumu mērījumos lietotāja ID nav (tie paliek anonīmi);
-- dzēš arī ātruma dalīšanas limitu ierakstu. Ja Stripe kontu neizdevās slēgt — to pieraksta īpašniekam.
create or replace function public.delete_my_account(p_unclosed_acct text default null) returns boolean
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Nav pieteicies'; end if;
  if p_unclosed_acct is not null and exists (select 1 from driver_accounts where user_id = me and acct = p_unclosed_acct) then
    insert into account_closures (acct) values (p_unclosed_acct) on conflict do nothing;
  end if;
  delete from traffic_quota where uid = me;
  delete from account_transfers where from_user = me;
  delete from auth.users where id = me;
  return true;
end
$$;

revoke all on function public.account_transfer_start() from public, anon;
revoke all on function public.account_transfer_claim(text) from public, anon;
revoke all on function public.account_alias_ok(uuid, uuid) from public, anon;
revoke all on function public.delete_my_account(text) from public, anon;
grant execute on function public.account_transfer_start() to authenticated;
grant execute on function public.account_transfer_claim(text) to authenticated;
grant execute on function public.account_alias_ok(uuid, uuid) to authenticated;
grant execute on function public.delete_my_account(text) to authenticated;
