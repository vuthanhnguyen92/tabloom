-- Immutable command responses outlive later edits and Trash operations.
create table public.workspace_command_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  command_name text not null,
  command_hash text not null check (command_hash ~ '^[0-9a-f]{64}$'),
  response jsonb not null check (jsonb_typeof(response) = 'object'),
  created_at timestamptz not null default now(),
  primary key (user_id, operation_id)
);
alter table public.workspace_command_receipts enable row level security;
create policy "owners read workspace command receipts"
  on public.workspace_command_receipts for select using (auth.uid() = user_id);
revoke all on public.workspace_command_receipts from public, anon, authenticated, service_role;
grant select on public.workspace_command_receipts to authenticated;

create function public.apply_workspace_command(
  p_operation_id uuid,
  p_command_name text,
  p_command_hash text,
  p_operations jsonb,
  p_expected_revision bigint
)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
  current_revision bigint;
  previous public.workspace_command_receipts%rowtype;
  result jsonb;
  response_snapshot jsonb;
  first_operation jsonb;
  operation_count integer;
  expected_entity text;
  expected_action text;
  root_id uuid;
  collection_id_value uuid;
  space_id_value uuid;
  source_collection_id uuid;
  destination_collection_id uuid;
begin
  if owner_id is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_operation_id is null or p_command_hash is null or p_command_hash !~ '^[0-9a-f]{64}$'
    or p_command_name is null or p_command_name not in (
      'createSpace','updateSpace','createCollection','updateCollection',
      'createCollectionItem','updateCollectionItem','moveCollectionItem','reorderCollectionItems')
    or p_expected_revision is null or p_expected_revision < 0
    or p_operations is null or jsonb_typeof(p_operations) <> 'array'
  then raise exception 'invalid workspace command' using errcode='22023'; end if;

  -- Match the sync lock ordering. The mutation and its receipt commit together;
  -- concurrent retries observe the receipt before checking an obsolete revision.
  insert into public.workspace_sync_state(user_id,revision) values(owner_id,0) on conflict(user_id) do nothing;
  select revision into current_revision from public.workspace_sync_state where user_id=owner_id for update;
  select * into previous from public.workspace_command_receipts
    where user_id=owner_id and operation_id=p_operation_id;
  if found then
    if previous.command_hash <> p_command_hash or previous.command_name <> p_command_name then
      raise exception 'workspace command idempotency conflict' using errcode='40001';
    end if;
    return previous.response;
  end if;
  if current_revision <> p_expected_revision then
    raise exception 'workspace revision conflict' using errcode='40001';
  end if;

  operation_count := jsonb_array_length(p_operations);
  first_operation := p_operations->0;
  expected_entity := case when p_command_name in ('createSpace','updateSpace') then 'space'
    when p_command_name in ('createCollection','updateCollection') then 'collection' else 'link' end;
  expected_action := case when p_command_name in ('createSpace','createCollection','createCollectionItem') then 'create'
    when p_command_name='reorderCollectionItems' then 'reorder' else 'update' end;
  if operation_count not between 1 and 3
    or (first_operation->>'operationId')::uuid is distinct from p_operation_id
    or first_operation->>'entity' is distinct from expected_entity
    or first_operation->>'action' is distinct from expected_action
    or (p_command_name <> 'moveCollectionItem' and operation_count <> 1)
    or exists(select 1 from jsonb_array_elements(p_operations) with ordinality op(value,seq)
      where (op.value->>'sequence')::bigint is distinct from op.seq)
    or (select count(distinct op->>'operationId') from jsonb_array_elements(p_operations) op) <> operation_count
  then raise exception 'invalid workspace command' using errcode='22023'; end if;
  root_id := (first_operation->>'entityId')::uuid;
  if root_id is null then raise exception 'invalid workspace command' using errcode='22023'; end if;

  if exists(select 1 from public.workspace_operations applied
    join jsonb_array_elements(p_operations) op on applied.operation_id=(op->>'operationId')::uuid
    where applied.user_id=owner_id)
  then raise exception 'workspace command idempotency conflict' using errcode='40001'; end if;

  if p_command_name='moveCollectionItem' then
    select collection_id into source_collection_id from public.links where user_id=owner_id and id=root_id;
    if not found then raise exception 'workspace link not found' using errcode='P0002'; end if;
    destination_collection_id := (first_operation #>> '{payload,collection_id}')::uuid;
    if (first_operation->'payload') - 'collection_id' <> '{}'::jsonb
      or operation_count <> (case when source_collection_id=destination_collection_id then 2 else 3 end)
      or exists(select 1 from jsonb_array_elements(p_operations) with ordinality op(value,seq)
        where op.seq > 1 and (op.value->>'entity' is distinct from 'link' or op.value->>'action' is distinct from 'reorder'))
      or (p_operations #>> '{1,payload,parentId}')::uuid is distinct from source_collection_id
      or (p_operations->(operation_count-1) #>> '{payload,parentId}')::uuid is distinct from destination_collection_id
    then raise exception 'invalid workspace move' using errcode='22023'; end if;
  end if;

  result := public.apply_workspace_operations(p_operations,p_expected_revision);
  if exists(select 1 from jsonb_array_elements(result->'outcomes') outcome where outcome->>'status' <> 'applied') then
    raise exception 'workspace command target unavailable' using errcode='40001';
  end if;

  -- Persist only result rows and their ancestors, not the entire workspace.
  if expected_entity='space' then
    space_id_value := root_id;
  elsif expected_entity='collection' then
    collection_id_value := root_id;
  elsif p_command_name='reorderCollectionItems' then
    collection_id_value := (first_operation #>> '{payload,parentId}')::uuid;
  else
    select collection_id into collection_id_value from public.links where user_id=owner_id and id=root_id;
  end if;
  if collection_id_value is not null then
    select space_id into space_id_value from public.collections where user_id=owner_id and id=collection_id_value;
  end if;
  if space_id_value is null or not exists(select 1 from public.spaces where user_id=owner_id and id=space_id_value) then
    raise exception 'workspace command target unavailable' using errcode='P0002';
  end if;
  response_snapshot := jsonb_build_object(
    'spaces', (select jsonb_agg(to_jsonb(s)||'{"origin":"saved","read_only":false}'::jsonb)
      from public.spaces s where s.user_id=owner_id and s.id=space_id_value),
    'collections', coalesce((select jsonb_agg(to_jsonb(c)||'{"origin":"saved","read_only":false}'::jsonb)
      from public.collections c where c.user_id=owner_id and c.id=collection_id_value),'[]'::jsonb),
    'links', coalesce((select jsonb_agg(to_jsonb(l)||'{"origin":"saved","read_only":false,"device_label":null}'::jsonb order by l.position,l.id)
      from public.links l where l.user_id=owner_id and expected_entity='link'
        and ((p_command_name='reorderCollectionItems' and l.collection_id=collection_id_value)
          or (p_command_name<>'reorderCollectionItems' and l.id=root_id))),'[]'::jsonb)
  );
  result := jsonb_build_object('revision',result->'revision','snapshot',response_snapshot);
  insert into public.workspace_command_receipts(user_id,operation_id,command_name,command_hash,response)
    values(owner_id,p_operation_id,p_command_name,p_command_hash,result);
  return result;
end;
$$;
revoke all on function public.apply_workspace_command(uuid,text,text,jsonb,bigint) from public,anon,service_role;
grant execute on function public.apply_workspace_command(uuid,text,text,jsonb,bigint) to authenticated;
