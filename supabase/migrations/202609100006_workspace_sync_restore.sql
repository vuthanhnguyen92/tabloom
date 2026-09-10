-- Preserve the existing fast batch path. Restore batches execute in sequence
-- under the same account revision lock and transaction as ordinary operations.
alter function public.apply_workspace_operations(jsonb,bigint) rename to apply_workspace_operations_before_restore;
revoke all on function public.apply_workspace_operations_before_restore(jsonb,bigint) from public,anon,authenticated,service_role;

create or replace function public.apply_workspace_operations(operations jsonb, expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
  current_revision bigint;
  operation jsonb;
  restore_operation_id uuid;
  result jsonb;
  outcomes jsonb := '[]'::jsonb;
  trash public.workspace_trash;
begin
  if owner_id is null then raise exception 'authentication required' using errcode='28000'; end if;
  if expected_revision is null or expected_revision < 0 or jsonb_typeof(operations) <> 'array'
    or jsonb_array_length(operations) > 500 then raise exception 'invalid workspace operations' using errcode='22023'; end if;
  if not exists(select 1 from jsonb_array_elements(operations) op where op->>'action'='restore') then
    return public.apply_workspace_operations_before_restore(operations, expected_revision);
  end if;
  insert into public.workspace_sync_state(user_id,revision) values(owner_id,0) on conflict(user_id) do nothing;
  select revision into current_revision from public.workspace_sync_state where user_id=owner_id for update;
  if current_revision <> expected_revision then raise exception 'workspace revision conflict' using errcode='40001'; end if;
  for operation in select value from jsonb_array_elements(operations) order by (value->>'sequence')::bigint, value->>'operationId'
  loop
    if operation->>'action' <> 'restore' then
      result := public.apply_workspace_operations_before_restore(jsonb_build_array(operation),current_revision);
      outcomes := outcomes || (result->'outcomes');
      current_revision := (result->>'revision')::bigint;
      continue;
    end if;
    if jsonb_typeof(operation) <> 'object' or operation->>'entity' not in ('space','collection','link')
      or coalesce(operation->>'operationId','') !~* '^[0-9a-f-]{36}$'
      or coalesce(operation->>'deviceId','') !~* '^[0-9a-f-]{36}$'
      or coalesce(operation->>'entityId','') !~* '^[0-9a-f-]{36}$'
      or coalesce(operation->>'sequence','') !~ '^[1-9][0-9]*$'
      or jsonb_typeof(operation->'payload') <> 'object'
      or ((operation->'payload' ? 'deleteOperationId') = (operation->'payload' ? 'trashId'))
      or coalesce(operation #>> '{payload,deleteOperationId}',operation #>> '{payload,trashId}','') !~* '^[0-9a-f-]{36}$'
      or exists(select 1 from jsonb_object_keys(operation->'payload') key where key not in ('deleteOperationId','trashId','destinationId','snapshot'))
    then raise exception 'invalid workspace restore operation' using errcode='22023'; end if;
    restore_operation_id := (operation->>'operationId')::uuid;
    -- The client snapshot is ONLY local rebase data. It never supplies records
    -- or ownership for restoration; resolve the server-created owned receipt.
    select * into trash from public.workspace_trash t where t.user_id=owner_id
      and (t.created_operation_id=(operation #>> '{payload,deleteOperationId}')::uuid or t.id=(operation #>> '{payload,trashId}')::uuid)
      and t.root_type=operation->>'entity' and t.root_id=(operation->>'entityId')::uuid for update;
    if not found then raise exception 'workspace trash not found' using errcode='P0002'; end if;
    if exists(select 1 from public.workspace_operations a where a.user_id=owner_id and a.operation_id=restore_operation_id) then
      outcomes := outcomes || jsonb_build_array(jsonb_build_object('operationId',restore_operation_id,'status','already_applied'));
      continue;
    end if;
    result := public.restore_workspace_trash(trash.id,(operation #>> '{payload,destinationId}')::uuid);
    if result->>'status'='destination_required' then
      -- Leave the durable operation retryable; never acknowledge a restore
      -- whose parent disappeared. The UI can supply a fresh destination.
      raise exception 'destination_required' using errcode='P0001';
    end if;
    current_revision := (result->>'revision')::bigint;
    insert into public.workspace_operations(user_id,operation_id,device_id,sequence,applied_revision)
      values(owner_id,restore_operation_id,(operation->>'deviceId')::uuid,(operation->>'sequence')::bigint,current_revision);
    outcomes := outcomes || jsonb_build_array(jsonb_build_object('operationId',restore_operation_id,'status','applied'));
  end loop;
  result := public.load_workspace_snapshot();
  return jsonb_build_object('revision',current_revision,'outcomes',outcomes,'patches',result->'snapshot',
    'tombstones',result->'tombstones','conflicts','[]'::jsonb);
end;
$$;
revoke all on function public.apply_workspace_operations(jsonb,bigint) from public,anon,service_role;
grant execute on function public.apply_workspace_operations(jsonb,bigint) to authenticated;

-- Keep list_workspace_trash() byte-compatible with older web clients.
create or replace function public.list_workspace_trash_for_sync()
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare entries jsonb;
begin
  entries := public.list_workspace_trash();
  return coalesce((select jsonb_agg(entry.value || jsonb_build_object('operationId',trash.created_operation_id) order by entry.ordinality)
    from jsonb_array_elements(entries) with ordinality entry(value,ordinality)
    join public.workspace_trash trash on trash.user_id=auth.uid() and trash.id=(entry.value->>'id')::uuid),'[]'::jsonb);
end;
$$;
revoke all on function public.list_workspace_trash_for_sync() from public,anon,service_role;
grant execute on function public.list_workspace_trash_for_sync() to authenticated;

-- Materialize once: a semi-join plan can otherwise rescan a LIMIT/FOR UPDATE
-- subquery for each target row and exceed the promised cleanup budget.
create or replace function public.purge_expired_workspace_trash(p_limit integer)
returns integer language plpgsql security definer set search_path = public, pg_temp
as $$
declare owner_id uuid := auth.uid(); purged integer;
begin
  if owner_id is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 1000 then raise exception 'invalid purge limit' using errcode='22023'; end if;
  with candidates as materialized (
    select id from public.workspace_trash where user_id=owner_id and expires_at <= clock_timestamp()
      order by expires_at,id limit p_limit for update skip locked
  ) delete from public.workspace_trash trash using candidates
    where trash.user_id=owner_id and trash.id=candidates.id;
  get diagnostics purged = row_count;
  return purged;
end;
$$;
