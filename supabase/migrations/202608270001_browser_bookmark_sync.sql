create table public.bookmark_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_key text not null check (char_length(device_key) between 16 and 200),
  device_name text not null check (char_length(device_name) between 1 and 80),
  next_generation bigint not null default 0 check (next_generation >= 0),
  active_run_id uuid,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, device_key),
  unique (user_id, id)
);

create table public.bookmark_sync_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null,
  generation bigint not null check (generation > 0),
  status text not null check (status in ('staging', 'active', 'superseded', 'failed', 'abandoned')),
  expected_entry_count integer not null check (expected_entry_count >= 0),
  entry_count integer not null default 0 check (entry_count >= 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (user_id, source_id, id),
  unique (source_id, generation),
  constraint bookmark_sync_runs_source_owner_fk foreign key (user_id, source_id)
    references public.bookmark_sources(user_id, id) on delete cascade
);

create table public.bookmark_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null,
  run_id uuid not null,
  chrome_bookmark_id text not null check (char_length(chrome_bookmark_id) between 1 and 500),
  url text not null check (url ~* '^https?://'),
  normalized_url text not null check (normalized_url ~* '^https?://'),
  title text not null check (char_length(title) between 1 and 300),
  folder_path text not null check (char_length(folder_path) between 1 and 1000),
  syncing boolean,
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),
  unique (run_id, chrome_bookmark_id),
  constraint bookmark_entries_source_owner_fk foreign key (user_id, source_id)
    references public.bookmark_sources(user_id, id) on delete cascade,
  constraint bookmark_entries_run_owner_fk foreign key (user_id, source_id, run_id)
    references public.bookmark_sync_runs(user_id, source_id, id) on delete cascade
);

alter table public.bookmark_sources
  add constraint bookmark_sources_active_run_fk
  foreign key (user_id, id, active_run_id)
  references public.bookmark_sync_runs(user_id, source_id, id)
  deferrable initially deferred;

create index bookmark_sources_owner_sync_idx on public.bookmark_sources(user_id, last_synced_at desc);
create index bookmark_runs_source_generation_idx on public.bookmark_sync_runs(user_id, source_id, generation desc);
create index bookmark_entries_active_read_idx on public.bookmark_entries(user_id, run_id, folder_path, position);

alter table public.bookmark_sources enable row level security;
alter table public.bookmark_sync_runs enable row level security;
alter table public.bookmark_entries enable row level security;

create policy "owners manage bookmark sources" on public.bookmark_sources
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owners manage bookmark sync runs" on public.bookmark_sync_runs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owners manage bookmark entries" on public.bookmark_entries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.begin_bookmark_sync(
  p_device_key text,
  p_device_name text,
  p_expected_entry_count integer
)
returns table(run_id uuid, source_id uuid, generation bigint)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_source_id uuid;
  v_generation bigint;
  v_run_id uuid;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if char_length(trim(p_device_key)) not between 16 and 200 then raise exception 'Invalid device key' using errcode = '22023'; end if;
  if char_length(trim(p_device_name)) not between 1 and 80 then raise exception 'Invalid device name' using errcode = '22023'; end if;
  if p_expected_entry_count < 0 then raise exception 'Invalid expected entry count' using errcode = '22023'; end if;

  insert into public.bookmark_sources(user_id, device_key, device_name)
  values (v_user_id, trim(p_device_key), trim(p_device_name))
  on conflict (user_id, device_key) do update
    set device_name = excluded.device_name, updated_at = now();

  select id into v_source_id
  from public.bookmark_sources
  where user_id = v_user_id and device_key = trim(p_device_key)
  for update;

  update public.bookmark_sync_runs as r
  set status = 'abandoned'
  where r.user_id = v_user_id and r.source_id = v_source_id and r.status = 'staging';

  update public.bookmark_sources as s
  set next_generation = next_generation + 1, updated_at = now()
  where s.user_id = v_user_id and s.id = v_source_id
  returning s.next_generation into v_generation;

  insert into public.bookmark_sync_runs(user_id, source_id, generation, status, expected_entry_count)
  values (v_user_id, v_source_id, v_generation, 'staging', p_expected_entry_count)
  returning id into v_run_id;

  return query select v_run_id, v_source_id, v_generation;
end;
$$;

