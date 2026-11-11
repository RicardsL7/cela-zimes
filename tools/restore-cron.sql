-- Ceļa Zīmes — pg_cron darbu atjaunošana pēc datubāzes atjaunošanas (audits 2, B13).
--
-- KAD: ja pēc atjaunošanas no rezerves kopijas (vai pārcelšanas uz jaunu projektu) supabase/status.sql rāda
-- „plānotājs … nav ieplānots (pg_cron)”. Supabase fiziskās kopijas pg_cron darbus parasti saglabā — tad šis nav vajadzīgs.
-- KĀ: Supabase → SQL Editor → New query → ielīmē visu šo failu → Run. Var palaist atkārtoti (cron.schedule ar to pašu
-- nosaukumu darbu aizvieto, nevis dublē). Pēc tam — supabase/status.sql → „VISS KĀRTĪBĀ”.
-- Saraksts = visas `select cron.schedule(` rindas supabase/*.sql (tests/run.js pārbauda, ka nekas netrūkst).
create extension if not exists pg_cron;
select cron.schedule('cz-anon-cleanup', '23 2 * * *', 'select public.cz_anon_cleanup()');
select cron.schedule('cz-cleanup', '*/5 * * * *', 'select public.cz_cleanup()');
select cron.schedule('cz-client-errors', '51 2 * * *', 'select public.cz_client_errors_cleanup()');
select cron.schedule('cz-radar-votes', '37 2 * * *', 'select public.cz_radar_votes_cleanup()');
