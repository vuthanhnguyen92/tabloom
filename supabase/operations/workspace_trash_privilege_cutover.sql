-- OPERATOR ONLY: intentionally outside migrations, never applied by db push.
-- Run after compatible web/MCP deployment, legacy-client refresh/maintenance,
-- and the acceptance checks in docs/mcp-setup.md. This single statement is
-- atomic, rerunnable, and leaves all grants unchanged if any check fails.
-- The operator must set tabloom.trash_clients_ready=on in this connection.
do $cutover$
declare
  saved_table text;
  rpc_signature text;
  rpc_oid regprocedure;
begin
  if current_setting('tabloom.trash_clients_ready',true) is distinct from 'on' then
    raise exception 'Confirm compatible clients and legacy-client refresh before Trash privilege cutover';
  end if;
  foreach rpc_signature in array array[
    'public.list_workspace_trash()',
    'public.prepare_workspace_delete(text,uuid)',
    'public.trash_workspace_entity(text,uuid,text,uuid,uuid)',
    'public.restore_workspace_trash(uuid,uuid)',
    'public.purge_expired_workspace_trash(integer)',
    'public.apply_workspace_operations(jsonb,bigint)',
    'public.apply_workspace_command(uuid,text,text,jsonb,bigint)',
    'public.trash_workspace_link_if_unchanged(uuid,timestamp with time zone,uuid)'
  ] loop
    rpc_oid := to_regprocedure(rpc_signature);
    if rpc_oid is null then raise exception 'Missing required Trash RPC: %',rpc_signature; end if;
    if not (select prosecdef from pg_proc where oid=rpc_oid)
      or not has_function_privilege('authenticated',rpc_oid,'EXECUTE')
      or has_function_privilege('anon',rpc_oid,'EXECUTE')
      or has_function_privilege('service_role',rpc_oid,'EXECUTE') then
      raise exception 'Unsafe required Trash RPC privileges: %',rpc_signature;
    end if;
  end loop;
  if has_function_privilege('authenticated','public.apply_workspace_operations_strict(jsonb,bigint)','EXECUTE')
    or has_function_privilege('authenticated','public.workspace_trash_snapshot(text,uuid)','EXECUTE') then
    raise exception 'Private workspace helpers must not be callable by authenticated clients';
  end if;
  foreach saved_table in array array['spaces','collections','links'] loop
    if not (select relrowsecurity from pg_class where oid=format('public.%I',saved_table)::regclass) then
      raise exception 'Workspace ownership RLS is disabled: %',saved_table;
    end if;
    execute format('revoke delete on public.%I from public,anon,authenticated',saved_table);
    execute format('drop policy if exists %I on public.%I','owners manage '||saved_table,saved_table);
    execute format('drop policy if exists %I on public.%I','owners read '||saved_table,saved_table);
    execute format('drop policy if exists %I on public.%I','owners create '||saved_table,saved_table);
    execute format('drop policy if exists %I on public.%I','owners update '||saved_table,saved_table);
    execute format('create policy %I on public.%I for select using (auth.uid()=user_id)','owners read '||saved_table,saved_table);
    execute format('create policy %I on public.%I for insert with check (auth.uid()=user_id)','owners create '||saved_table,saved_table);
    execute format('create policy %I on public.%I for update using (auth.uid()=user_id) with check (auth.uid()=user_id)','owners update '||saved_table,saved_table);
    -- Abort the entire statement if inherited grants or an unexpected policy
    -- would leave a bypass, or if the non-delete client grants are missing.
    if has_table_privilege('authenticated',format('public.%I',saved_table),'DELETE')
      or not has_table_privilege('authenticated',format('public.%I',saved_table),'SELECT')
      or not has_table_privilege('authenticated',format('public.%I',saved_table),'INSERT')
      or not has_table_privilege('authenticated',format('public.%I',saved_table),'UPDATE')
      or exists(select 1 from pg_policies where schemaname='public' and tablename=saved_table and cmd in ('ALL','DELETE')) then
      raise exception 'Workspace privilege cutover postcheck failed: %',saved_table;
    end if;
  end loop;
end;
$cutover$;
