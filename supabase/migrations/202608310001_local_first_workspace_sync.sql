create table public.workspace_operations (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  device_id uuid not null,
  sequence bigint not null check (sequence > 0),
  applied_revision bigint not null check (applied_revision >= 0),
  applied_at timestamptz not null default now(),
  primary key (user_id, operation_id)
);

create table public.workspace_tombstones (
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null check (entity_type in ('space', 'collection', 'link')),
  entity_id uuid not null,
  deleted_revision bigint not null check (deleted_revision >= 0),
  deleted_at timestamptz not null default now(),
  primary key (user_id, entity_type, entity_id)
);

create index workspace_operations_device_sequence_idx
  on public.workspace_operations(user_id, device_id, sequence);
create index workspace_tombstones_revision_idx
  on public.workspace_tombstones(user_id, deleted_revision);

alter table public.workspace_operations enable row level security;
alter table public.workspace_tombstones enable row level security;

create policy "owners read workspace operations"
on public.workspace_operations for select
using (auth.uid() = user_id);

create policy "owners read workspace tombstones"
on public.workspace_tombstones for select
using (auth.uid() = user_id);

grant select on public.workspace_operations to authenticated;
grant select on public.workspace_tombstones to authenticated;

create or replace function public.get_workspace_revision()
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
  current_revision bigint;
  server_time timestamptz := now();
begin
  if owner_id is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  insert into public.workspace_sync_state(user_id, revision)
  values (owner_id, 0)
  on conflict (user_id) do nothing;
  select revision into current_revision
  from public.workspace_sync_state
  where user_id = owner_id;
  return jsonb_build_object(
    'revision', current_revision,
    'serverTime', server_time
  );
end;
$$;

create or replace function public.load_workspace_snapshot()
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
  current_revision bigint;
