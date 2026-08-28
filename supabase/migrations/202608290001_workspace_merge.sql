create table public.workspace_sync_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);

alter table public.workspace_sync_state enable row level security;

create policy "owners read workspace sync state"
on public.workspace_sync_state for select
using (auth.uid() = user_id);

create policy "owners create workspace sync state"
on public.workspace_sync_state for insert
with check (auth.uid() = user_id);

create policy "owners update workspace sync state"
on public.workspace_sync_state for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

grant select, insert, update on public.workspace_sync_state to authenticated;

create or replace function public.normalize_workspace_name(value text)
returns text
language sql
immutable
strict
set search_path = public
as $$
  select lower(regexp_replace(trim(normalize(value, NFC)), '\s+', ' ', 'g'))
$$;

create or replace function public.normalize_workspace_url(value text)
returns text
language plpgsql
immutable
strict
set search_path = public
as $$
declare
  parts text[];
  scheme text;
  authority text;
  path_value text;
begin
  parts := regexp_match(
    trim(value),
    '^(https?)://([^/?#]+)([^?#]*)?(\?[^#]*)?(#.*)?$',
    'i'
  );
  if parts is null then return null; end if;

  scheme := lower(parts[1]);
  authority := lower(parts[2]);
  if scheme = 'https' then authority := regexp_replace(authority, ':443$', ''); end if;
  if scheme = 'http' then authority := regexp_replace(authority, ':80$', ''); end if;
  path_value := coalesce(nullif(parts[3], ''), '/');
  return scheme || '://' || authority || path_value || coalesce(parts[4], '') || coalesce(parts[5], '');
end;
$$;

create or replace function public.workspace_uuid_or_null(value text)
returns uuid
language plpgsql
immutable
set search_path = public
as $$
begin
  return value::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

create or replace function public.workspace_snapshot_json(owner_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'spaces', coalesce((
      select jsonb_agg(to_jsonb(row_value) order by row_value.position, row_value.created_at, row_value.id)
      from public.spaces row_value
      where row_value.user_id = owner_id
    ), '[]'::jsonb),
    'collections', coalesce((
      select jsonb_agg(to_jsonb(row_value) order by row_value.position, row_value.created_at, row_value.id)
      from public.collections row_value
      where row_value.user_id = owner_id
    ), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(to_jsonb(row_value) order by row_value.position, row_value.created_at, row_value.id)
      from public.links row_value
      where row_value.user_id = owner_id
    ), '[]'::jsonb)
  )
$$;

create or replace function public.bump_workspace_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner_id uuid;
begin
  if current_setting('tabloom.merge_in_progress', true) = 'on' then
    return coalesce(new, old);
  end if;
  owner_id := coalesce(new.user_id, old.user_id);
  insert into public.workspace_sync_state(user_id, revision, updated_at)
  values (owner_id, 1, now())
  on conflict (user_id) do update
    set revision = public.workspace_sync_state.revision + 1,
        updated_at = now();
  return coalesce(new, old);
end;
$$;

create trigger spaces_bump_workspace_revision
after insert or update or delete on public.spaces
for each row execute function public.bump_workspace_revision();

create trigger collections_bump_workspace_revision
after insert or update or delete on public.collections
for each row execute function public.bump_workspace_revision();

create trigger links_bump_workspace_revision
after insert or update or delete on public.links
for each row execute function public.bump_workspace_revision();

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
    'snapshot', public.workspace_snapshot_json(owner_id)
  );
end;
$$;

