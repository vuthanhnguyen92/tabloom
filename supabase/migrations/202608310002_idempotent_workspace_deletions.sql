alter function public.apply_workspace_operations(jsonb, bigint)
  rename to apply_workspace_operations_strict;

create function public.apply_workspace_operations(
  operations jsonb,
  expected_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
<<recovery_batch>>
declare
  owner_id uuid := auth.uid();
  current_revision bigint;
  result jsonb;
  operation jsonb;
  operation_id uuid;
  entity_id uuid;
  entity_type text;
  entity_exists boolean;
  recovered boolean := false;
begin
  if owner_id is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if expected_revision is null or expected_revision < 0 then
    raise exception 'expected revision must be non-negative' using errcode = '22023';
  end if;
  if jsonb_typeof(operations) <> 'array' or jsonb_array_length(operations) > 500 then
    raise exception 'invalid workspace operations' using errcode = '22023';
  end if;

  insert into public.workspace_sync_state(user_id, revision)
  values (owner_id, 0)
  on conflict (user_id) do nothing;
  select revision into current_revision
  from public.workspace_sync_state
  where user_id = owner_id
  for update;
  if current_revision <> expected_revision then
    raise exception 'workspace revision conflict' using errcode = '40001';
  end if;

  for operation in select value from jsonb_array_elements(operations) value loop
    if jsonb_typeof(operation) <> 'object'
      or operation->>'action' <> 'delete'
      or coalesce(operation->>'operationId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(operation->>'entityId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or (operation->>'entity') not in ('space', 'collection', 'link')
    then
      continue;
    end if;

    operation_id := (operation->>'operationId')::uuid;
    entity_id := (operation->>'entityId')::uuid;
    entity_type := operation->>'entity';

    if exists (
      select 1 from public.workspace_operations applied
      where applied.user_id = owner_id
        and applied.operation_id = recovery_batch.operation_id
    ) or exists (
      select 1 from public.workspace_tombstones deleted
      where deleted.user_id = owner_id
        and deleted.entity_type = recovery_batch.entity_type
        and deleted.entity_id = recovery_batch.entity_id
    ) then
      continue;
    end if;

    if (entity_type = 'space' and exists(select 1 from public.spaces where id = entity_id and user_id <> owner_id))
      or (entity_type = 'collection' and exists(select 1 from public.collections where id = entity_id and user_id <> owner_id))
      or (entity_type = 'link' and exists(select 1 from public.links where id = entity_id and user_id <> owner_id))
    then
      raise exception 'cross-owner workspace id' using errcode = '23503';
    end if;

    entity_exists := case entity_type
      when 'space' then exists(select 1 from public.spaces where id = entity_id and user_id = owner_id)
      when 'collection' then exists(select 1 from public.collections where id = entity_id and user_id = owner_id)
      else exists(select 1 from public.links where id = entity_id and user_id = owner_id)
    end;

    if not entity_exists then
      insert into public.workspace_tombstones(user_id, entity_type, entity_id, deleted_revision)
      values(owner_id, entity_type, entity_id, current_revision + 1)
      on conflict on constraint workspace_tombstones_pkey do nothing;
      recovered := true;
    end if;
  end loop;

  result := public.apply_workspace_operations_strict(operations, current_revision);

  if recovered and (result->>'revision')::bigint = current_revision then
    update public.workspace_sync_state
    set revision = current_revision + 1, updated_at = now()
    where user_id = owner_id;

    update public.workspace_operations applied
    set applied_revision = current_revision + 1
    where applied.user_id = owner_id
      and applied.operation_id in (
        select (value->>'operationId')::uuid
        from jsonb_array_elements(operations) value
        where value->>'action' = 'delete'
          and coalesce(value->>'operationId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      );

    result := jsonb_set(result, '{revision}', to_jsonb(current_revision + 1));
  end if;

  return result;
end;
$$;

revoke all on function public.apply_workspace_operations_strict(jsonb, bigint)
  from public, anon, authenticated;
revoke all on function public.apply_workspace_operations(jsonb, bigint)
  from public, anon;
grant execute on function public.apply_workspace_operations(jsonb, bigint)
  to authenticated;
