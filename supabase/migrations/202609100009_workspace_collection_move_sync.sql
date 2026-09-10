create table public.workspace_collection_move_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  request jsonb not null,
  outcome jsonb not null,
  primary key(user_id,operation_id)
);
alter table public.workspace_collection_move_receipts enable row level security;
revoke all on public.workspace_collection_move_receipts from public,anon,authenticated,service_role;

alter function public.apply_workspace_operations(jsonb,bigint) rename to apply_workspace_operations_before_collection_move;
revoke all on function public.apply_workspace_operations_before_collection_move(jsonb,bigint) from public,anon,authenticated,service_role;

create function public.apply_workspace_operations(operations jsonb, expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  owner_id uuid := auth.uid(); current_revision bigint;
  operation jsonb; operation_id_value uuid; collection_id_value uuid;
  source_id uuid; target_id uuid; current_parent uuid; target_count integer;
  result jsonb; outcome jsonb; outcomes jsonb := '[]'::jsonb; conflicts jsonb := '[]'::jsonb;
  previous public.workspace_collection_move_receipts;
  failure text; previous_merge_setting text; moved_at timestamptz;
begin
  if owner_id is null then raise exception 'authentication required' using errcode='28000'; end if;
  if expected_revision is null or expected_revision<0 or jsonb_typeof(operations)<>'array'
    or jsonb_array_length(operations)>500 then raise exception 'invalid workspace operations' using errcode='22023'; end if;
  if not exists(select 1 from jsonb_array_elements(operations) op where op->>'action'='move') then
    return public.apply_workspace_operations_before_collection_move(operations,expected_revision);
  end if;
  insert into public.workspace_sync_state(user_id,revision) values(owner_id,0) on conflict(user_id) do nothing;
  select revision into current_revision from public.workspace_sync_state where user_id=owner_id for update;
  if current_revision<>expected_revision then raise exception 'workspace revision conflict' using errcode='40001'; end if;
  for operation in select value from jsonb_array_elements(operations) order by (value->>'sequence')::bigint,value->>'operationId'
  loop
    if operation->>'action'<>'move' then
      result := public.apply_workspace_operations_before_collection_move(jsonb_build_array(operation),current_revision);
      outcomes := outcomes || (result->'outcomes'); conflicts := conflicts || coalesce(result->'conflicts','[]'::jsonb);
      current_revision := (result->>'revision')::bigint;
      continue;
    end if;
    if operation->>'entity'<>'collection' or jsonb_typeof(operation->'payload')<>'object'
      or coalesce(operation->>'operationId','') !~* '^[0-9a-f-]{36}$'
      or coalesce(operation->>'deviceId','') !~* '^[0-9a-f-]{36}$'
      or coalesce(operation->>'entityId','') !~* '^[0-9a-f-]{36}$'
      or coalesce(operation->>'sequence','') !~ '^[1-9][0-9]*$'
      or coalesce(operation #>> '{payload,sourceSpaceId}','') !~* '^[0-9a-f-]{36}$'
      or coalesce(operation #>> '{payload,destinationSpaceId}','') !~* '^[0-9a-f-]{36}$'
      or operation #>> '{payload,sourceSpaceId}'=operation #>> '{payload,destinationSpaceId}'
      or exists(select 1 from jsonb_object_keys(operation->'payload') key where key not in ('sourceSpaceId','destinationSpaceId'))
    then raise exception 'invalid collection move operation' using errcode='22023'; end if;
    operation_id_value := (operation->>'operationId')::uuid;
    collection_id_value := (operation->>'entityId')::uuid;
    source_id := (operation #>> '{payload,sourceSpaceId}')::uuid;
    target_id := (operation #>> '{payload,destinationSpaceId}')::uuid;
    select * into previous from public.workspace_collection_move_receipts r where r.user_id=owner_id and r.operation_id=operation_id_value;
    if found then
      outcome := previous.outcome;
      if previous.request<>operation then outcome := jsonb_build_object('operationId',operation_id_value,'status','rejected','message','Collection move identity was already used with a different request.');
      elsif outcome->>'status'='applied' then outcome := outcome || jsonb_build_object('status','already_applied'); end if;
      outcomes := outcomes || jsonb_build_array(outcome); continue;
    end if;
    failure := null;
    if exists(select 1 from public.workspace_operations a where a.user_id=owner_id and a.operation_id=operation_id_value) then
      failure := 'Collection move operation identity was already used.';
    else
      -- Parent locks serialize membership changes through FK checks. Row locks
      -- preserve concurrent content edits: only parent/order/timestamps change.
      perform 1 from public.spaces where user_id=owner_id and id in (source_id,target_id) order by id for update;
      if (select count(*) from public.spaces where user_id=owner_id and id in (source_id,target_id))<>2 then
        failure := 'Collection move destination is unavailable.';
      else
        select space_id into current_parent from public.collections where user_id=owner_id and id=collection_id_value for update;
        if not found or current_parent<>source_id then failure := 'Collection changed elsewhere. Refresh before moving.';
        else
          perform 1 from public.collections where user_id=owner_id and space_id in (source_id,target_id) order by id for update;
          previous_merge_setting := current_setting('tabloom.merge_in_progress',true);
          perform set_config('tabloom.merge_in_progress','on',true);
          moved_at := clock_timestamp();
          -- Compact both groups excluding the moved root, then append it. No
          -- upsert, descendant rewrite, or user-content snapshot is involved.
          with ordered as (
            select id,row_number() over(partition by space_id order by position,created_at,id)-1 as position
            from public.collections where user_id=owner_id and space_id in (source_id,target_id) and id<>collection_id_value
          ) update public.collections c set position=o.position,updated_at=greatest(moved_at,c.updated_at+interval '1 microsecond')
            from ordered o where c.user_id=owner_id and c.id=o.id and c.position<>o.position;
          select count(*) into target_count from public.collections where user_id=owner_id and space_id=target_id;
          update public.collections set space_id=target_id,position=target_count,updated_at=greatest(moved_at,updated_at+interval '1 microsecond')
            where user_id=owner_id and id=collection_id_value;
          current_revision := current_revision+1;
          update public.workspace_sync_state set revision=current_revision,updated_at=now() where user_id=owner_id;
          insert into public.workspace_operations(user_id,operation_id,device_id,sequence,applied_revision)
            values(owner_id,operation_id_value,(operation->>'deviceId')::uuid,(operation->>'sequence')::bigint,current_revision);
          perform set_config('tabloom.merge_in_progress',coalesce(previous_merge_setting,'off'),true);
        end if;
      end if;
    end if;
    outcome := jsonb_build_object('operationId',operation_id_value,'status',case when failure is null then 'applied' else 'rejected' end);
    if failure is not null then outcome := outcome || jsonb_build_object('message',failure); end if;
    insert into public.workspace_collection_move_receipts(user_id,operation_id,request,outcome) values(owner_id,operation_id_value,operation,outcome);
    outcomes := outcomes || jsonb_build_array(outcome);
  end loop;
  result := public.load_workspace_snapshot();
  return jsonb_build_object('revision',current_revision,'outcomes',outcomes,'patches',result->'snapshot','tombstones',result->'tombstones','conflicts',conflicts);
end;
$$;
revoke all on function public.apply_workspace_operations(jsonb,bigint) from public,anon,service_role;
grant execute on function public.apply_workspace_operations(jsonb,bigint) to authenticated;
