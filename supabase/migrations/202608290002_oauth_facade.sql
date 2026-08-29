do $$
begin
  create role oauth_facade_owner
    nologin
    noinherit
    nosuperuser
    nocreatedb
    nocreaterole
    noreplication
    nobypassrls;
exception
  when duplicate_object then null;
end
$$;

alter role oauth_facade_owner
  nologin
  noinherit
  nosuperuser
  nocreatedb
  nocreaterole
  noreplication
  nobypassrls;

grant usage on schema public to oauth_facade_owner;

create table public.oauth_clients (
  client_id uuid primary key default gen_random_uuid(),
  client_name text not null check (char_length(btrim(client_name)) between 1 and 100),
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 10),
  token_endpoint_auth_method text not null default 'none'
    check (token_endpoint_auth_method = 'none'),
  grant_types text[] not null default array['authorization_code']::text[]
    check (grant_types = array['authorization_code']::text[]),
  response_types text[] not null default array['code']::text[]
    check (response_types = array['code']::text[]),
  created_at timestamptz not null default now(),
  expires_at timestamptz null check (expires_at is null or expires_at > created_at)
);

create table public.oauth_consumed_tokens (
  kind text not null check (kind in ('authorization_code', 'refresh_token')),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz not null default now(),
  primary key (kind, token_hash)
);

create index oauth_consumed_tokens_expiry_idx
  on public.oauth_consumed_tokens (expires_at);

