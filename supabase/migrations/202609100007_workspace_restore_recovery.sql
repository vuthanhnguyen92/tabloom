-- A redundant device deletion aliases an existing receipt only when the
-- owner, exact root and current tombstone generation all agree. Ancestor
-- receipts must never be used: they would restore data the user did not ask for.
create table public.workspace_trash_operation_aliases (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  trash_id uuid not null references public.workspace_trash(id) on delete cascade,
  primary key(user_id,operation_id)
);
alter table public.workspace_trash_operation_aliases enable row level security;
revoke all on public.workspace_trash_operation_aliases from public,anon,authenticated,service_role;

-- Definitive rejections are receipts too. A lost response can be replayed;
-- supplying a new destination requires a NEW operation identity afterward.
create table public.workspace_restore_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  request jsonb not null,
  outcome jsonb not null,
  primary key(user_id,operation_id)
);
alter table public.workspace_restore_receipts enable row level security;
revoke all on public.workspace_restore_receipts from public,anon,authenticated,service_role;

create function public.workspace_delete_receipt_alias(operation jsonb, outcome jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare owner_id uuid := auth.uid(); operation_id_value uuid; trash public.workspace_trash; receipt_id uuid;
begin
  if owner_id is null then raise exception 'authentication required' using errcode='28000'; end if;
  if operation->>'action'<>'delete' or outcome->>'status' not in ('applied','deleted','already_applied') then return outcome; end if;
  operation_id_value := (operation->>'operationId')::uuid;
  select t.* into trash from public.workspace_trash t
    where t.user_id=owner_id and t.root_type=operation->>'entity' and t.root_id=(operation->>'entityId')::uuid
      and (t.created_operation_id=operation_id_value or t.id=(select a.trash_id from public.workspace_trash_operation_aliases a where a.user_id=owner_id and a.operation_id=operation_id_value));
  if not found then
    select case when count(*)=1 then (array_agg(t.id))[1] end into receipt_id
      from public.workspace_trash t join public.workspace_tombstones d
        on d.user_id=t.user_id and d.entity_type=t.root_type and d.entity_id=t.root_id and d.deleted_at=t.deleted_at
      where t.user_id=owner_id and t.root_type=operation->>'entity' and t.root_id=(operation->>'entityId')::uuid
        and t.restored_at is null and t.expires_at>clock_timestamp();
    if receipt_id is not null then
      insert into public.workspace_trash_operation_aliases(user_id,operation_id,trash_id)
        values(owner_id,operation_id_value,receipt_id) on conflict do nothing;
      select * into trash from public.workspace_trash where user_id=owner_id and id=receipt_id;
    end if;
  end if;
  if trash.id is not null then return outcome || jsonb_build_object('trashId',trash.id,'restoreUntil',trash.expires_at); end if;
  return outcome;
end;
$$;
revoke all on function public.workspace_delete_receipt_alias(jsonb,jsonb) from public,anon,authenticated,service_role;

create or replace function public.apply_workspace_operations(operations jsonb, expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
  current_revision bigint;
  operation jsonb;
  operation_id_value uuid;
  result jsonb;
  outcome jsonb;
  outcomes jsonb := '[]'::jsonb;
  conflicts jsonb := '[]'::jsonb;
  trash public.workspace_trash;
  previous public.workspace_restore_receipts;
  request_value jsonb;
  failure text;
begin
  if owner_id is null then raise exception 'authentication required' using errcode='28000'; end if;
  if expected_revision is null or expected_revision < 0 or jsonb_typeof(operations) <> 'array'
    or jsonb_array_length(operations) > 500 then raise exception 'invalid workspace operations' using errcode='22023'; end if;
  if not exists(select 1 from jsonb_array_elements(operations) op where op->>'action'='restore') then
    -- Preserve the established single-revision ordinary batch contract.
    result := public.apply_workspace_operations_before_restore(operations, expected_revision);
    for outcome in select value from jsonb_array_elements(result->'outcomes') loop
      select value into operation from jsonb_array_elements(operations) where value->>'operationId'=outcome->>'operationId' limit 1;
      outcomes := outcomes || jsonb_build_array(public.workspace_delete_receipt_alias(operation,outcome));
    end loop;
    return jsonb_set(result,'{outcomes}',outcomes);
  end if;
  insert into public.workspace_sync_state(user_id,revision) values(owner_id,0) on conflict(user_id) do nothing;
  select revision into current_revision from public.workspace_sync_state where user_id=owner_id for update;
  if current_revision <> expected_revision then raise exception 'workspace revision conflict' using errcode='40001'; end if;
  for operation in select value from jsonb_array_elements(operations) order by (value->>'sequence')::bigint, value->>'operationId'
  loop
    if operation->>'action' <> 'restore' then
      result := public.apply_workspace_operations_before_restore(jsonb_build_array(operation),current_revision);
      current_revision := (result->>'revision')::bigint;
      conflicts := conflicts || coalesce(result->'conflicts','[]'::jsonb);
      outcome := result->'outcomes'->0;
      outcome := public.workspace_delete_receipt_alias(operation,outcome);
      outcomes := outcomes || jsonb_build_array(outcome);
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
    operation_id_value := (operation->>'operationId')::uuid;
    -- Never use the client snapshot for server records, ownership or identity.
    request_value := jsonb_set(operation,'{payload}',(operation->'payload')-'snapshot');
    select * into previous from public.workspace_restore_receipts r where r.user_id=owner_id and r.operation_id=operation_id_value;
    if found then
      outcome := previous.outcome;
      if previous.request <> request_value then
        outcome := jsonb_build_object('operationId',operation_id_value,'status','rejected','message','Restore operation identity was already used with a different request.');
      elsif outcome->>'status'='applied' then outcome := outcome || jsonb_build_object('status','already_applied');
      end if;
      outcomes := outcomes || jsonb_build_array(outcome);
      continue;
    end if;
    failure := null;
    if operation->'payload' ? 'deleteOperationId' then
      -- Older clients/read rebases could discard a redundant delete before
      -- Undo was queued. Repair that dependency with the SAME exact-root,
      -- owner and tombstone-generation proof, never the supplied snapshot.
      perform public.workspace_delete_receipt_alias(jsonb_build_object(
        'action','delete','entity',operation->>'entity','entityId',operation->>'entityId',
        'operationId',operation #>> '{payload,deleteOperationId}'),
        jsonb_build_object('operationId',operation #>> '{payload,deleteOperationId}','status','deleted'));
    end if;
    select t.* into trash from public.workspace_trash t where t.user_id=owner_id
      and (t.created_operation_id=(operation #>> '{payload,deleteOperationId}')::uuid
        or t.id=(operation #>> '{payload,trashId}')::uuid
        or t.id=(select a.trash_id from public.workspace_trash_operation_aliases a where a.user_id=owner_id and a.operation_id=(operation #>> '{payload,deleteOperationId}')::uuid))
      and t.root_type=operation->>'entity' and t.root_id=(operation->>'entityId')::uuid for update;
    if not found or trash.expires_at <= clock_timestamp() then
      failure := 'Recovery receipt unavailable. Review Trash before restoring again.';
    elsif trash.restored_at is not null then
      failure := 'Restore already completed. Refresh before moving the restored item.';
    elsif exists(select 1 from public.workspace_operations a where a.user_id=owner_id and a.operation_id=operation_id_value) then
      -- Legacy receipts predate request fingerprints. Reconcile without
      -- accepting a changed destination as a new write under the old identity.
      failure := 'Legacy restore was already applied. Refresh before moving the restored item.';
    else
      begin
        result := public.restore_workspace_trash(trash.id,(operation #>> '{payload,destinationId}')::uuid);
        if result->>'status'='destination_required' then failure := 'destination_required';
        else
          current_revision := (result->>'revision')::bigint;
          insert into public.workspace_operations(user_id,operation_id,device_id,sequence,applied_revision)
            values(owner_id,operation_id_value,(operation->>'deviceId')::uuid,(operation->>'sequence')::bigint,current_revision);
        end if;
      exception when sqlstate 'P0002' then failure := 'destination_required';
        when sqlstate '40001' then failure := 'Restore conflicts with existing records. Review the workspace.';
      end;
    end if;
    outcome := jsonb_build_object('operationId',operation_id_value,'status',case when failure is null then 'applied' else 'rejected' end);
    if failure is not null then outcome := outcome || jsonb_build_object('message',failure); end if;
    insert into public.workspace_restore_receipts(user_id,operation_id,request,outcome) values(owner_id,operation_id_value,request_value,outcome);
    outcomes := outcomes || jsonb_build_array(outcome);
  end loop;
  result := public.load_workspace_snapshot();
  return jsonb_build_object('revision',current_revision,'outcomes',outcomes,'patches',result->'snapshot',
    'tombstones',result->'tombstones','conflicts',conflicts);
end;
$$;
revoke all on function public.apply_workspace_operations(jsonb,bigint) from public,anon,service_role;
grant execute on function public.apply_workspace_operations(jsonb,bigint) to authenticated;