begin
  if owner_id is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  insert into public.workspace_sync_state(user_id, revision)
  values (owner_id, 0)
  on conflict (user_id) do nothing;
  select revision into current_revision
  from public.workspace_sync_state
  where user_id = owner_id;
  return jsonb_build_object(
    'revision', current_revision,
    'snapshot', public.workspace_snapshot_json(owner_id),
    'tombstones', coalesce((
      select jsonb_agg(jsonb_build_object(
        'entity', entity_type,
        'entityId', entity_id,
        'deletedRevision', deleted_revision,
        'deletedAt', deleted_at
      ) order by deleted_revision, entity_type, entity_id)
      from public.workspace_tombstones
      where user_id = owner_id
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.apply_workspace_operations(
  operations jsonb,
  expected_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
<<sync_batch>>
declare
  owner_id uuid := auth.uid();
  current_revision bigint;
  resulting_revision bigint;
  operation jsonb;
  payload jsonb;
  operation_id uuid;
  device_id uuid;
  entity_id uuid;
  parent_id uuid;
  entity_type text;
  action_type text;
  sequence_value bigint;
  changed boolean := false;
  operation_changed boolean;
  outcomes jsonb := '[]'::jsonb;
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

  create temporary table if not exists tabloom_affected_spaces(id uuid primary key) on commit drop;
  create temporary table if not exists tabloom_affected_collections(id uuid primary key) on commit drop;
  create temporary table if not exists tabloom_affected_links(id uuid primary key) on commit drop;
  create temporary table if not exists tabloom_affected_link_parents(id uuid primary key) on commit drop;
  create temporary table if not exists tabloom_operations_to_record(
    operation_id uuid primary key,
    device_id uuid not null,
    sequence bigint not null
  ) on commit drop;
  truncate tabloom_affected_spaces, tabloom_affected_collections,
    tabloom_affected_links, tabloom_affected_link_parents,
    tabloom_operations_to_record;
  perform set_config('tabloom.merge_in_progress', 'on', true);

  for operation in
    select value
    from jsonb_array_elements(operations) value
    order by (value->>'sequence')::bigint, value->>'operationId'
  loop
    if jsonb_typeof(operation) <> 'object'
      or coalesce(operation->>'operationId', '') !~* '^[0-9a-f-]{36}$'
      or coalesce(operation->>'deviceId', '') !~* '^[0-9a-f-]{36}$'
      or coalesce(operation->>'entityId', '') !~* '^[0-9a-f-]{36}$'
      or coalesce(operation->>'sequence', '') !~ '^[1-9][0-9]*$'
      or jsonb_typeof(operation->'payload') <> 'object'
    then
      raise exception 'invalid workspace operation' using errcode = '22023';
    end if;

    operation_id := (operation->>'operationId')::uuid;
    device_id := (operation->>'deviceId')::uuid;
    entity_id := (operation->>'entityId')::uuid;
    sequence_value := (operation->>'sequence')::bigint;
    entity_type := operation->>'entity';
    action_type := operation->>'action';
    payload := operation->'payload';
    operation_changed := false;

    if exists (
      select 1 from public.workspace_operations applied
      where applied.user_id = owner_id and applied.operation_id = sync_batch.operation_id
    ) then
      outcomes := outcomes || jsonb_build_array(jsonb_build_object(
        'operationId', operation_id,
        'status', 'already_applied'
      ));
      continue;
    end if;

    if entity_type not in ('space', 'collection', 'link')
      or action_type not in ('create', 'update', 'delete', 'reorder')
      or payload ? 'user_id'
      or payload ? 'access_token'
      or payload ? 'refresh_token'
    then
      raise exception 'invalid workspace operation' using errcode = '22023';
    end if;

    if action_type <> 'reorder' and exists (
      select 1 from public.workspace_tombstones deleted
      where deleted.user_id = owner_id and deleted.entity_type = sync_batch.entity_type
        and deleted.entity_id = sync_batch.entity_id
    ) then
      outcomes := outcomes || jsonb_build_array(jsonb_build_object(
        'operationId', operation_id,
        'status', 'deleted'
      ));
      insert into tabloom_operations_to_record values(operation_id, device_id, sequence_value);
      continue;
    end if;

    if action_type = 'create' and payload->>'id' <> entity_id::text then
      raise exception 'invalid workspace operation id' using errcode = '22023';
    end if;

    if entity_type = 'space' then
      if action_type = 'create' then
        if length(trim(coalesce(payload->>'name', ''))) not between 1 and 80
          or coalesce(payload->>'color', '') !~ '^#[0-9a-fA-F]{6}$'
        then raise exception 'invalid workspace space' using errcode = '22023'; end if;
        if exists(select 1 from public.spaces where id = entity_id and user_id <> owner_id) then
          raise exception 'cross-owner workspace id' using errcode = '23503';
        end if;
        insert into public.spaces(id, user_id, name, color, position, created_at, updated_at)
        values (
          entity_id, owner_id, trim(payload->>'name'), payload->>'color',
          greatest(coalesce((payload->>'position')::integer, 0), 0),
          coalesce((payload->>'created_at')::timestamptz, now()),
          coalesce((payload->>'updated_at')::timestamptz, now())
        )
        on conflict (id) do update set
          name = excluded.name, color = excluded.color,
          position = excluded.position, updated_at = now()
        where spaces.user_id = owner_id;
        operation_changed := true;
      elsif action_type = 'update' then
        update public.spaces set
          name = coalesce(nullif(trim(payload->>'name'), ''), name),
          color = coalesce(nullif(payload->>'color', ''), color),
          updated_at = now()
        where user_id = owner_id and id = entity_id;
        if not found then raise exception 'workspace space not found' using errcode = 'P0002'; end if;
        operation_changed := true;
      elsif action_type = 'delete' then
        insert into tabloom_affected_collections(id)
          select id from public.collections where user_id = owner_id and space_id = entity_id
          on conflict do nothing;
        insert into tabloom_affected_links(id)
          select links.id from public.links join public.collections on collections.id = links.collection_id
          where links.user_id = owner_id and collections.space_id = entity_id
          on conflict do nothing;
        insert into public.workspace_tombstones(user_id, entity_type, entity_id, deleted_revision)
          select owner_id, 'link', id, current_revision + 1 from tabloom_affected_links
          on conflict on constraint workspace_tombstones_pkey do nothing;
        insert into public.workspace_tombstones(user_id, entity_type, entity_id, deleted_revision)
          select owner_id, 'collection', id, current_revision + 1 from tabloom_affected_collections
          on conflict on constraint workspace_tombstones_pkey do nothing;
        insert into public.workspace_tombstones(user_id, entity_type, entity_id, deleted_revision)
          values(owner_id, 'space', entity_id, current_revision + 1)
          on conflict on constraint workspace_tombstones_pkey do nothing;
        delete from public.spaces where user_id = owner_id and id = entity_id;
        if not found then raise exception 'workspace space not found' using errcode = 'P0002'; end if;
        operation_changed := true;
      else
        raise exception 'invalid space action' using errcode = '22023';
      end if;
      insert into tabloom_affected_spaces values(entity_id) on conflict do nothing;

    elsif entity_type = 'collection' then
      if action_type = 'create' then
        parent_id := (payload->>'space_id')::uuid;
        if length(trim(coalesce(payload->>'name', ''))) not between 1 and 80
          or not exists(select 1 from public.spaces where user_id = owner_id and id = parent_id)
        then raise exception 'invalid workspace collection' using errcode = '22023'; end if;
        if exists(select 1 from public.collections where id = entity_id and user_id <> owner_id) then
          raise exception 'cross-owner workspace id' using errcode = '23503';
        end if;
        insert into public.collections(id, user_id, space_id, name, position, created_at, updated_at)
        values (
          entity_id, owner_id, parent_id, trim(payload->>'name'),
          greatest(coalesce((payload->>'position')::integer, 0), 0),
          coalesce((payload->>'created_at')::timestamptz, now()),
          coalesce((payload->>'updated_at')::timestamptz, now())
        )
        on conflict (id) do update set
          space_id = excluded.space_id, name = excluded.name,
          position = excluded.position, updated_at = now()
        where collections.user_id = owner_id;
        operation_changed := true;
      elsif action_type = 'update' then
        update public.collections set
          name = coalesce(nullif(trim(payload->>'name'), ''), name),
          updated_at = now()
        where user_id = owner_id and id = entity_id;
        if not found then raise exception 'workspace collection not found' using errcode = 'P0002'; end if;
        operation_changed := true;
      elsif action_type = 'delete' then
        select space_id into parent_id from public.collections
        where user_id = owner_id and id = entity_id;
        if parent_id is null then raise exception 'workspace collection not found' using errcode = 'P0002'; end if;
        insert into tabloom_affected_links(id)
          select id from public.links where user_id = owner_id and collection_id = entity_id
          on conflict do nothing;
        insert into public.workspace_tombstones(user_id, entity_type, entity_id, deleted_revision)
          select owner_id, 'link', id, current_revision + 1 from tabloom_affected_links
          on conflict on constraint workspace_tombstones_pkey do nothing;
        insert into public.workspace_tombstones(user_id, entity_type, entity_id, deleted_revision)
          values(owner_id, 'collection', entity_id, current_revision + 1)
          on conflict on constraint workspace_tombstones_pkey do nothing;
        delete from public.collections where user_id = owner_id and id = entity_id;
        operation_changed := true;
      elsif action_type = 'reorder' then
        parent_id := (payload->>'parentId')::uuid;
        if not exists(select 1 from public.spaces where user_id = owner_id and id = parent_id)
          or jsonb_typeof(payload->'orderedIds') <> 'array'
        then raise exception 'invalid collection reorder' using errcode = '22023'; end if;
        update public.collections as row_value set
          space_id = parent_id,
          position = ordered.ordinality - 1,
          updated_at = now()
        from jsonb_array_elements_text(payload->'orderedIds') with ordinality ordered(id, ordinality)
        where row_value.user_id = owner_id and row_value.id = ordered.id::uuid;
        insert into tabloom_affected_collections(id)
          select value::uuid from jsonb_array_elements_text(payload->'orderedIds')
          on conflict do nothing;
        operation_changed := true;
      end if;
      insert into tabloom_affected_collections values(entity_id) on conflict do nothing;

    else
      if action_type = 'create' then
        parent_id := (payload->>'collection_id')::uuid;
        if public.normalize_workspace_url(coalesce(payload->>'url', '')) is null then
          raise exception 'unsupported workspace URL' using errcode = '22023';
        end if;
        if length(trim(coalesce(payload->>'title', ''))) not between 1 and 300
          or length(coalesce(payload->>'description', '')) > 1000
          or not exists(select 1 from public.collections where user_id = owner_id and id = parent_id)
        then raise exception 'invalid workspace link' using errcode = '22023'; end if;
        if exists(select 1 from public.links where id = entity_id and user_id <> owner_id) then
          raise exception 'cross-owner workspace id' using errcode = '23503';
        end if;
        insert into public.links(id, user_id, collection_id, url, title, description, favicon_url, position, created_at, updated_at)
        values (
          entity_id, owner_id, parent_id, payload->>'url', trim(payload->>'title'),
          coalesce(payload->>'description', ''), nullif(payload->>'favicon_url', ''),
          greatest(coalesce((payload->>'position')::integer, 0), 0),
          coalesce((payload->>'created_at')::timestamptz, now()),
          coalesce((payload->>'updated_at')::timestamptz, now())
        )
        on conflict (id) do update set
          collection_id = excluded.collection_id, url = excluded.url,
          title = excluded.title, description = excluded.description,
          favicon_url = excluded.favicon_url, position = excluded.position,
          updated_at = now()
        where links.user_id = owner_id;
        operation_changed := true;
      elsif action_type = 'update' then
        if payload ? 'url' and public.normalize_workspace_url(payload->>'url') is null then
          raise exception 'unsupported workspace URL' using errcode = '22023';
        end if;
        update public.links set
          collection_id = coalesce((payload->>'collection_id')::uuid, collection_id),
          url = coalesce(payload->>'url', url),
          title = coalesce(nullif(trim(payload->>'title'), ''), title),
          description = coalesce(payload->>'description', description),
          favicon_url = case when payload ? 'favicon_url' then nullif(payload->>'favicon_url', '') else favicon_url end,
          updated_at = now()
        where user_id = owner_id and id = entity_id;
        if not found then raise exception 'workspace link not found' using errcode = 'P0002'; end if;
        operation_changed := true;
      elsif action_type = 'delete' then
        select collection_id into parent_id from public.links
        where user_id = owner_id and id = entity_id;
        if parent_id is null then raise exception 'workspace link not found' using errcode = 'P0002'; end if;
        insert into public.workspace_tombstones(user_id, entity_type, entity_id, deleted_revision)
          values(owner_id, 'link', entity_id, current_revision + 1)
          on conflict on constraint workspace_tombstones_pkey do nothing;
        delete from public.links where user_id = owner_id and id = entity_id;
        operation_changed := true;
      elsif action_type = 'reorder' then
        parent_id := (payload->>'parentId')::uuid;
        if not exists(select 1 from public.collections where user_id = owner_id and id = parent_id)
          or jsonb_typeof(payload->'orderedIds') <> 'array'
        then raise exception 'invalid link reorder' using errcode = '22023'; end if;
        insert into tabloom_affected_link_parents(id)
          select distinct collection_id from public.links
          where user_id = owner_id and id in (
            select value::uuid from jsonb_array_elements_text(payload->'orderedIds')
          ) on conflict do nothing;
        update public.links as row_value set
          collection_id = parent_id,
          position = ordered.ordinality - 1,
          updated_at = now()
        from jsonb_array_elements_text(payload->'orderedIds') with ordinality ordered(id, ordinality)
        where row_value.user_id = owner_id and row_value.id = ordered.id::uuid;
        insert into tabloom_affected_links(id)
          select value::uuid from jsonb_array_elements_text(payload->'orderedIds')
          on conflict do nothing;
        operation_changed := true;
      end if;
      insert into tabloom_affected_links values(entity_id) on conflict do nothing;
      if parent_id is not null then insert into tabloom_affected_link_parents values(parent_id) on conflict do nothing; end if;
    end if;

    if operation_changed then changed := true; end if;
    outcomes := outcomes || jsonb_build_array(jsonb_build_object(
      'operationId', operation_id,
      'status', 'applied'
    ));
    insert into tabloom_operations_to_record values(operation_id, device_id, sequence_value);
  end loop;

  for parent_id in select id from tabloom_affected_link_parents loop
    with ordered as (
      select id, row_number() over(order by position, updated_at, id) - 1 as next_position
      from public.links where user_id = owner_id and collection_id = parent_id
    )
    update public.links set position = ordered.next_position
    from ordered where links.id = ordered.id and links.position <> ordered.next_position;
    insert into tabloom_affected_links(id)
      select id from public.links where user_id = owner_id and collection_id = parent_id
      on conflict do nothing;
  end loop;

  resulting_revision := current_revision + case when changed then 1 else 0 end;
  if changed then
    update public.workspace_sync_state
    set revision = resulting_revision, updated_at = now()
    where user_id = owner_id;
  end if;
  insert into public.workspace_operations(user_id, operation_id, device_id, sequence, applied_revision)
    select sync_batch.owner_id, queued.operation_id, queued.device_id, queued.sequence, sync_batch.resulting_revision
    from tabloom_operations_to_record queued
    on conflict on constraint workspace_operations_pkey do nothing;
  perform set_config('tabloom.merge_in_progress', 'off', true);

  return jsonb_build_object(
    'revision', resulting_revision,
    'outcomes', outcomes,
    'patches', jsonb_build_object(
      'spaces', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.position, row_value.id)
        from public.spaces row_value join tabloom_affected_spaces affected on affected.id = row_value.id
        where row_value.user_id = owner_id), '[]'::jsonb),
      'collections', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.position, row_value.id)
        from public.collections row_value join tabloom_affected_collections affected on affected.id = row_value.id
        where row_value.user_id = owner_id), '[]'::jsonb),
      'links', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.position, row_value.id)
        from public.links row_value join tabloom_affected_links affected on affected.id = row_value.id
        where row_value.user_id = owner_id), '[]'::jsonb)
    ),
    'tombstones', coalesce((select jsonb_agg(jsonb_build_object(
      'entity', tombstone.entity_type,
      'entityId', tombstone.entity_id,
      'deletedRevision', tombstone.deleted_revision,
      'deletedAt', tombstone.deleted_at
    ) order by tombstone.entity_type, tombstone.entity_id)
      from public.workspace_tombstones tombstone
      where tombstone.user_id = sync_batch.owner_id
        and tombstone.deleted_revision = sync_batch.resulting_revision), '[]'::jsonb),
    'conflicts', '[]'::jsonb
  );
end;
$$;

revoke all on function public.get_workspace_revision() from public, anon;
revoke all on function public.apply_workspace_operations(jsonb, bigint) from public, anon;
grant execute on function public.get_workspace_revision() to authenticated;
grant execute on function public.apply_workspace_operations(jsonb, bigint) to authenticated;
