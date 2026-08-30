begin;

-- Fail closed if a previously provisioned owner has already been granted to
-- any principal. PostgreSQL 17 may automatically grant a newly created role
-- to its creator, so this check intentionally runs before CREATE ROLE.
do $$
begin
  if exists (
    select 1
    from pg_auth_members membership
    join pg_roles parent_role on parent_role.oid = membership.roleid
    where parent_role.rolname = 'oauth_facade_owner'
  ) then
    raise exception 'OAuth facade owner has unsafe role memberships';
  end if;
end
$$;

do $$
begin
  create role oauth_facade_owner
    nologin
    noinherit
    nocreatedb
    nocreaterole;
exception
  when duplicate_object then null;
end
$$;

alter role oauth_facade_owner
  nologin
  noinherit
  nocreatedb
  nocreaterole;

do $$
begin
  if exists (
    select 1
    from pg_roles
    where rolname = 'oauth_facade_owner'
      and (
        rolsuper
        or rolcreatedb
        or rolcreaterole
        or rolcanlogin
        or rolinherit
        or rolreplication
        or rolbypassrls
      )
  ) then
    raise exception 'OAuth facade owner has unsafe role attributes';
  end if;
end
$$;

-- Membership is needed only while assigning object ownership. GRANT is safe
-- whether PostgreSQL already added creator membership or not, and the
-- membership is revoked again before this transaction commits.
do $$
begin
  execute format('grant oauth_facade_owner to %I', current_user);
end
$$;

grant usage on schema extensions to oauth_facade_owner;

-- Supabase owns public through pg_database_owner and grants USAGE to PUBLIC.
-- Managed postgres must assume that owner role to grant the temporary CREATE
-- privilege PostgreSQL requires while transferring public object ownership.
set local role pg_database_owner;
grant create on schema public to oauth_facade_owner;
reset role;

do $$
begin
  if not has_schema_privilege('oauth_facade_owner', 'public', 'usage') then
    raise exception 'OAuth facade owner cannot use schema public';
  end if;
end
$$;

create schema oauth_private authorization oauth_facade_owner;
revoke all on schema oauth_private from public, anon, authenticated, service_role;

create table public.oauth_clients (
  client_id uuid primary key default gen_random_uuid(),
  client_name text not null
    check (char_length(client_name) between 1 and 100)
    check (octet_length(client_name) <= 400)
    check (client_name = btrim(client_name))
    check (client_name !~ '[[:cntrl:]]'),
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 10),
  token_endpoint_auth_method text not null default 'none'
    check (token_endpoint_auth_method = 'none'),
  grant_types text[] not null default array['authorization_code']::text[]
    check (grant_types = array['authorization_code']::text[]),
  response_types text[] not null default array['code']::text[]
    check (response_types = array['code']::text[]),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null
    check (expires_at > created_at)
    check (expires_at <= created_at + interval '7 days')
);

create index oauth_clients_expiry_idx on public.oauth_clients (expires_at);
create index oauth_clients_created_idx on public.oauth_clients (created_at);

create table public.oauth_consumed_tokens (
  kind text not null check (kind in ('authorization_code', 'refresh_token')),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz not null default clock_timestamp(),
  primary key (kind, token_hash),
  check (expires_at > consumed_at),
  check (
    (kind = 'authorization_code' and expires_at <= consumed_at + interval '2 minutes')
    or (kind = 'refresh_token' and expires_at <= consumed_at + interval '30 days')
  )
);

create index oauth_consumed_tokens_expiry_idx
  on public.oauth_consumed_tokens (expires_at);

