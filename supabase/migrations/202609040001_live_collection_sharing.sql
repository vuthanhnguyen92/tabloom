create table public.collection_shares (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  collection_id uuid not null,
  token text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint collection_shares_collection_owner_unique unique (collection_id, user_id),
  constraint collection_shares_collection_owner_fkey
    foreign key (collection_id, user_id)
    references public.collections(id, user_id)
    on delete cascade,
  constraint collection_shares_token_shape
    check (token ~ '^[A-Za-z0-9_-]{43}$')
);

create index collection_shares_owner_idx
  on public.collection_shares(user_id, collection_id);

alter table public.collection_shares enable row level security;

create policy "owners read collection shares" on public.collection_shares
  for select using (auth.uid() = user_id);

revoke all on table public.collection_shares from anon;
grant select on table public.collection_shares to authenticated;

create or replace function public.enable_collection_share(target_collection_id uuid)
returns table (
  collection_id uuid,
  token text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  owner_id uuid := auth.uid();
  generated_token text;
begin
  if owner_id is null or not exists (
    select 1
    from public.collections as owned_collection
    where owned_collection.id = target_collection_id
      and owned_collection.user_id = owner_id
  ) then
    raise exception 'collection not found' using errcode = 'P0001';
  end if;

  generated_token := translate(
    rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='),
    '+/',
    '-_'
  );

  return query
  insert into public.collection_shares as active_share (
    user_id,
    collection_id,
    token
  )
  values (
    owner_id,
    target_collection_id,
    generated_token
  )
  on conflict on constraint collection_shares_collection_owner_unique
  do update set collection_id = excluded.collection_id
  returning
    active_share.collection_id,
    active_share.token,
    active_share.created_at,
    active_share.updated_at;
end;
$$;

create or replace function public.regenerate_collection_share(target_collection_id uuid)
returns table (
  collection_id uuid,
  token text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  owner_id uuid := auth.uid();
  generated_token text;
begin
  if owner_id is null or not exists (
    select 1
    from public.collections as owned_collection
    where owned_collection.id = target_collection_id
      and owned_collection.user_id = owner_id
  ) then
    raise exception 'collection not found' using errcode = 'P0001';
  end if;

  generated_token := translate(
    rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='),
    '+/',
    '-_'
  );

  return query
  update public.collection_shares as active_share
  set token = generated_token,
      updated_at = now()
  where active_share.collection_id = target_collection_id
    and active_share.user_id = owner_id
  returning
    active_share.collection_id,
    active_share.token,
    active_share.created_at,
    active_share.updated_at;

  if not found then
    raise exception 'share not found' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.disable_collection_share(target_collection_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  owner_id uuid := auth.uid();
begin
  if owner_id is null or not exists (
    select 1
    from public.collections as owned_collection
    where owned_collection.id = target_collection_id
      and owned_collection.user_id = owner_id
  ) then
    raise exception 'collection not found' using errcode = 'P0001';
  end if;

  delete from public.collection_shares as active_share
  where active_share.collection_id = target_collection_id
    and active_share.user_id = owner_id;
end;
$$;

create or replace function public.load_shared_collection(share_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  snapshot jsonb;
begin
  if share_token is null or share_token !~ '^[A-Za-z0-9_-]{43}$' then
    return null;
  end if;

  select jsonb_build_object(
    'name', shared_collection.name,
    'links', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', saved_link.id,
            'title', saved_link.title,
            'description', saved_link.description,
            'url', saved_link.url,
            -- Public shares never auto-load captured remote resources. Some
            -- favicon URLs are signed or unique and can identify an owner or
            -- reveal recipient visits to a third party.
            'favicon_url', null,
            'position', saved_link.position
          )
          order by saved_link.position, saved_link.created_at, saved_link.id
        )
        from public.links as saved_link
        where saved_link.collection_id = shared_collection.id
          and saved_link.user_id = active_share.user_id
      ),
      '[]'::jsonb
    )
  )
  into snapshot
  from public.collection_shares as active_share
  join public.collections as shared_collection
    on shared_collection.id = active_share.collection_id
   and shared_collection.user_id = active_share.user_id
  where active_share.token = share_token;

  return snapshot;
end;
$$;

revoke all on function public.enable_collection_share(uuid) from public, anon;
revoke all on function public.regenerate_collection_share(uuid) from public, anon;
revoke all on function public.disable_collection_share(uuid) from public, anon;
revoke all on function public.load_shared_collection(text) from public;

grant execute on function public.enable_collection_share(uuid) to authenticated;
grant execute on function public.regenerate_collection_share(uuid) to authenticated;
grant execute on function public.disable_collection_share(uuid) to authenticated;
grant execute on function public.load_shared_collection(text) to anon, authenticated;