create or replace function public.append_bookmark_sync_batch(p_run_id uuid, p_entries jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_source_id uuid;
  v_count integer;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if jsonb_typeof(p_entries) <> 'array' then raise exception 'Entries must be an array' using errcode = '22023'; end if;

  select source_id into v_source_id
  from public.bookmark_sync_runs
  where id = p_run_id and user_id = v_user_id and status = 'staging'
  for update;
  if v_source_id is null then raise exception 'Staging sync run not found' using errcode = 'P0002'; end if;

  insert into public.bookmark_entries(
    user_id, source_id, run_id, chrome_bookmark_id, url, normalized_url,
    title, folder_path, syncing, position
  )
  select
    v_user_id,
    v_source_id,
    p_run_id,
    item->>'chrome_bookmark_id',
    item->>'url',
    item->>'normalized_url',
    coalesce(nullif(item->>'title', ''), item->>'url'),
    item->>'folder_path',
    case when jsonb_typeof(item->'syncing') = 'boolean' then (item->>'syncing')::boolean else null end,
    (item->>'position')::integer
  from jsonb_array_elements(p_entries) item
  on conflict (run_id, chrome_bookmark_id) do update set
    url = excluded.url,
    normalized_url = excluded.normalized_url,
    title = excluded.title,
    folder_path = excluded.folder_path,
    syncing = excluded.syncing,
    position = excluded.position;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.finalize_bookmark_sync(p_run_id uuid)
returns table(
  source_id uuid,
  generation bigint,
  bookmark_count integer,
  collection_count integer,
  synced_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_run public.bookmark_sync_runs%rowtype;
  v_active_generation bigint;
  v_entry_count integer;
  v_collection_count integer;
  v_synced_at timestamptz := now();
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode = '42501'; end if;

  select * into v_run
  from public.bookmark_sync_runs
  where id = p_run_id and user_id = v_user_id and status = 'staging'
  for update;
  if not found then raise exception 'Staging sync run not found' using errcode = 'P0002'; end if;

  perform 1 from public.bookmark_sources
  where id = v_run.source_id and user_id = v_user_id
  for update;

  select count(*)::integer, count(distinct folder_path)::integer
  into v_entry_count, v_collection_count
  from public.bookmark_entries
  where user_id = v_user_id and run_id = p_run_id;

  if v_entry_count <> v_run.expected_entry_count then
    raise exception 'Expected % entries but received %', v_run.expected_entry_count, v_entry_count using errcode = '22000';
  end if;

  select r.generation into v_active_generation
  from public.bookmark_sources s
  join public.bookmark_sync_runs r on r.id = s.active_run_id
  where s.id = v_run.source_id and s.user_id = v_user_id;

  if v_active_generation is not null and v_active_generation >= v_run.generation then
    raise exception 'A newer bookmark generation is already active' using errcode = '40001';
  end if;

  update public.bookmark_sync_runs
  set status = 'superseded'
  where id = (
    select active_run_id from public.bookmark_sources
    where id = v_run.source_id and user_id = v_user_id
  );

  update public.bookmark_sync_runs
  set status = 'active', entry_count = v_entry_count, completed_at = v_synced_at
  where id = p_run_id and user_id = v_user_id;

  update public.bookmark_sources
  set active_run_id = p_run_id, last_synced_at = v_synced_at, updated_at = v_synced_at
  where id = v_run.source_id and user_id = v_user_id;

  return query select v_run.source_id, v_run.generation, v_entry_count, v_collection_count, v_synced_at;
end;
$$;

create or replace function public.rename_bookmark_source(p_source_id uuid, p_device_name text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if char_length(trim(p_device_name)) not between 1 and 80 then raise exception 'Invalid device name' using errcode = '22023'; end if;
  update public.bookmark_sources
  set device_name = trim(p_device_name), updated_at = now()
  where id = p_source_id and user_id = auth.uid();
  if not found then raise exception 'Bookmark source not found' using errcode = 'P0002'; end if;
end;
$$;

create or replace function public.forget_bookmark_source(p_source_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  update public.bookmark_sources set active_run_id = null
  where id = p_source_id and user_id = auth.uid();
  if not found then raise exception 'Bookmark source not found' using errcode = 'P0002'; end if;
  delete from public.bookmark_sources where id = p_source_id and user_id = auth.uid();
end;
$$;

create or replace function public.cleanup_bookmark_sync_runs(p_retention interval default interval '7 days')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.bookmark_sync_runs r
  where r.status in ('superseded', 'failed', 'abandoned')
    and r.created_at < now() - p_retention
    and not exists (select 1 from public.bookmark_sources s where s.active_run_id = r.id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.cleanup_bookmark_sync_runs(interval) from public, anon, authenticated;
grant execute on function public.begin_bookmark_sync(text, text, integer) to authenticated;
grant execute on function public.append_bookmark_sync_batch(uuid, jsonb) to authenticated;
grant execute on function public.finalize_bookmark_sync(uuid) to authenticated;
grant execute on function public.rename_bookmark_source(uuid, text) to authenticated;
grant execute on function public.forget_bookmark_source(uuid) to authenticated;
