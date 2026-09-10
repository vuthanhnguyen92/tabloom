-- Validate delete authority at its ordered operation boundary. A preceding
-- reorder can move a restored descendant beneath a container that was empty
-- when the request began; preflighting every delete against the initial tree
-- would then erase that newer generation.
create or replace function public.apply_workspace_operations_strict(operations jsonb, expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  owner_id uuid := auth.uid(); current_revision bigint; restoration_revision bigint;
  operation jsonb; operation_id_value uuid; entity_id_value uuid; entity_type_value text;
  action_type_value text; parent_id_value uuid;
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

  -- Validate before casting sequence values in the ordered traversal.
  for operation in select value from jsonb_array_elements(operations)
  loop
    if jsonb_typeof(operation)<>'object'
      or coalesce(operation->>'operationId','') !~* '^[0-9a-f-]{36}$'
      or coalesce(operation->>'deviceId','') !~* '^[0-9a-f-]{36}$'
      or coalesce(operation->>'entityId','') !~* '^[0-9a-f-]{36}$'
      or coalesce(operation->>'sequence','') !~ '^[1-9][0-9]*$'
      or jsonb_typeof(operation->'payload')<>'object'
    then raise exception 'invalid workspace operation' using errcode='22023'; end if;
  end loop;

  create temporary table if not exists tabloom_delete_guard_spaces(
    id uuid primary key, restored_revision bigint not null
  ) on commit drop;
  create temporary table if not exists tabloom_delete_guard_collections(
    id uuid primary key, space_id uuid not null, restored_revision bigint not null
  ) on commit drop;
  create temporary table if not exists tabloom_delete_guard_links(
    id uuid primary key, collection_id uuid not null, restored_revision bigint not null
  ) on commit drop;
  truncate tabloom_delete_guard_spaces, tabloom_delete_guard_collections, tabloom_delete_guard_links;
  insert into tabloom_delete_guard_spaces
    select s.id,coalesce(g.restored_revision,0) from public.spaces s
    left join public.workspace_entity_generations g on g.user_id=s.user_id and g.entity_type='space' and g.entity_id=s.id
    where s.user_id=owner_id;
  insert into tabloom_delete_guard_collections
    select c.id,c.space_id,coalesce(g.restored_revision,0) from public.collections c
    left join public.workspace_entity_generations g on g.user_id=c.user_id and g.entity_type='collection' and g.entity_id=c.id
    where c.user_id=owner_id;
  insert into tabloom_delete_guard_links
    select l.id,l.collection_id,coalesce(g.restored_revision,0) from public.links l
    left join public.workspace_entity_generations g on g.user_id=l.user_id and g.entity_type='link' and g.entity_id=l.id
    where l.user_id=owner_id;

  for operation in select value from jsonb_array_elements(operations)
    order by (value->>'sequence')::bigint,value->>'operationId'
  loop
    operation_id_value := (operation->>'operationId')::uuid;
    entity_id_value := (operation->>'entityId')::uuid;
    entity_type_value := operation->>'entity';
    action_type_value := operation->>'action';
    select * into previous from public.workspace_delete_rejections r where r.user_id=owner_id and r.operation_id=operation_id_value;
    if found then
      outcome := previous.outcome;
      if previous.request<>operation then outcome := jsonb_build_object('operationId',operation_id_value,'status','rejected','message','Delete identity was already rejected. Refresh and delete again with a new operation.'); end if;
      rejected := rejected || jsonb_build_array(outcome);
      continue;
    end if;
    -- Replays and operations suppressed by an existing tombstone do not alter
    -- the virtual membership seen by a later delete in this request.
    if exists(select 1 from public.workspace_operations a where a.user_id=owner_id and a.operation_id=operation_id_value)
      or (action_type_value<>'reorder' and exists(select 1 from public.workspace_tombstones t where t.user_id=owner_id and t.entity_type=entity_type_value and t.entity_id=entity_id_value))
    then
      accepted := accepted || jsonb_build_array(operation);
      continue;
    end if;

    if action_type_value='delete' then
      select coalesce(max(candidate.revision),0) into restoration_revision from (
        select s.restored_revision as revision from tabloom_delete_guard_spaces s
          where entity_type_value='space' and s.id=entity_id_value
        union all select c.restored_revision from tabloom_delete_guard_collections c
          where (entity_type_value='collection' and c.id=entity_id_value)
             or (entity_type_value='space' and c.space_id=entity_id_value)
        union all select l.restored_revision from tabloom_delete_guard_links l
          left join tabloom_delete_guard_collections c on c.id=l.collection_id
          where (entity_type_value='link' and l.id=entity_id_value)
             or (entity_type_value='collection' and l.collection_id=entity_id_value)
             or (entity_type_value='space' and c.space_id=entity_id_value)
      ) candidate;
      if restoration_revision>0 and (case when coalesce(operation->>'baseRevision','') ~ '^[0-9]+$'
        then (operation->>'baseRevision')::numeric<restoration_revision else true end) then
        outcome := jsonb_build_object('operationId',operation_id_value,'status','rejected','message','Item was restored after this delete was queued. Refresh, review the restored item, and delete again if intended.');
        insert into public.workspace_delete_rejections(user_id,operation_id,request,outcome) values(owner_id,operation_id_value,operation,outcome);
        rejected := rejected || jsonb_build_array(outcome);
        continue;
      end if;
    end if;

    accepted := accepted || jsonb_build_array(operation);
    -- Advance only the membership projection needed by later delete checks.
    if action_type_value='create' and entity_type_value='space' then
      insert into tabloom_delete_guard_spaces values(entity_id_value,coalesce((select restored_revision from public.workspace_entity_generations where user_id=owner_id and entity_type='space' and entity_id=entity_id_value),0))
        on conflict(id) do update set restored_revision=excluded.restored_revision;
    elsif action_type_value='create' and entity_type_value='collection' and coalesce(operation #>> '{payload,space_id}','') ~* '^[0-9a-f-]{36}$' then
      parent_id_value := (operation #>> '{payload,space_id}')::uuid;
      insert into tabloom_delete_guard_collections values(entity_id_value,parent_id_value,coalesce((select restored_revision from public.workspace_entity_generations where user_id=owner_id and entity_type='collection' and entity_id=entity_id_value),0))
        on conflict(id) do update set space_id=excluded.space_id,restored_revision=excluded.restored_revision;
    elsif action_type_value='create' and entity_type_value='link' and coalesce(operation #>> '{payload,collection_id}','') ~* '^[0-9a-f-]{36}$' then
      parent_id_value := (operation #>> '{payload,collection_id}')::uuid;
      insert into tabloom_delete_guard_links values(entity_id_value,parent_id_value,coalesce((select restored_revision from public.workspace_entity_generations where user_id=owner_id and entity_type='link' and entity_id=entity_id_value),0))
        on conflict(id) do update set collection_id=excluded.collection_id,restored_revision=excluded.restored_revision;
    elsif action_type_value='update' and entity_type_value='link' and coalesce(operation #>> '{payload,collection_id}','') ~* '^[0-9a-f-]{36}$' then
      update tabloom_delete_guard_links set collection_id=(operation #>> '{payload,collection_id}')::uuid where id=entity_id_value;
    elsif action_type_value='reorder' and entity_type_value='link'
      and coalesce(operation #>> '{payload,parentId}','') ~* '^[0-9a-f-]{36}$'
      and jsonb_typeof(operation #> '{payload,orderedIds}')='array'
      and not exists(select 1 from jsonb_array_elements_text(operation #> '{payload,orderedIds}') item(value) where value !~* '^[0-9a-f-]{36}$')
    then
      update tabloom_delete_guard_links set collection_id=(operation #>> '{payload,parentId}')::uuid
        where id in (select value::uuid from jsonb_array_elements_text(operation #> '{payload,orderedIds}'));
    elsif action_type_value='delete' and entity_type_value='space' then
      delete from tabloom_delete_guard_links l using tabloom_delete_guard_collections c where l.collection_id=c.id and c.space_id=entity_id_value;
      delete from tabloom_delete_guard_collections where space_id=entity_id_value;
      delete from tabloom_delete_guard_spaces where id=entity_id_value;
    elsif action_type_value='delete' and entity_type_value='collection' then
      delete from tabloom_delete_guard_links where collection_id=entity_id_value;
      delete from tabloom_delete_guard_collections where id=entity_id_value;
    elsif action_type_value='delete' and entity_type_value='link' then
      delete from tabloom_delete_guard_links where id=entity_id_value;
    end if;
  end loop;

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
