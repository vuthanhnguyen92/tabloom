-- Read-only postcheck. Every boolean must be true for all three rows.
select saved_table,
  not has_table_privilege('authenticated',format('public.%I',saved_table),'DELETE') as direct_delete_blocked,
  has_table_privilege('authenticated',format('public.%I',saved_table),'SELECT') as can_read,
  has_table_privilege('authenticated',format('public.%I',saved_table),'INSERT') as can_create,
  has_table_privilege('authenticated',format('public.%I',saved_table),'UPDATE') as can_update,
  (select relrowsecurity from pg_class where oid=format('public.%I',saved_table)::regclass) as ownership_rls_enabled,
  not exists(select 1 from pg_policies where schemaname='public' and tablename=saved_table and cmd in ('ALL','DELETE')) as no_delete_policy
from unnest(array['spaces','collections','links']) as saved_table;
