begin;

select no_plan();

select ok(
  exists (
    select 1
    from pg_roles
    where rolname = 'oauth_facade_owner'
      and not rolsuper
      and not rolcreatedb
      and not rolcreaterole
      and not rolcanlogin
      and not rolinherit
      and not rolreplication
      and not rolbypassrls
  ),
  'OAuth owner has only safe role attributes'
);

select ok(
  not exists (
    select 1
    from pg_auth_members membership
    join pg_roles parent_role on parent_role.oid = membership.roleid
    where parent_role.rolname = 'oauth_facade_owner'
  ),
  'OAuth owner has no retained role memberships'
);

select ok(
  not has_schema_privilege('oauth_facade_owner', 'public', 'create'),
  'OAuth owner has no retained CREATE privilege on public'
);

insert into oauth_private.facade_secret (secret)
values (decode(repeat('42', 32), 'hex'))
on conflict (singleton) do update
set secret = excluded.secret, updated_at = clock_timestamp();

create function pg_temp.frame_text(value text)
returns text language sql immutable strict
as $$ select octet_length(convert_to(value, 'UTF8'))::text || ':' || value $$;

create function pg_temp.canonical_timestamp(value timestamptz)
returns text language sql immutable strict
as $$ select to_char(value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

create function pg_temp.test_nonce(label text)
returns text language sql immutable strict
as $$
  select translate(rtrim(encode(extensions.digest(convert_to(label, 'UTF8'), 'sha256'), 'base64'), '='), '+/', '-_')
$$;

create function pg_temp.proof_signature(
  action_value text,
  payload_value text,
  timestamp_value bigint,
  nonce_value text
)
returns text
language sql
security definer
set search_path = pg_catalog, extensions, oauth_private, pg_temp
as $$
  select translate(rtrim(encode(extensions.hmac(
    convert_to(
      'tabloom-oauth-rpc-v1' || chr(10) || action_value || chr(10)
        || payload_value || chr(10) || timestamp_value::text || chr(10) || nonce_value,
      'UTF8'
    ),
    configured.secret,
    'sha256'
  ), 'base64'), '='), '+/', '-_')
  from oauth_private.facade_secret configured
  where configured.singleton
$$;

create function pg_temp.registration_payload(metadata jsonb)
returns text language sql immutable strict
as $$
  select 'client_name' || chr(10)
    || pg_temp.frame_text(metadata->>'client_name') || chr(10)
    || 'redirect_uris' || chr(10)
    || jsonb_array_length(metadata->'redirect_uris')::text || chr(10)
    || (select string_agg(pg_temp.frame_text(uri), '' order by ordinal)
        from jsonb_array_elements_text(metadata->'redirect_uris')
          with ordinality as redirects(uri, ordinal)) || chr(10)
    || 'expires_at' || chr(10)
    || pg_temp.frame_text(metadata->>'expires_at')
$$;

create function pg_temp.test_register(
  metadata jsonb,
  nonce_label text,
  signed_metadata jsonb default null,
  timestamp_delta bigint default 0,
  signed_action text default 'register_oauth_client',
  signature_override text default null
)
returns jsonb
language plpgsql
as $$
declare
  timestamp_value bigint := extract(epoch from clock_timestamp())::bigint + timestamp_delta;
  nonce_value text := pg_temp.test_nonce(nonce_label);
  payload_value text := pg_temp.registration_payload(coalesce(signed_metadata, metadata));
  signature_value text;
begin
  signature_value := coalesce(
    signature_override,
    pg_temp.proof_signature(signed_action, payload_value, timestamp_value, nonce_value)
  );
  return public.register_oauth_client(
    metadata, timestamp_value, nonce_value, signature_value
  );
end
$$;

create function pg_temp.test_consume(
  hash_value text,
  kind_value text,
  expiry_value timestamptz,
  nonce_label text,
  signed_hash text default null,
  timestamp_delta bigint default 0,
  signed_action text default 'consume_oauth_token',
  signature_override text default null
)
returns boolean
language plpgsql
as $$
declare
  timestamp_value bigint := extract(epoch from clock_timestamp())::bigint + timestamp_delta;
  nonce_value text := pg_temp.test_nonce(nonce_label);
  payload_value text := 'token_hash' || chr(10)
    || pg_temp.frame_text(coalesce(signed_hash, hash_value)) || chr(10)
    || 'token_kind' || chr(10) || pg_temp.frame_text(kind_value) || chr(10)
    || 'expires_at' || chr(10)
    || pg_temp.frame_text(pg_temp.canonical_timestamp(expiry_value));
  signature_value text;
begin
  signature_value := coalesce(
    signature_override,
    pg_temp.proof_signature(signed_action, payload_value, timestamp_value, nonce_value)
  );
  return public.consume_oauth_token(
    hash_value, kind_value, expiry_value,
    timestamp_value, nonce_value, signature_value
  );
end
$$;

create function pg_temp.test_revoke(
  hash_value text,
  expiry_value timestamptz,
  nonce_label text,
  signed_hash text default null,
  timestamp_delta bigint default 0,
  signed_action text default 'revoke_oauth_grant',
  signature_override text default null
)
returns void
language plpgsql
as $$
declare
  timestamp_value bigint := extract(epoch from clock_timestamp())::bigint + timestamp_delta;
  nonce_value text := pg_temp.test_nonce(nonce_label);
  payload_value text := 'grant_hash' || chr(10)
    || pg_temp.frame_text(coalesce(signed_hash, hash_value)) || chr(10)
    || 'expires_at' || chr(10)
    || pg_temp.frame_text(pg_temp.canonical_timestamp(expiry_value));
  signature_value text;
begin
  signature_value := coalesce(
    signature_override,
    pg_temp.proof_signature(signed_action, payload_value, timestamp_value, nonce_value)
  );
  perform public.revoke_oauth_grant(
    hash_value, expiry_value, timestamp_value, nonce_value, signature_value
  );
end
$$;

select has_table('public', 'oauth_clients', 'OAuth clients table exists');
select has_table('public', 'oauth_consumed_tokens', 'consumed-token table exists');
select has_table('public', 'oauth_revoked_grants', 'revoked-grant table exists');
select has_table('oauth_private', 'facade_secret', 'private proof secret table exists');
select has_table('oauth_private', 'mutation_nonces', 'private replay table exists');
select has_function('public', 'register_oauth_client', array['jsonb', 'bigint', 'text', 'text'], 'proved registration RPC exists');
select has_function('public', 'consume_oauth_token', array['text', 'text', 'timestamp with time zone', 'bigint', 'text', 'text'], 'proved consume RPC exists');
select has_function('public', 'revoke_oauth_grant', array['text', 'timestamp with time zone', 'bigint', 'text', 'text'], 'proved revocation RPC exists');
select is((select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'register_oauth_client' and pronargs = 1), 0::bigint, 'unproved registration overload does not exist');
select is((select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'consume_oauth_token' and pronargs = 3), 0::bigint, 'unproved consume overload does not exist');
select is((select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'revoke_oauth_grant' and pronargs = 2), 0::bigint, 'unproved revoke overload does not exist');
select is((select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proargnames::text ~ 'secret'), 0::bigint, 'no public RPC accepts a secret argument');

select ok(not has_schema_privilege('anon', 'oauth_private', 'usage'), 'anon cannot use the private schema');
select ok(not has_schema_privilege('authenticated', 'oauth_private', 'usage'), 'authenticated cannot use the private schema');
select ok(not has_schema_privilege('service_role', 'oauth_private', 'usage'), 'service role cannot use the private schema');
select ok(not has_table_privilege('anon', 'oauth_private.facade_secret', 'select'), 'anon cannot read the proof secret');
select ok(not has_table_privilege('service_role', 'oauth_private.facade_secret', 'select'), 'service role cannot read the proof secret');
select ok(has_function_privilege('anon', 'public.register_oauth_client(jsonb,bigint,text,text)', 'execute'), 'anon can execute only proved registration');
select ok(not has_function_privilege('service_role', 'public.register_oauth_client(jsonb,bigint,text,text)', 'execute'), 'service role has no registration execution grant');
select ok((select relrowsecurity from pg_class where oid = 'public.oauth_clients'::regclass), 'client RLS is enabled');
select ok((select relrowsecurity from pg_class where oid = 'oauth_private.facade_secret'::regclass), 'private-secret RLS is enabled');
select ok(not has_table_privilege('oauth_facade_owner', 'public.spaces', 'select'), 'OAuth owner cannot read spaces');
select ok(not has_table_privilege('oauth_facade_owner', 'auth.users', 'select'), 'OAuth owner cannot read auth users');

set local role anon;

select throws_ok(
  $$ select public.register_oauth_client(
    jsonb_build_object('client_name','x','redirect_uris',jsonb_build_array('https://client.example/callback'),'expires_at',pg_temp.canonical_timestamp(clock_timestamp() + interval '1 day')),
    null, null, null
  ) $$,
  '42501', 'invalid OAuth mutation proof', 'registration requires a proof'
);
select throws_ok(
  $$ select pg_temp.test_register(
    jsonb_build_object('client_name','x','redirect_uris',jsonb_build_array('https://client.example/callback'),'expires_at',pg_temp.canonical_timestamp(clock_timestamp() + interval '1 day')),
    'wrong-signature', null, 0, 'register_oauth_client', repeat('x', 43)
  ) $$,
  '42501', 'invalid OAuth mutation proof', 'registration rejects a wrong signature'
);
select throws_ok(
  $$ select pg_temp.test_register(
    jsonb_build_object('client_name','x','redirect_uris',jsonb_build_array('https://client.example/callback'),'expires_at',pg_temp.canonical_timestamp(clock_timestamp() + interval '1 day')),
    'expired-proof', null, -31
  ) $$,
  '42501', 'invalid OAuth mutation proof', 'registration rejects an expired proof'
);
select throws_ok(
  $$ select pg_temp.test_register(
    jsonb_build_object('client_name','tampered','redirect_uris',jsonb_build_array('https://client.example/callback'),'expires_at',pg_temp.canonical_timestamp(clock_timestamp() + interval '1 day')),
    'tampered-payload',
    jsonb_build_object('client_name','signed','redirect_uris',jsonb_build_array('https://client.example/callback'),'expires_at',pg_temp.canonical_timestamp(clock_timestamp() + interval '1 day'))
  ) $$,
  '42501', 'invalid OAuth mutation proof', 'registration rejects a tampered payload'
);
select throws_ok(
  $$ select pg_temp.test_register(
    jsonb_build_object('client_name','x','redirect_uris',jsonb_build_array('https://client.example/callback'),'expires_at',pg_temp.canonical_timestamp(clock_timestamp() + interval '1 day')),
    'wrong-action', null, 0, 'consume_oauth_token'
  ) $$,
  '42501', 'invalid OAuth mutation proof', 'registration rejects a proof for another action'
);

select is(
  pg_temp.test_register(
    jsonb_build_object('client_name','Exact Client','redirect_uris',jsonb_build_array('https://client.example/callback','http://127.0.0.1:43123/callback','http://[::1]:43124/callback'),'expires_at',pg_temp.canonical_timestamp(clock_timestamp() + interval '1 day')),
    'valid-registration'
  )->>'client_name',
  'Exact Client',
  'proved registration accepts exact HTTPS and literal loopback redirects'
);
select throws_ok(
  $$ select pg_temp.test_register(
    jsonb_build_object('client_name','replay','redirect_uris',jsonb_build_array('https://client.example/callback'),'expires_at',pg_temp.canonical_timestamp(clock_timestamp() + interval '1 day')),
    'valid-registration'
  ) $$,
  '42501', 'invalid OAuth mutation proof', 'registration rejects a replayed nonce'
);

select throws_ok(
  $$ select pg_temp.test_register(jsonb_build_object('client_name',' bad ','redirect_uris',jsonb_build_array('https://client.example/callback'),'expires_at',pg_temp.canonical_timestamp(clock_timestamp() + interval '1 day')), 'bad-name') $$,
  '22023', 'invalid OAuth client metadata', 'registration rejects padded names'
);
select throws_ok(
  $$ select pg_temp.test_register(jsonb_build_object('client_name','x','redirect_uris',jsonb_build_array('https://user:pass@client.example/callback'),'expires_at',pg_temp.canonical_timestamp(clock_timestamp() + interval '1 day')), 'credentials') $$,
  '22023', 'invalid OAuth client metadata', 'registration rejects redirect credentials'
);
select throws_ok(
  $$ select pg_temp.test_register(jsonb_build_object('client_name','x','redirect_uris',jsonb_build_array('https://*.client.example/callback'),'expires_at',pg_temp.canonical_timestamp(clock_timestamp() + interval '1 day')), 'wildcard') $$,
  '22023', 'invalid OAuth client metadata', 'registration rejects redirect wildcards'
);
select throws_ok(
  $$ select pg_temp.test_register(jsonb_build_object('client_name','x','redirect_uris',jsonb_build_array('https://client.example/callback#fragment'),'expires_at',pg_temp.canonical_timestamp(clock_timestamp() + interval '1 day')), 'fragment') $$,
  '22023', 'invalid OAuth client metadata', 'registration rejects redirect fragments'
);
select throws_ok(
  $$ select pg_temp.test_register(jsonb_build_object('client_name','x','redirect_uris',jsonb_build_array('http://localhost/callback'),'expires_at',pg_temp.canonical_timestamp(clock_timestamp() + interval '1 day')), 'localhost') $$,
  '22023', 'invalid OAuth client metadata', 'registration rejects named HTTP loopback'
);
select throws_ok(
  $$ select pg_temp.test_register(jsonb_build_object('client_name','x','redirect_uris',jsonb_build_array('https://client.example/callback'),'expires_at',null), 'null-expiry') $$,
  '22023', 'invalid OAuth client metadata', 'registration requires expiry'
);
select throws_ok(
  $$ select pg_temp.test_register(jsonb_build_object('client_name','x','redirect_uris',jsonb_build_array('https://client.example/callback'),'expires_at',pg_temp.canonical_timestamp(clock_timestamp() + interval '8 days')), 'long-expiry') $$,
  '22023', 'invalid OAuth client metadata', 'registration bounds expiry to seven days'
);

select ok(pg_temp.test_consume(repeat('b', 64), 'authorization_code', clock_timestamp() + interval '1 minute', 'consume-first'), 'proved token consumption succeeds');
select throws_ok(
  $$ select pg_temp.test_consume(repeat('b',64), 'authorization_code', clock_timestamp() + interval '1 minute', 'consume-first') $$,
  '42501', 'invalid OAuth mutation proof', 'consume rejects a replayed proof before token replay evaluation'
);
select throws_ok(
  $$ select pg_temp.test_consume(repeat('c',64), 'authorization_code', clock_timestamp() + interval '1 minute', 'consume-tamper', repeat('d',64)) $$,
  '42501', 'invalid OAuth mutation proof', 'consume rejects a tampered token hash'
);
select throws_ok(
  $$ select pg_temp.test_consume(repeat('c',64), 'authorization_code', clock_timestamp() + interval '1 minute', 'consume-expired', null, -31) $$,
  '42501', 'invalid OAuth mutation proof', 'consume rejects an expired proof'
);
select throws_ok(
  $$ select pg_temp.test_consume('raw-jti', 'authorization_code', clock_timestamp() + interval '1 minute', 'bad-token') $$,
  '22023', 'invalid OAuth token consumption', 'consume bounds the token hash before proof evaluation'
);

select lives_ok(
  $$ select pg_temp.test_revoke(repeat('e',64), clock_timestamp() + interval '1 day', 'revoke-first') $$,
  'proved grant revocation succeeds'
);
select ok(public.is_oauth_grant_revoked(repeat('e',64)), 'active proved revocation is visible');
select throws_ok(
  $$ select pg_temp.test_revoke(repeat('f',64), clock_timestamp() + interval '1 day', 'revoke-tamper', repeat('0',64)) $$,
  '42501', 'invalid OAuth mutation proof', 'revoke rejects a tampered grant hash'
);
select throws_ok(
  $$ select pg_temp.test_revoke(repeat('f',64), clock_timestamp() + interval '31 days', 'long-grant') $$,
  '22023', 'invalid OAuth grant revocation', 'revoke bounds durable grant lifetime'
);

reset role;

delete from public.oauth_clients;
insert into public.oauth_clients(client_name, redirect_uris, created_at, expires_at)
select 'expired-' || value,
  array['https://client.example/callback'],
  clock_timestamp() - interval '1 day 1 minute',
  clock_timestamp() - interval '1 day'
from generate_series(1, 150) value;
set local role anon;
select lives_ok(
  $$ select pg_temp.test_register(
    jsonb_build_object('client_name','cleanup','redirect_uris',jsonb_build_array('https://client.example/callback'),'expires_at',pg_temp.canonical_timestamp(clock_timestamp() + interval '1 day')),
    'client-cleanup'
  ) $$,
  'registration succeeds while bounded client cleanup runs'
);
reset role;
select is((select count(*) from public.oauth_clients where expires_at <= clock_timestamp()), 50::bigint, 'client cleanup deletes at most 100 rows');

delete from public.oauth_clients;
insert into public.oauth_clients(client_name, redirect_uris, created_at, expires_at)
select 'active-' || value,
  array['https://client.example/callback'],
  clock_timestamp(),
  clock_timestamp() + interval '1 day'
from generate_series(1, 100) value;
set local role anon;
select throws_ok(
  $$ select pg_temp.test_register(
    jsonb_build_object('client_name','rate-limited','redirect_uris',jsonb_build_array('https://client.example/callback'),'expires_at',pg_temp.canonical_timestamp(clock_timestamp() + interval '1 day')),
    'registration-rate-quota'
  ) $$,
  'P0001', 'OAuth registration quota exceeded', 'database registration rate quota is enforced'
);
reset role;

delete from public.oauth_consumed_tokens;
insert into public.oauth_consumed_tokens(kind, token_hash, consumed_at, expires_at)
select 'authorization_code',
  encode(extensions.digest(convert_to('expired-token-' || value, 'UTF8'), 'sha256'), 'hex'),
  clock_timestamp() - interval '1 day 1 minute',
  clock_timestamp() - interval '1 day'
from generate_series(1, 150) value;
set local role anon;
select ok(pg_temp.test_consume(repeat('7',64), 'refresh_token', clock_timestamp() + interval '1 day', 'token-cleanup'), 'consume succeeds while bounded cleanup runs');
reset role;
select is((select count(*) from public.oauth_consumed_tokens where expires_at <= clock_timestamp()), 50::bigint, 'token cleanup deletes at most 100 rows');

delete from public.oauth_revoked_grants;
insert into public.oauth_revoked_grants(grant_hash, revoked_at, expires_at)
select encode(extensions.digest(convert_to('expired-grant-' || value, 'UTF8'), 'sha256'), 'hex'),
  clock_timestamp() - interval '2 days',
  clock_timestamp() - interval '1 day'
from generate_series(1, 150) value;
set local role anon;
select lives_ok(
  $$ select pg_temp.test_revoke(repeat('8',64), clock_timestamp() + interval '1 day', 'grant-cleanup') $$,
  'revoke succeeds while bounded cleanup runs'
);
reset role;
select is((select count(*) from public.oauth_revoked_grants where expires_at <= clock_timestamp()), 50::bigint, 'grant cleanup deletes at most 100 rows');

create temporary table expired_client_id(client_id uuid primary key);
with inserted as (
  insert into public.oauth_clients(client_name, redirect_uris, created_at, expires_at)
  values (
    'expired',
    array['https://client.example/callback'],
    clock_timestamp() - interval '2 days',
    clock_timestamp() - interval '1 day'
  )
  returning client_id
)
insert into expired_client_id select client_id from inserted;
grant select on expired_client_id to anon;
set local role anon;
select is(public.get_oauth_client((select client_id from expired_client_id)), null::jsonb, 'expired clients are not resolved');
reset role;

select * from finish();
rollback;
