-- Ceļa Zīmes — ziņojumu balsis: viens konts skaitās vienreiz (audits 2, B17 — 27.11.2026).
--
-- KĀ PALAIST: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run. Var palaist atkārtoti (kamēr nav jaunāku).
-- Palaist PĒC client-errors.sql (secība — supabase/ORDER.txt, Nr. 37).
--
-- Problēma (atrada B17 uzvedības tests tests/reports-test.sql): ziņojums tiek paslēpts pēc 2 „vairs nav” pēc kārtas
-- (coins-1.sql, no_streak). report_vote neskatījās, vai šis konts jau tā balsojis — tas pats konts, divreiz izsaucot
-- report_vote(…, 'gone'), viens pats varēja paslēpt jebkuru ziņojumu (lietotne to nedara, bet API var izsaukt jebkurš).
-- Tāpat atkārtots „vēl ir” no viena konta katru reizi pagarināja derīgumu (līdz griestiem).
--
-- Labojums: report_vote — tā pati balss no tā paša konta vēlreiz netiek skaitīta (atgriež pašreizējo stāvokli).
-- Balss maiņa („vēl ir” → „vairs nav”) strādā kā līdz šim. report_confirm jau atteica atkārtotu atbildi (already_answered).

do $$ begin
  if to_regprocedure('public.cz_migration_begin(integer, text)') is null
     or to_regprocedure('public.client_error(jsonb)') is null then
    raise exception 'Vispirms palaid visus iepriekšējos failus līdz client-errors.sql (secība — supabase/ORDER.txt).';
  end if;
end $$;
select public.cz_migration_begin(37, 'reports-2-vote-once.sql');

create or replace function public.report_vote(p_id uuid, p_vote text) returns jsonb
  language plpgsql security definer set search_path = public as
$$
declare me uuid := auth.uid(); owner uuid; n int; prev text; res jsonb;
begin
  if me is null then raise exception 'no_auth'; end if;
  if p_vote is null or p_vote not in ('still', 'gone') then raise exception 'bad_vote'; end if;
  select user_id into owner from reports where id = p_id;
  if not found then raise exception 'not_found'; end if;
  if owner = me then raise exception 'own_report'; end if;
  select vote into prev from report_votes where report_id = p_id and user_id = me;
  if prev = p_vote then                                   -- B17: tā pati balss vēlreiz — netiek skaitīta otrreiz
    select jsonb_build_object('id', r.id, 'still', r.still_count, 'gone', r.gone_count, 'hidden', r.hidden,
                              'expires_at', r.expires_at, 'confidence', r.confidence, 'repeat', true)
      into res from reports r where r.id = p_id;
    return res;
  end if;
  select count(*) into n from report_votes where user_id = me and created_at > now() - interval '1 hour';
  if n >= 60 then raise exception 'vote_limit'; end if;
  res := report_vote_apply(p_id, me, p_vote);
  if p_vote = 'still' and prev is distinct from 'still' then
    perform stat_bump('report_confirm');
    perform stat_user_bump(me, 'confirms');
    perform stat_user_bump(owner, 'confirmed');
  end if;
  return res;
end
$$;
revoke all on function public.report_vote(uuid, text) from public, anon;
grant execute on function public.report_vote(uuid, text) to authenticated;

select public.cz_migration_done(37, 'reports-2-vote-once.sql');

-- PĀRBAUDE PĒC PALAIŠANAS:
--   supabase/status.sql → „VISS KĀRTĪBĀ”
-- ATCELŠANA: palaid vēlreiz report_vote no coins-1.sql (6. sadaļa) — tad atkārtota balss atkal tiek skaitīta.
