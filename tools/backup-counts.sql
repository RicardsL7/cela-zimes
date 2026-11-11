-- Ceļa Zīmes — rindu skaits katrā lietotnes tabulā (public) un auth.users (audits 2, B13).
-- KAD: pirms un pēc atjaunošanas no rezerves kopijas — salīdzini, vai dati ir vietā (skaitiem jābūt tuviem kopijas brīdim).
-- KĀ: Supabase → SQL Editor → New query → ielīmē → Run. Tikai LASA. Izvade: tabula|rindas, sakārtota pēc nosaukuma.
select t.table_schema || '.' || t.table_name || '|' ||
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', t.table_schema, t.table_name), false, true, '')))[1]::text
from information_schema.tables t
where (t.table_schema = 'public' and t.table_type = 'BASE TABLE')
   or (t.table_schema = 'auth' and t.table_name = 'users')
order by 1;
