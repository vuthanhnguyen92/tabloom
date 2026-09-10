-- Provenance survives source deletion; deleting a copy releases its deduplication key.
create table public.collection_saved_copies (
  user_id uuid not null references auth.users(id) on delete cascade,
  source_collection_id uuid not null,
  saved_collection_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_id, source_collection_id),
  unique (saved_collection_id),
  foreign key (saved_collection_id, user_id)
    references public.collections(id, user_id) on delete cascade
);
alter table public.collection_saved_copies enable row level security;
create policy "owners read saved copies" on public.collection_saved_copies
  for select using (auth.uid() = user_id);
revoke all on public.collection_saved_copies from public, anon, authenticated;
grant select on public.collection_saved_copies to authenticated;

create function public.get_shared_collection_save_state(share_token text)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  recipient_id uuid := auth.uid();
  result jsonb;
begin
  if recipient_id is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if share_token is null or share_token !~ '^[A-Za-z0-9_-]{43}$' then
    return jsonb_build_object('status', 'unavailable');
  end if;
  select case
    when source.user_id = recipient_id then
      jsonb_build_object('status', 'owned', 'collectionId', source.id, 'spaceId', source.space_id)
    when saved.id is not null then
      jsonb_build_object('status', 'saved', 'collectionId', saved.id, 'spaceId', saved.space_id)
    else jsonb_build_object('status', 'available')
  end into result
  from public.collection_shares active
  join public.collections source on source.id = active.collection_id and source.user_id = active.user_id
  left join public.collection_saved_copies provenance
    on provenance.user_id = recipient_id and provenance.source_collection_id = source.id
  left join public.collections saved
    on saved.id = provenance.saved_collection_id and saved.user_id = recipient_id
  where active.token = share_token;
  return coalesce(result, jsonb_build_object('status', 'unavailable'));
end;
$$;

create function public.save_shared_collection(share_token text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  recipient_id uuid := auth.uid();
  source_id uuid;
  source_owner_id uuid;
  destination_id uuid;
  copied_id uuid;
  captured_snapshot jsonb;
  next_position integer;
begin
  if recipient_id is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if share_token is null or share_token !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'shared collection unavailable' using errcode = 'P0002';
  end if;

  -- Use the same serialization boundary as apply_workspace_operations and merge.
  insert into public.workspace_sync_state(user_id, revision) values (recipient_id, 0)
    on conflict (user_id) do nothing;
  perform 1 from public.workspace_sync_state where user_id = recipient_id for update;

  -- Hold the token until commit so revocation/regeneration cannot split the save.
  select source.id, source.user_id, source.space_id
    into source_id, source_owner_id, destination_id
  from public.collection_shares active
  join public.collections source on source.id = active.collection_id and source.user_id = active.user_id
  where active.token = share_token
  for share of active;
  if not found then
    raise exception 'shared collection unavailable' using errcode = 'P0002';
  end if;
  if source_owner_id = recipient_id then
    return jsonb_build_object('status', 'owned', 'collectionId', source_id, 'spaceId', destination_id);
  end if;

  select saved.id, saved.space_id into copied_id, destination_id
  from public.collection_saved_copies provenance
  join public.collections saved on saved.id = provenance.saved_collection_id and saved.user_id = recipient_id
  where provenance.user_id = recipient_id and provenance.source_collection_id = source_id;
  if found then
    return jsonb_build_object('status', 'saved', 'collectionId', copied_id, 'spaceId', destination_id);
  end if;

  -- One statement supplies a coherent MVCC snapshot of both name and links.
  select jsonb_build_object('name', source.name, 'links', coalesce((
    select jsonb_agg(jsonb_build_object(
      'url', link.url, 'title', link.title, 'description', link.description
    ) order by link.position, link.created_at, link.id)
    from public.links link where link.collection_id = source.id and link.user_id = source_owner_id
  ), '[]'::jsonb)) into captured_snapshot
  from public.collections source where source.id = source_id and source.user_id = source_owner_id;
  if not found then
    raise exception 'shared collection unavailable' using errcode = 'P0002';
  end if;

  select id into destination_id from public.spaces where user_id = recipient_id
    order by position, created_at, id limit 1;
  if not found then
    insert into public.spaces(user_id, name, color, position)
      values (recipient_id, 'My collections', '#f56f72', 0) returning id into destination_id;
  end if;
  select coalesce(max(position) + 1, 0) into next_position from public.collections
    where user_id = recipient_id and space_id = destination_id;
  insert into public.collections(user_id, space_id, name, position)
    values (recipient_id, destination_id, captured_snapshot->>'name', next_position)
    returning id into copied_id;
  insert into public.links(user_id, collection_id, url, title, description, favicon_url, position)
    select recipient_id, copied_id, item->>'url', item->>'title', item->>'description', null,
      (ordinality - 1)::integer
    from jsonb_array_elements(captured_snapshot->'links') with ordinality entries(item, ordinality);
  insert into public.collection_saved_copies(user_id, source_collection_id, saved_collection_id)
    values (recipient_id, source_id, copied_id);
  return jsonb_build_object('status', 'created', 'collectionId', copied_id, 'spaceId', destination_id);
end;
$$;

revoke all on function public.get_shared_collection_save_state(text) from public, anon;
revoke all on function public.save_shared_collection(text) from public, anon;
grant execute on function public.get_shared_collection_save_state(text) to authenticated;
grant execute on function public.save_shared_collection(text) to authenticated;