create table public.oauth_revoked_grants (
  grant_hash text primary key check (grant_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz not null default now()
);

create index oauth_revoked_grants_expiry_idx
  on public.oauth_revoked_grants (expires_at);

alter table public.oauth_clients enable row level security;
alter table public.oauth_consumed_tokens enable row level security;
alter table public.oauth_revoked_grants enable row level security;

alter table public.oauth_clients owner to oauth_facade_owner;
alter table public.oauth_consumed_tokens owner to oauth_facade_owner;
alter table public.oauth_revoked_grants owner to oauth_facade_owner;

revoke all on table public.oauth_clients from public, anon, authenticated;
revoke all on table public.oauth_consumed_tokens from public, anon, authenticated;
revoke all on table public.oauth_revoked_grants from public, anon, authenticated;

create or replace function public.register_oauth_client(client_metadata jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  name_value text;
  redirect_values text[];
  expiry_value timestamptz;
  now_value timestamptz := clock_timestamp();
  stored public.oauth_clients%rowtype;
begin
  if jsonb_typeof(client_metadata) is distinct from 'object' then
    raise exception 'invalid OAuth client metadata' using errcode = '22023';
  end if;

  if not client_metadata ?& array['client_name', 'redirect_uris', 'expires_at']
    or (select count(*) from jsonb_object_keys(client_metadata)) <> 3
    or jsonb_typeof(client_metadata->'client_name') is distinct from 'string'
    or jsonb_typeof(client_metadata->'redirect_uris') is distinct from 'array'
    or jsonb_typeof(client_metadata->'expires_at') not in ('string', 'null')
  then
    raise exception 'invalid OAuth client metadata' using errcode = '22023';
  end if;

  name_value := client_metadata->>'client_name';
  if char_length(btrim(name_value)) not between 1 and 100 then
    raise exception 'invalid OAuth client metadata' using errcode = '22023';
  end if;

  if jsonb_array_length(client_metadata->'redirect_uris') not between 1 and 10
    or exists (
      select 1
      from jsonb_array_elements(client_metadata->'redirect_uris') item
      where jsonb_typeof(item) is distinct from 'string'
        or char_length(item #>> '{}') < 1
    )
  then
    raise exception 'invalid OAuth client metadata' using errcode = '22023';
  end if;

  select array_agg(item #>> '{}' order by ordinal)
    into redirect_values
  from jsonb_array_elements(client_metadata->'redirect_uris')
    with ordinality as redirect_item(item, ordinal);

  if cardinality(redirect_values) <> (
    select count(distinct redirect_uri)
    from unnest(redirect_values) redirect_uri
  ) then
    raise exception 'invalid OAuth client metadata' using errcode = '22023';
  end if;

  if jsonb_typeof(client_metadata->'expires_at') = 'string' then
    begin
      expiry_value := (client_metadata->>'expires_at')::timestamptz;
    exception
      when others then
        raise exception 'invalid OAuth client metadata' using errcode = '22023';
    end;
    if expiry_value <= now_value or expiry_value > now_value + interval '365 days' then
      raise exception 'invalid OAuth client metadata' using errcode = '22023';
    end if;
  end if;

  insert into public.oauth_clients (client_name, redirect_uris, expires_at)
  values (name_value, redirect_values, expiry_value)
  returning * into stored;

  return jsonb_build_object(
    'client_id', stored.client_id,
    'client_name', stored.client_name,
    'redirect_uris', to_jsonb(stored.redirect_uris),
    'created_at', stored.created_at,
    'expires_at', stored.expires_at
  );
end
$$;

create or replace function public.get_oauth_client(client_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'client_id', client.client_id,
    'client_name', client.client_name,
    'redirect_uris', to_jsonb(client.redirect_uris),
    'created_at', client.created_at,
    'expires_at', client.expires_at
  )
  from public.oauth_clients client
  where client.client_id = $1
    and (client.expires_at is null or client.expires_at > clock_timestamp())
$$;

create or replace function public.consume_oauth_token(
  token_hash text,
  token_kind text,
  expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  now_value timestamptz := clock_timestamp();
  affected_rows integer;
begin
  if token_hash is null
    or token_hash !~ '^[0-9a-f]{64}$'
    or token_kind is null
    or token_kind not in ('authorization_code', 'refresh_token')
    or expires_at is null
    or expires_at <= now_value
    or (token_kind = 'authorization_code' and expires_at > now_value + interval '2 minutes')
    or (token_kind = 'refresh_token' and expires_at > now_value + interval '30 days')
  then
    raise exception 'invalid OAuth token consumption' using errcode = '22023';
  end if;

  delete from public.oauth_consumed_tokens consumed
  where consumed.ctid in (
    select expired.ctid
    from public.oauth_consumed_tokens expired
    where expired.expires_at <= now_value
    order by expired.expires_at
    limit 100
  );

  insert into public.oauth_consumed_tokens (kind, token_hash, expires_at)
  values (token_kind, token_hash, expires_at)
  on conflict on constraint oauth_consumed_tokens_pkey do nothing;

  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end
$$;

create or replace function public.revoke_oauth_grant(
  grant_hash text,
  expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  now_value timestamptz := clock_timestamp();
begin
  if grant_hash is null
    or grant_hash !~ '^[0-9a-f]{64}$'
    or expires_at is null
    or expires_at <= now_value
    or expires_at > now_value + interval '30 days'
  then
    raise exception 'invalid OAuth grant revocation' using errcode = '22023';
  end if;

  delete from public.oauth_revoked_grants revoked
  where revoked.ctid in (
    select expired.ctid
    from public.oauth_revoked_grants expired
    where expired.expires_at <= now_value
    order by expired.expires_at
    limit 100
  );

  insert into public.oauth_revoked_grants (grant_hash, expires_at)
  values (grant_hash, expires_at)
  on conflict on constraint oauth_revoked_grants_pkey do update
    set expires_at = greatest(public.oauth_revoked_grants.expires_at, excluded.expires_at);
end
$$;

create or replace function public.is_oauth_grant_revoked(grant_hash text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if grant_hash is null or grant_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid OAuth grant lookup' using errcode = '22023';
  end if;

  return exists (
    select 1
    from public.oauth_revoked_grants revoked
    where revoked.grant_hash = $1
      and revoked.expires_at > clock_timestamp()
  );
end
$$;

alter function public.register_oauth_client(jsonb) owner to oauth_facade_owner;
alter function public.get_oauth_client(uuid) owner to oauth_facade_owner;
alter function public.consume_oauth_token(text, text, timestamptz) owner to oauth_facade_owner;
alter function public.revoke_oauth_grant(text, timestamptz) owner to oauth_facade_owner;
alter function public.is_oauth_grant_revoked(text) owner to oauth_facade_owner;

revoke all on function public.register_oauth_client(jsonb) from public, anon, authenticated;
revoke all on function public.get_oauth_client(uuid) from public, anon, authenticated;
revoke all on function public.consume_oauth_token(text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.revoke_oauth_grant(text, timestamptz) from public, anon, authenticated;
revoke all on function public.is_oauth_grant_revoked(text) from public, anon, authenticated;

grant execute on function public.register_oauth_client(jsonb) to anon;
grant execute on function public.get_oauth_client(uuid) to anon;
grant execute on function public.consume_oauth_token(text, text, timestamptz) to anon;
grant execute on function public.revoke_oauth_grant(text, timestamptz) to anon;
grant execute on function public.is_oauth_grant_revoked(text) to anon;
