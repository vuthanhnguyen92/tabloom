-- Reject stale deletion authority before strict processing can snapshot/delete
-- a newer restored generation. Retain definitive outcomes across lost responses.
create table public.workspace_delete_rejections (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  request jsonb not null,
  outcome jsonb not null,
  primary key(user_id,operation_id)
);
alter table public.workspace_delete_rejections enable row level security;
revoke all on public.workspace_delete_rejections from public,anon,authenticated,service_role;

alter function public.apply_workspace_operations_strict(jsonb,bigint) rename to apply_workspace_operations_before_delete_generation;
revoke all on function public.apply_workspace_operations_before_delete_generation(jsonb,bigint) from public,anon,authenticated,service_role;

create function public.apply_workspace_operations_strict(operations jsonb, expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  owner_id uuid := auth.uid(); current_revision bigint; restoration_revision bigint;
  operation jsonb; operation_id_value uuid; entity_id_value uuid; entity_type_value text;
  accepted jsonb := '[]'::jsonb; rejected jsonb := '[]'::jsonb;
  result jsonb; canonical jsonb; outcome jsonb;
  previous public.workspace_delete_rejections;
begin
  if owner_id is null then raise exception 'authentication required' using errcode='28000'; end if;
  if expected_revision is null or expected_revision<0 or jsonb_typeof(operations)<>'array'
    or jsonb_array_length(operations)>500 then raise exception 'invalid workspace operations' using errcode='22023'; end if;
  insert into public.workspace_sync_state(user_id,revision) values(owner_id,0) on conflict(user_id) do nothing;
  select revision into current_revision from public.workspace_sync_state where user_id=owner_id for update;
  if current_revision<>expected_revision then raise exception 'workspace revision conflict' using errcode='40001'; end if;
  for operation in select value from jsonb_array_elements(operations)
  loop
    if jsonb_typeof(operation)<>'object'
      or coalesce(operation->>'operationId','') !~* '^[0-9a-f-]{36}$'
      or coalesce(operation->>'deviceId','') !~* '^[0-9a-f-]{36}$'
      or coalesce(operation->>'entityId','') !~* '^[0-9a-f-]{36}$'
      or coalesce(operation->>'sequence','') !~ '^[1-9][0-9]*$'
      or jsonb_typeof(operation->'payload')<>'object'
    then raise exception 'invalid workspace operation' using errcode='22023'; end if;
    operation_id_value := (operation->>'operationId')::uuid;
    select * into previous from public.workspace_delete_rejections r where r.user_id=owner_id and r.operation_id=operation_id_value;
    if found then
      outcome := previous.outcome;
      if previous.request<>operation then outcome := jsonb_build_object('operationId',operation_id_value,'status','rejected','message','Delete identity was already rejected. Refresh and delete again with a new operation.'); end if;
      rejected := rejected || jsonb_build_array(outcome);
      continue;
    end if;
    -- A completed operation is a replay, even after restore. Let strict return
    -- already_applied and preserve its original Trash identity/deadline.
    if operation->>'action'='delete' and not exists(select 1 from public.workspace_operations a where a.user_id=owner_id and a.operation_id=operation_id_value) then
      entity_id_value := (operation->>'entityId')::uuid;
      entity_type_value := operation->>'entity';
      -- Only server lineage establishes authority. Include restored descendants
      -- so an old container approval cannot erase a newly restored child.
      select coalesce(max(g.restored_revision),0) into restoration_revision
      from public.workspace_entity_generations g where g.user_id=owner_id and (
        (g.entity_type=entity_type_value and g.entity_id=entity_id_value)
        or (entity_type_value='space' and g.entity_type='collection' and exists(select 1 from public.collections c where c.user_id=owner_id and c.space_id=entity_id_value and c.id=g.entity_id))
        or (entity_type_value in ('space','collection') and g.entity_type='link' and exists(select 1 from public.links l join public.collections c on c.id=l.collection_id and c.user_id=l.user_id
          where l.user_id=owner_id and l.id=g.entity_id and case entity_type_value when 'space' then c.space_id=entity_id_value else c.id=entity_id_value end))
      );
      if restoration_revision>0 and (case when coalesce(operation->>'baseRevision','') ~ '^[0-9]+$'
        then (operation->>'baseRevision')::numeric<restoration_revision else true end) then
        outcome := jsonb_build_object('operationId',operation_id_value,'status','rejected','message','Item was restored after this delete was queued. Refresh, review the restored item, and delete again if intended.');
        insert into public.workspace_delete_rejections(user_id,operation_id,request,outcome) values(owner_id,operation_id_value,operation,outcome);
        rejected := rejected || jsonb_build_array(outcome);
        continue;
      end if;
    end if;
    accepted := accepted || jsonb_build_array(operation);
  end loop;
  -- Keep ordinary writes in one strict batch and preserve its revision contract.
  result := public.apply_workspace_operations_before_delete_generation(accepted,expected_revision);
  if jsonb_array_length(rejected)=0 then return result; end if;
  canonical := public.load_workspace_snapshot();
  return result || jsonb_build_object(
    'outcomes',(select jsonb_agg(o.value order by (op.value->>'sequence')::bigint,op.value->>'operationId')
      from jsonb_array_elements((result->'outcomes') || rejected) o(value)
      join jsonb_array_elements(operations) op(value) on op.value->>'operationId'=o.value->>'operationId'),
    'patches',canonical->'snapshot','tombstones',canonical->'tombstones');
end;
$$;
revoke all on function public.apply_workspace_operations_strict(jsonb,bigint) from public,anon,authenticated,service_role;