create table public.oauth_revoked_grants (
  grant_hash text primary key check (grant_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz not null default clock_timestamp(),
  check (expires_at > revoked_at),
  check (expires_at <= revoked_at + interval '30 days')
);

create index oauth_revoked_grants_expiry_idx
  on public.oauth_revoked_grants (expires_at);

create table oauth_private.facade_secret (
  singleton boolean primary key default true check (singleton),
  secret bytea not null check (octet_length(secret) = 32),
  updated_at timestamptz not null default clock_timestamp()
);

create table oauth_private.mutation_nonces (
  nonce_hash bytea primary key check (octet_length(nonce_hash) = 32),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  check (expires_at > created_at),
  check (expires_at <= created_at + interval '2 minutes')
);

create index oauth_mutation_nonces_expiry_idx
  on oauth_private.mutation_nonces (expires_at);

alter table public.oauth_clients enable row level security;
alter table public.oauth_consumed_tokens enable row level security;
alter table public.oauth_revoked_grants enable row level security;
alter table oauth_private.facade_secret enable row level security;
alter table oauth_private.mutation_nonces enable row level security;

alter table public.oauth_clients owner to oauth_facade_owner;
alter table public.oauth_consumed_tokens owner to oauth_facade_owner;
alter table public.oauth_revoked_grants owner to oauth_facade_owner;
alter table oauth_private.facade_secret owner to oauth_facade_owner;
alter table oauth_private.mutation_nonces owner to oauth_facade_owner;

revoke all on table public.oauth_clients from public, anon, authenticated, service_role;
revoke all on table public.oauth_consumed_tokens from public, anon, authenticated, service_role;
revoke all on table public.oauth_revoked_grants from public, anon, authenticated, service_role;
revoke all on table oauth_private.facade_secret from public, anon, authenticated, service_role;
revoke all on table oauth_private.mutation_nonces from public, anon, authenticated, service_role;

create or replace function oauth_private.frame_text(value text)
returns text
language sql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
  select octet_length(convert_to(value, 'UTF8'))::text || ':' || value
$$;

create or replace function oauth_private.canonical_timestamp(value timestamptz)
returns text
language sql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
  select to_char(value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

create or replace function oauth_private.valid_redirect_uri(value text)
returns boolean
language plpgsql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
declare
  port_match text[];
  port_value integer;
begin
  if octet_length(convert_to(value, 'UTF8')) not between 1 and 2048
    or value ~ '[[:space:]#*]'
  then
    return false;
  end if;

  if value ~* '^https://([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?(?:/[^#[:space:]]*)?(?:\?[^#[:space:]]*)?$' then
    port_match := regexp_match(value, '^https://(?:[^/:]+|\[[^]]+\]):([0-9]{1,5})(?:/|\?|$)', 'i');
  elsif value ~ '^http://(127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?(?:/[^#[:space:]]*)?(?:\?[^#[:space:]]*)?$' then
    port_match := regexp_match(value, '^http://(?:127\.0\.0\.1|\[::1\]):([0-9]{1,5})(?:/|\?|$)');
  else
    return false;
  end if;

  if port_match is not null then
    port_value := port_match[1]::integer;
    if port_value not between 1 and 65535 then
      return false;
    end if;
  end if;
  return true;
exception
  when others then return false;
end
$$;

create or replace function oauth_private.secure_equal(left_value bytea, right_value bytea)
returns boolean
language plpgsql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
declare
  difference integer := 0;
  index_value integer;
begin
  if octet_length(left_value) <> octet_length(right_value) then
    return false;
  end if;
  for index_value in 0 .. octet_length(left_value) - 1 loop
    difference := difference | (get_byte(left_value, index_value) # get_byte(right_value, index_value));
  end loop;
  return difference = 0;
end
$$;

create or replace function oauth_private.validate_mutation_proof(
  action_value text,
  canonical_payload text,
  timestamp_value bigint,
  nonce_value text,
  signature_value text
)
returns void
language plpgsql
set search_path = pg_catalog, extensions, oauth_private, pg_temp
as $$
declare
  now_value timestamptz := clock_timestamp();
  secret_value bytea;
  expected_signature bytea;
  supplied_signature bytea;
begin
  if action_value not in ('register_oauth_client', 'consume_oauth_token', 'revoke_oauth_grant')
    or timestamp_value is null
    or to_timestamp(timestamp_value::double precision) < now_value - interval '30 seconds'
    or to_timestamp(timestamp_value::double precision) > now_value + interval '5 seconds'
    or nonce_value !~ '^[A-Za-z0-9_-]{43}$'
    or signature_value !~ '^[A-Za-z0-9_-]{43}$'
  then
    raise exception 'invalid OAuth mutation proof' using errcode = '42501';
  end if;

  select configured.secret into strict secret_value
  from oauth_private.facade_secret configured
  where configured.singleton;

  expected_signature := extensions.hmac(
    convert_to(
      'tabloom-oauth-rpc-v1' || chr(10)
        || action_value || chr(10)
        || canonical_payload || chr(10)
        || timestamp_value::text || chr(10)
        || nonce_value,
      'UTF8'
    ),
    secret_value,
    'sha256'
  );
  supplied_signature := decode(translate(signature_value, '-_', '+/') || '=', 'base64');

  if not oauth_private.secure_equal(expected_signature, supplied_signature) then
    raise exception 'invalid OAuth mutation proof' using errcode = '42501';
  end if;

  delete from oauth_private.mutation_nonces used
  where used.ctid in (
    select expired.ctid
    from oauth_private.mutation_nonces expired
    where expired.expires_at <= now_value
    order by expired.expires_at
    limit 100
  );

  insert into oauth_private.mutation_nonces (nonce_hash, expires_at)
  values (extensions.digest(convert_to(nonce_value, 'UTF8'), 'sha256'), now_value + interval '2 minutes');
exception
  when others then
    raise exception 'invalid OAuth mutation proof' using errcode = '42501';
end
$$;

create or replace function public.register_oauth_client(
  client_metadata jsonb,
  proof_timestamp bigint,
  proof_nonce text,
  proof_signature text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  name_value text;
  redirect_values text[];
  expiry_text text;
  expiry_value timestamptz;
  now_value timestamptz := clock_timestamp();
  canonical_payload text;
  stored public.oauth_clients%rowtype;
begin
  if jsonb_typeof(client_metadata) is distinct from 'object'
    or not client_metadata ?& array['client_name', 'redirect_uris', 'expires_at']
    or (select count(*) from jsonb_object_keys(client_metadata)) <> 3
    or jsonb_typeof(client_metadata->'client_name') is distinct from 'string'
    or jsonb_typeof(client_metadata->'redirect_uris') is distinct from 'array'
    or jsonb_typeof(client_metadata->'expires_at') is distinct from 'string'
  then
    raise exception 'invalid OAuth client metadata' using errcode = '22023';
  end if;

  name_value := client_metadata->>'client_name';
  expiry_text := client_metadata->>'expires_at';
  if char_length(name_value) not between 1 and 100
    or octet_length(convert_to(name_value, 'UTF8')) > 400
    or name_value <> btrim(name_value)
    or name_value ~ '[[:cntrl:]]'
    or jsonb_array_length(client_metadata->'redirect_uris') not between 1 and 10
    or exists (
      select 1
      from jsonb_array_elements(client_metadata->'redirect_uris') item
      where jsonb_typeof(item) is distinct from 'string'
        or not oauth_private.valid_redirect_uri(item #>> '{}')
    )
  then
    raise exception 'invalid OAuth client metadata' using errcode = '22023';
  end if;

  select array_agg(item #>> '{}' order by ordinal)
    into redirect_values
  from jsonb_array_elements(client_metadata->'redirect_uris')
    with ordinality as redirect_item(item, ordinal);

  if cardinality(redirect_values) <> (
    select count(distinct redirect_uri) from unnest(redirect_values) redirect_uri
  ) then
    raise exception 'invalid OAuth client metadata' using errcode = '22023';
  end if;

  begin
    expiry_value := expiry_text::timestamptz;
  exception
    when others then
      raise exception 'invalid OAuth client metadata' using errcode = '22023';
  end;
  if expiry_value < now_value + interval '5 minutes'
    or expiry_value > now_value + interval '7 days'
  then
    raise exception 'invalid OAuth client metadata' using errcode = '22023';
  end if;

  canonical_payload := 'client_name' || chr(10)
    || oauth_private.frame_text(name_value) || chr(10)
    || 'redirect_uris' || chr(10)
    || cardinality(redirect_values)::text || chr(10)
    || (select string_agg(oauth_private.frame_text(uri), '' order by ordinal)
        from unnest(redirect_values) with ordinality as redirects(uri, ordinal)) || chr(10)
    || 'expires_at' || chr(10)
    || oauth_private.frame_text(expiry_text);
  perform oauth_private.validate_mutation_proof(
    'register_oauth_client', canonical_payload, proof_timestamp, proof_nonce, proof_signature
  );

  perform pg_advisory_xact_lock(2018638290, 1);
  delete from public.oauth_clients client
  where client.ctid in (
    select expired.ctid from public.oauth_clients expired
    where expired.expires_at <= now_value
    order by expired.expires_at
    limit 100
  );
  if (select count(*) from public.oauth_clients where expires_at > now_value) >= 10000
    or (select count(*) from public.oauth_clients where created_at > now_value - interval '1 minute') >= 100
  then
    raise exception 'OAuth registration quota exceeded' using errcode = 'P0001';
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
    and client.expires_at > clock_timestamp()
$$;

create or replace function public.consume_oauth_token(
  token_hash text,
  token_kind text,
  expires_at timestamptz,
  proof_timestamp bigint,
  proof_nonce text,
  proof_signature text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  now_value timestamptz := clock_timestamp();
  affected_rows integer;
  canonical_payload text;
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

  canonical_payload := 'token_hash' || chr(10)
    || oauth_private.frame_text(token_hash) || chr(10)
    || 'token_kind' || chr(10)
    || oauth_private.frame_text(token_kind) || chr(10)
    || 'expires_at' || chr(10)
    || oauth_private.frame_text(oauth_private.canonical_timestamp(expires_at));
  perform oauth_private.validate_mutation_proof(
    'consume_oauth_token', canonical_payload, proof_timestamp, proof_nonce, proof_signature
  );

  delete from public.oauth_consumed_tokens consumed
  where consumed.ctid in (
    select expired.ctid from public.oauth_consumed_tokens expired
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
  expires_at timestamptz,
  proof_timestamp bigint,
  proof_nonce text,
  proof_signature text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  now_value timestamptz := clock_timestamp();
  canonical_payload text;
begin
  if grant_hash is null
    or grant_hash !~ '^[0-9a-f]{64}$'
    or expires_at is null
    or expires_at <= now_value
    or expires_at > now_value + interval '30 days'
  then
    raise exception 'invalid OAuth grant revocation' using errcode = '22023';
  end if;

  canonical_payload := 'grant_hash' || chr(10)
    || oauth_private.frame_text(grant_hash) || chr(10)
    || 'expires_at' || chr(10)
    || oauth_private.frame_text(oauth_private.canonical_timestamp(expires_at));
  perform oauth_private.validate_mutation_proof(
    'revoke_oauth_grant', canonical_payload, proof_timestamp, proof_nonce, proof_signature
  );

  delete from public.oauth_revoked_grants revoked
  where revoked.ctid in (
    select expired.ctid from public.oauth_revoked_grants expired
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
    select 1 from public.oauth_revoked_grants revoked
    where revoked.grant_hash = $1 and revoked.expires_at > clock_timestamp()
  );
end
$$;

alter function oauth_private.frame_text(text) owner to oauth_facade_owner;
alter function oauth_private.canonical_timestamp(timestamptz) owner to oauth_facade_owner;
alter function oauth_private.valid_redirect_uri(text) owner to oauth_facade_owner;
alter function oauth_private.secure_equal(bytea, bytea) owner to oauth_facade_owner;
alter function oauth_private.validate_mutation_proof(text, text, bigint, text, text) owner to oauth_facade_owner;
alter function public.register_oauth_client(jsonb, bigint, text, text) owner to oauth_facade_owner;
alter function public.get_oauth_client(uuid) owner to oauth_facade_owner;
alter function public.consume_oauth_token(text, text, timestamptz, bigint, text, text) owner to oauth_facade_owner;
alter function public.revoke_oauth_grant(text, timestamptz, bigint, text, text) owner to oauth_facade_owner;
alter function public.is_oauth_grant_revoked(text) owner to oauth_facade_owner;

revoke all on all functions in schema oauth_private from public, anon, authenticated, service_role;
revoke all on function public.register_oauth_client(jsonb, bigint, text, text) from public, anon, authenticated, service_role;
revoke all on function public.get_oauth_client(uuid) from public, anon, authenticated, service_role;
revoke all on function public.consume_oauth_token(text, text, timestamptz, bigint, text, text) from public, anon, authenticated, service_role;
revoke all on function public.revoke_oauth_grant(text, timestamptz, bigint, text, text) from public, anon, authenticated, service_role;
revoke all on function public.is_oauth_grant_revoked(text) from public, anon, authenticated, service_role;

grant execute on function public.register_oauth_client(jsonb, bigint, text, text) to anon;
grant execute on function public.get_oauth_client(uuid) to anon;
grant execute on function public.consume_oauth_token(text, text, timestamptz, bigint, text, text) to anon;
grant execute on function public.revoke_oauth_grant(text, timestamptz, bigint, text, text) to anon;
grant execute on function public.is_oauth_grant_revoked(text) to anon;

set local role pg_database_owner;
revoke create on schema public from oauth_facade_owner;
reset role;

do $$
begin
  if has_schema_privilege('oauth_facade_owner', 'public', 'create') then
    raise exception 'OAuth facade owner retained CREATE on schema public';
  end if;
end
$$;

do $$
begin
  execute format('revoke oauth_facade_owner from %I', current_user);
end
$$;

do $$
begin
  if exists (
    select 1
    from pg_auth_members membership
    join pg_roles parent_role on parent_role.oid = membership.roleid
    where parent_role.rolname = 'oauth_facade_owner'
  ) then
    raise exception 'OAuth facade owner has unsafe role memberships';
  end if;
end
$$;

commit;