create or replace function public.merge_workspace_snapshot(
  local_snapshot jsonb,
  expected_revision bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
  current_revision bigint;
  item jsonb;
  local_id text;
  candidate_id uuid;
  target_id uuid;
  parent_id uuid;
  normalized_name text;
  normalized_url text;
  next_position integer;
  added_spaces integer := 0;
  added_collections integer := 0;
  added_links integer := 0;
  matched_spaces integer := 0;
  matched_collections integer := 0;
  matched_links_by_id integer := 0;
  matched_links_by_url integer := 0;
  remapped_ids integer := 0;
  identity_map jsonb;
begin
  if owner_id is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if expected_revision is null or expected_revision < 0 then
    raise exception 'expected revision must be non-negative' using errcode = '22023';
  end if;
  if jsonb_typeof(local_snapshot) <> 'object'
    or jsonb_typeof(local_snapshot->'spaces') <> 'array'
    or jsonb_typeof(local_snapshot->'collections') <> 'array'
    or jsonb_typeof(local_snapshot->'links') <> 'array'
  then
    raise exception 'invalid workspace snapshot' using errcode = '22023';
  end if;

  for item in select value from jsonb_array_elements(local_snapshot->'spaces') value loop
    if jsonb_typeof(item) <> 'object'
      or length(trim(coalesce(item->>'name', ''))) not between 1 and 80
      or coalesce(item->>'color', '#f56f72') !~ '^#[0-9a-fA-F]{6}$'
    then raise exception 'invalid workspace space' using errcode = '22023'; end if;
  end loop;
  for item in select value from jsonb_array_elements(local_snapshot->'collections') value loop
    if jsonb_typeof(item) <> 'object'
      or length(trim(coalesce(item->>'name', ''))) not between 1 and 80
      or nullif(item->>'space_id', '') is null
    then raise exception 'invalid workspace collection' using errcode = '22023'; end if;
  end loop;
  for item in select value from jsonb_array_elements(local_snapshot->'links') value loop
    if jsonb_typeof(item) <> 'object'
      or nullif(item->>'collection_id', '') is null
      or public.normalize_workspace_url(coalesce(item->>'url', '')) is null
      or length(trim(coalesce(item->>'title', ''))) not between 1 and 300
      or length(coalesce(item->>'description', '')) > 1000
    then raise exception 'unsupported workspace URL' using errcode = '22023'; end if;
  end loop;

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

  create temporary table if not exists tabloom_space_map(
    local_id text primary key,
    cloud_id uuid not null
  ) on commit drop;
  create temporary table if not exists tabloom_collection_map(
    local_id text primary key,
    cloud_id uuid not null
  ) on commit drop;
  create temporary table if not exists tabloom_link_map(
    local_id text primary key,
    cloud_id uuid not null
  ) on commit drop;
  truncate tabloom_space_map, tabloom_collection_map, tabloom_link_map;

  perform set_config('tabloom.merge_in_progress', 'on', true);

  for item in
    select value
    from jsonb_array_elements(local_snapshot->'spaces') value
    order by coalesce((value->>'position')::integer, 0), coalesce(value->>'created_at', ''), value->>'id'
  loop
    local_id := coalesce(item->>'id', '');
    candidate_id := public.workspace_uuid_or_null(local_id);
    normalized_name := public.normalize_workspace_name(item->>'name');
    target_id := null;

    if candidate_id is not null then
      select id into target_id from public.spaces
      where user_id = owner_id and id = candidate_id
        and public.normalize_workspace_name(name) = normalized_name;
    end if;
    if target_id is null then
      select id into target_id from public.spaces
      where user_id = owner_id and public.normalize_workspace_name(name) = normalized_name
      order by position, created_at, id limit 1;
    end if;

    if target_id is not null then
      matched_spaces := matched_spaces + 1;
    else
      if candidate_id is null or exists(select 1 from public.spaces where id = candidate_id) then
        candidate_id := gen_random_uuid();
        remapped_ids := remapped_ids + 1;
      end if;
      select coalesce(max(position), -1) + 1 into next_position
      from public.spaces where user_id = owner_id;
      insert into public.spaces(id, user_id, name, color, position, created_at, updated_at)
      values (
        candidate_id,
        owner_id,
        trim(item->>'name'),
        coalesce(item->>'color', '#f56f72'),
        next_position,
        coalesce((item->>'created_at')::timestamptz, now()),
        coalesce((item->>'updated_at')::timestamptz, now())
      );
      target_id := candidate_id;
      added_spaces := added_spaces + 1;
    end if;
    insert into tabloom_space_map(local_id, cloud_id) values(local_id, target_id);
  end loop;

  for item in
    select value
    from jsonb_array_elements(local_snapshot->'collections') value
    order by coalesce((value->>'position')::integer, 0), coalesce(value->>'created_at', ''), value->>'id'
  loop
    local_id := coalesce(item->>'id', '');
    select map.cloud_id into parent_id
    from tabloom_space_map map
    where map.local_id = item->>'space_id';
    if parent_id is null then
      raise exception 'workspace collection references an unknown space' using errcode = '23503';
    end if;
    candidate_id := public.workspace_uuid_or_null(local_id);
    normalized_name := public.normalize_workspace_name(item->>'name');
    target_id := null;

    if candidate_id is not null then
      select id into target_id from public.collections
      where user_id = owner_id and id = candidate_id and space_id = parent_id
        and public.normalize_workspace_name(name) = normalized_name;
    end if;
    if target_id is null then
      select id into target_id from public.collections
      where user_id = owner_id and space_id = parent_id
        and public.normalize_workspace_name(name) = normalized_name
      order by position, created_at, id limit 1;
    end if;

    if target_id is not null then
      matched_collections := matched_collections + 1;
    else
      if candidate_id is null or exists(select 1 from public.collections where id = candidate_id) then
        candidate_id := gen_random_uuid();
        remapped_ids := remapped_ids + 1;
      end if;
      select coalesce(max(position), -1) + 1 into next_position
      from public.collections where user_id = owner_id and space_id = parent_id;
      insert into public.collections(id, user_id, space_id, name, position, created_at, updated_at)
      values (
        candidate_id,
        owner_id,
        parent_id,
        trim(item->>'name'),
        next_position,
        coalesce((item->>'created_at')::timestamptz, now()),
        coalesce((item->>'updated_at')::timestamptz, now())
      );
      target_id := candidate_id;
      added_collections := added_collections + 1;
    end if;
    insert into tabloom_collection_map(local_id, cloud_id) values(local_id, target_id);
  end loop;

  for item in
    select value
    from jsonb_array_elements(local_snapshot->'links') value
    order by coalesce((value->>'position')::integer, 0), coalesce(value->>'created_at', ''), value->>'id'
  loop
    local_id := coalesce(item->>'id', '');
    select map.cloud_id into parent_id
    from tabloom_collection_map map
    where map.local_id = item->>'collection_id';
    if parent_id is null then
      raise exception 'workspace link references an unknown collection' using errcode = '23503';
    end if;
    candidate_id := public.workspace_uuid_or_null(local_id);
    normalized_url := public.normalize_workspace_url(item->>'url');
    target_id := null;

    if candidate_id is not null then
      select id into target_id from public.links
      where user_id = owner_id and id = candidate_id;
    end if;
    if target_id is not null then
      matched_links_by_id := matched_links_by_id + 1;
    else
      select id into target_id from public.links
      where user_id = owner_id and collection_id = parent_id
        and public.normalize_workspace_url(url) = normalized_url
      order by position, created_at, id limit 1;
      if target_id is not null then matched_links_by_url := matched_links_by_url + 1; end if;
    end if;

    if target_id is not null then
      update public.links
      set title = case when trim(title) = '' then trim(item->>'title') else title end,
          description = case when trim(description) = '' then coalesce(item->>'description', '') else description end,
          favicon_url = case when nullif(trim(coalesce(favicon_url, '')), '') is null then nullif(trim(coalesce(item->>'favicon_url', '')), '') else favicon_url end,
          updated_at = now()
      where user_id = owner_id and id = target_id;
    else
      if candidate_id is null or exists(select 1 from public.links where id = candidate_id) then
        candidate_id := gen_random_uuid();
        remapped_ids := remapped_ids + 1;
      end if;
      select coalesce(max(position), -1) + 1 into next_position
      from public.links where user_id = owner_id and collection_id = parent_id;
      insert into public.links(id, user_id, collection_id, url, title, description, favicon_url, position, created_at, updated_at)
      values (
        candidate_id,
        owner_id,
        parent_id,
        item->>'url',
        trim(item->>'title'),
        coalesce(item->>'description', ''),
        nullif(trim(coalesce(item->>'favicon_url', '')), ''),
        next_position,
        coalesce((item->>'created_at')::timestamptz, now()),
        coalesce((item->>'updated_at')::timestamptz, now())
      );
      target_id := candidate_id;
      added_links := added_links + 1;
    end if;
    insert into tabloom_link_map(local_id, cloud_id) values(local_id, target_id);
  end loop;

  update public.workspace_sync_state
  set revision = revision + 1, updated_at = now()
  where user_id = owner_id
  returning revision into current_revision;
  perform set_config('tabloom.merge_in_progress', 'off', true);

  identity_map := jsonb_build_object(
    'spaces', coalesce((select jsonb_object_agg(map.local_id, map.cloud_id) from tabloom_space_map map), '{}'::jsonb),
    'collections', coalesce((select jsonb_object_agg(map.local_id, map.cloud_id) from tabloom_collection_map map), '{}'::jsonb),
    'links', coalesce((select jsonb_object_agg(map.local_id, map.cloud_id) from tabloom_link_map map), '{}'::jsonb)
  );

  return jsonb_build_object(
    'revision', current_revision,
    'snapshot', public.workspace_snapshot_json(owner_id),
    'identityMap', identity_map,
    'summary', jsonb_build_object(
      'addedSpaces', added_spaces,
      'addedCollections', added_collections,
      'addedLinks', added_links,
      'matchedSpaces', matched_spaces,
      'matchedCollections', matched_collections,
      'matchedLinksById', matched_links_by_id,
      'matchedLinksByUrl', matched_links_by_url,
      'remappedIds', remapped_ids,
      'skippedUnsupportedLinks', 0
    )
  );
end;
$$;

revoke all on function public.load_workspace_snapshot() from public, anon;
revoke all on function public.merge_workspace_snapshot(jsonb, bigint) from public, anon;
grant execute on function public.load_workspace_snapshot() to authenticated;
grant execute on function public.merge_workspace_snapshot(jsonb, bigint) to authenticated;
