begin;

create extension if not exists dblink with schema extensions;

select plan(68);

select has_table('public', 'oauth_clients', 'OAuth clients table exists');
select has_table('public', 'oauth_consumed_tokens', 'consumed-token table exists');
select has_table('public', 'oauth_revoked_grants', 'revoked-grant table exists');
select has_function('public', 'register_oauth_client', array['jsonb'], 'registration RPC exists');
select has_function('public', 'get_oauth_client', array['uuid'], 'exact client lookup RPC exists');
select has_function('public', 'consume_oauth_token', array['text', 'text', 'timestamp with time zone'], 'atomic consume RPC exists');
select has_function('public', 'revoke_oauth_grant', array['text', 'timestamp with time zone'], 'revocation RPC exists');
select has_function('public', 'is_oauth_grant_revoked', array['text'], 'revocation lookup RPC exists');

select ok((select relrowsecurity from pg_class where oid = 'public.oauth_clients'::regclass), 'client RLS is enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.oauth_consumed_tokens'::regclass), 'consumed-token RLS is enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.oauth_revoked_grants'::regclass), 'revoked-grant RLS is enabled');
select is((select count(*) from pg_policies where schemaname = 'public' and tablename like 'oauth_%'), 0::bigint, 'OAuth tables expose no RLS policies');
select is((
  select count(*)
  from pg_class relation
  cross join lateral aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) privilege
  where relation.oid in (
    'public.oauth_clients'::regclass,
    'public.oauth_consumed_tokens'::regclass,
    'public.oauth_revoked_grants'::regclass
  )
    and privilege.grantee = 0
), 0::bigint, 'OAuth tables grant no privileges to PUBLIC');
select is((
  select count(*)
  from (values ('anon'), ('authenticated'), ('service_role')) api_role(role_name)
  cross join (values
    ('public.oauth_clients'),
    ('public.oauth_consumed_tokens'),
    ('public.oauth_revoked_grants')
  ) oauth_table(table_name)
  cross join (values
    ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
  ) table_privilege(privilege_name)
  where has_table_privilege(
    api_role.role_name,
    oauth_table.table_name,
    table_privilege.privilege_name
  )
), 0::bigint, 'API roles have no effective OAuth table privileges');

select ok(has_function_privilege('anon', 'public.register_oauth_client(jsonb)', 'execute'), 'anon can register a client');
select ok(has_function_privilege('anon', 'public.get_oauth_client(uuid)', 'execute'), 'anon can look up an exact client');
select ok(has_function_privilege('anon', 'public.consume_oauth_token(text,text,timestamptz)', 'execute'), 'anon can consume a token hash');
select ok(has_function_privilege('anon', 'public.revoke_oauth_grant(text,timestamptz)', 'execute'), 'anon can revoke a grant hash');
select ok(has_function_privilege('anon', 'public.is_oauth_grant_revoked(text)', 'execute'), 'anon can check a grant hash');
select is((select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('register_oauth_client', 'get_oauth_client', 'consume_oauth_token', 'revoke_oauth_grant', 'is_oauth_grant_revoked') and prosecdef), 5::bigint, 'all OAuth RPCs are security definer');
select is((select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('register_oauth_client', 'get_oauth_client', 'consume_oauth_token', 'revoke_oauth_grant', 'is_oauth_grant_revoked') and proconfig @> array['search_path=public, pg_temp']), 5::bigint, 'all OAuth RPCs pin the explicit search path');
select is((
  select count(*)
  from pg_proc function
  cross join (values ('authenticated'), ('service_role')) blocked_role(role_name)
  where function.pronamespace = 'public'::regnamespace
    and function.proname in ('register_oauth_client', 'get_oauth_client', 'consume_oauth_token', 'revoke_oauth_grant', 'is_oauth_grant_revoked')
    and has_function_privilege(blocked_role.role_name, function.oid, 'execute')
), 0::bigint, 'only anon can execute OAuth RPCs');

select ok(not has_table_privilege('oauth_facade_owner', 'public.spaces', 'select'), 'OAuth owner cannot read spaces');
select ok(not has_table_privilege('oauth_facade_owner', 'public.collections', 'select'), 'OAuth owner cannot read collections');
select ok(not has_table_privilege('oauth_facade_owner', 'public.links', 'select'), 'OAuth owner cannot read links');
select ok(not has_table_privilege('oauth_facade_owner', 'public.workspace_sync_state', 'select'), 'OAuth owner cannot read workspace sync state');
select ok(not has_table_privilege('oauth_facade_owner', 'auth.users', 'select'), 'OAuth owner cannot read auth users');

set local role anon;

select throws_ok('select * from public.oauth_clients', '42501', null, 'anon cannot read clients directly');
select throws_ok('select * from public.oauth_consumed_tokens', '42501', null, 'anon cannot read consumed tokens directly');
select throws_ok('select * from public.oauth_revoked_grants', '42501', null, 'anon cannot read revoked grants directly');

reset role;
set local role service_role;

select throws_ok('select * from public.oauth_clients', '42501', null, 'service role cannot read clients directly');
select throws_ok('select * from public.oauth_consumed_tokens', '42501', null, 'service role cannot read consumed tokens directly');
select throws_ok('select * from public.oauth_revoked_grants', '42501', null, 'service role cannot read revoked grants directly');

reset role;
set local role anon;

select throws_ok(
  $$ select public.register_oauth_client('{"client_name":"x","redirect_uris":["https://client.example/callback"],"expires_at":null,"extra":true}'::jsonb) $$,
  '22023', 'invalid OAuth client metadata', 'registration rejects extra JSON keys'
);
select throws_ok(
  $$ select public.register_oauth_client('{"client_name":"x","redirect_uris":["https://client.example/callback"]}'::jsonb) $$,
  '22023', 'invalid OAuth client metadata', 'registration requires the exact JSON key set'
);
select throws_ok(
  $$ select public.register_oauth_client('{"client_name":42,"redirect_uris":["https://client.example/callback"],"expires_at":null}'::jsonb) $$,
  '22023', 'invalid OAuth client metadata', 'registration requires a string client name'
);
select throws_ok(
  $$ select public.register_oauth_client('{"client_name":"x","redirect_uris":"https://client.example/callback","expires_at":null}'::jsonb) $$,
  '22023', 'invalid OAuth client metadata', 'registration requires a redirect URI array'
);
select throws_ok(
  $$ select public.register_oauth_client('{"client_name":"x","redirect_uris":[42],"expires_at":null}'::jsonb) $$,
  '22023', 'invalid OAuth client metadata', 'registration requires string redirect URI elements'
);
select throws_ok(
  $$ select public.register_oauth_client('{"client_name":"x","redirect_uris":["https://client.example/callback"],"expires_at":42}'::jsonb) $$,
  '22023', 'invalid OAuth client metadata', 'registration requires a string or null expiry'
);
select throws_ok(
  $$ select public.register_oauth_client('{"client_name":"","redirect_uris":["https://client.example/callback"],"expires_at":null}'::jsonb) $$,
  '22023', 'invalid OAuth client metadata', 'registration rejects an empty client name'
);
select throws_ok(
  $$ select public.register_oauth_client(jsonb_build_object('client_name', repeat(' ', 1000) || 'x', 'redirect_uris', jsonb_build_array('https://client.example/callback'), 'expires_at', null)) $$,
  '22023', 'invalid OAuth client metadata', 'registration bounds the persisted whitespace-padded client name'
);
select throws_ok(
  $$ select public.register_oauth_client(jsonb_build_object('client_name', repeat('n', 101), 'redirect_uris', jsonb_build_array('https://client.example/callback'), 'expires_at', null)) $$,
  '22023', 'invalid OAuth client metadata', 'registration rejects names longer than 100 characters'
);
select throws_ok(
  $$ select public.register_oauth_client('{"client_name":"x","redirect_uris":[],"expires_at":null}'::jsonb) $$,
  '22023', 'invalid OAuth client metadata', 'registration requires at least one redirect URI'
);
select throws_ok(
  $$ select public.register_oauth_client(jsonb_build_object('client_name', 'x', 'redirect_uris', to_jsonb(array_fill('https://client.example/callback'::text, array[11])), 'expires_at', null)) $$,
  '22023', 'invalid OAuth client metadata', 'registration permits no more than ten redirect URIs'
);
select throws_ok(
  $$ select public.register_oauth_client('{"client_name":"x","redirect_uris":["https://client.example/callback","https://client.example/callback"],"expires_at":null}'::jsonb) $$,
  '22023', 'invalid OAuth client metadata', 'registration rejects duplicate redirect URIs'
);
select throws_ok(
  $$ select public.register_oauth_client(jsonb_build_object('client_name', 'x', 'redirect_uris', jsonb_build_array('https://client.example/callback'), 'expires_at', now() - interval '1 second')) $$,
  '22023', 'invalid OAuth client metadata', 'registration rejects an already expired client'
);
select throws_ok(
  $$ select public.register_oauth_client(jsonb_build_object('client_name', 'x', 'redirect_uris', jsonb_build_array('https://client.example/callback'), 'expires_at', now() + interval '366 days')) $$,
  '22023', 'invalid OAuth client metadata', 'registration bounds client expiry to one year'
);

select is(
  public.get_oauth_client((public.register_oauth_client('{"client_name":"Exact Client","redirect_uris":["https://client.example/callback","http://127.0.0.1:43123/callback"],"expires_at":null}'::jsonb)->>'client_id')::uuid)->>'client_name',
  'Exact Client',
  'registration returns an opaque UUID accepted by exact lookup'
);
select is(public.get_oauth_client('00000000-0000-0000-0000-000000000099'::uuid), null::jsonb, 'unknown client lookup returns null without enumeration');

select throws_ok(
  $$ select public.consume_oauth_token('raw-jti', 'authorization_code', now() + interval '1 minute') $$,
  '22023', 'invalid OAuth token consumption', 'consume accepts only lowercase SHA-256 hashes'
);
select throws_ok(
  $$ select public.consume_oauth_token(repeat('a', 64), 'access_token', now() + interval '1 minute') $$,
  '22023', 'invalid OAuth token consumption', 'consume accepts only allowlisted token kinds'
);
select throws_ok(
  $$ select public.consume_oauth_token(repeat('a', 64), 'authorization_code', now() - interval '1 second') $$,
  '22023', 'invalid OAuth token consumption', 'consume rejects expired artifacts'
);
select throws_ok(
  $$ select public.consume_oauth_token(repeat('a', 64), 'refresh_token', now() + interval '31 days') $$,
  '22023', 'invalid OAuth token consumption', 'consume bounds persistence to refresh-token lifetime'
);
select ok(public.consume_oauth_token(repeat('b', 64), 'authorization_code', now() + interval '1 minute'), 'first token consumption wins');
select ok(not public.consume_oauth_token(repeat('b', 64), 'authorization_code', now() + interval '1 minute'), 'repeated token consumption loses');

select throws_ok(
  $$ select public.revoke_oauth_grant('raw-grant', now() + interval '1 minute') $$,
  '22023', 'invalid OAuth grant revocation', 'revocation accepts only lowercase SHA-256 hashes'
);
select throws_ok(
  $$ select public.revoke_oauth_grant(repeat('c', 64), now() + interval '31 days') $$,
  '22023', 'invalid OAuth grant revocation', 'revocation bounds persistence to refresh-token lifetime'
);
select lives_ok($$ select public.revoke_oauth_grant(repeat('d', 64), now() + interval '1 day') $$, 'first grant revocation succeeds');
select lives_ok($$ select public.revoke_oauth_grant(repeat('d', 64), now() + interval '2 days') $$, 'grant revocation is idempotent');
select ok(public.is_oauth_grant_revoked(repeat('d', 64)), 'active grant revocation is found');
select ok(not public.is_oauth_grant_revoked(repeat('e', 64)), 'unknown grant hash is not disclosed');

reset role;

delete from public.oauth_consumed_tokens;
insert into public.oauth_consumed_tokens(kind, token_hash, expires_at)
select 'authorization_code', encode(extensions.digest('expired-token-' || value, 'sha256'), 'hex'), now() - interval '1 day'
from generate_series(1, 150) value;
set local role anon;
select ok(public.consume_oauth_token(repeat('f', 64), 'refresh_token', now() + interval '1 day'), 'write succeeds while cleaning expired token hashes');
reset role;
select is((select count(*) from public.oauth_consumed_tokens where expires_at <= now()), 50::bigint, 'token cleanup deletes at most 100 rows per write');

delete from public.oauth_revoked_grants;
insert into public.oauth_revoked_grants(grant_hash, expires_at)
select encode(extensions.digest('expired-grant-' || value, 'sha256'), 'hex'), now() - interval '1 day'
from generate_series(1, 150) value;
set local role anon;
select lives_ok($$ select public.revoke_oauth_grant(repeat('1', 64), now() + interval '1 day') $$, 'write succeeds while cleaning expired grant hashes');
reset role;
select is((select count(*) from public.oauth_revoked_grants where expires_at <= now()), 50::bigint, 'grant cleanup deletes at most 100 rows per write');

select extensions.dblink_connect('oauth_consumer_a', 'dbname=' || current_database());
select extensions.dblink_connect('oauth_consumer_b', 'dbname=' || current_database());
select extensions.dblink_exec('oauth_consumer_a', 'set role anon');
select extensions.dblink_exec('oauth_consumer_b', 'set role anon');
select extensions.dblink_exec('oauth_consumer_a', 'begin');
create temporary table oauth_competing_results(result boolean);
create temporary table oauth_competing_token_hash(token_hash text primary key);
insert into oauth_competing_token_hash(token_hash)
values (encode(extensions.digest(gen_random_uuid()::text || clock_timestamp()::text, 'sha256'), 'hex'));
insert into oauth_competing_results
select result from extensions.dblink(
  'oauth_consumer_a',
  format(
    'select public.consume_oauth_token(%L, ''refresh_token'', now() + interval ''1 day'')',
    (select token_hash from oauth_competing_token_hash)
  )
) as response(result boolean);
select ok(extensions.dblink_send_query(
  'oauth_consumer_b',
  format(
    'select public.consume_oauth_token(%L, ''refresh_token'', now() + interval ''1 day'')',
    (select token_hash from oauth_competing_token_hash)
  )
) = 1, 'competing consumption starts before the winner commits');
select extensions.dblink_exec('oauth_consumer_a', 'commit');
insert into oauth_competing_results
select result from extensions.dblink_get_result('oauth_consumer_b') as response(result boolean);
select is((select count(*) from oauth_competing_results where result), 1::bigint, 'exactly one competing transaction consumes a token hash');
select is((select count(*) from oauth_competing_results where not result), 1::bigint, 'the competing transaction observes atomic replay prevention');
select extensions.dblink_exec('oauth_consumer_a', 'reset role');
select extensions.dblink_exec(
  'oauth_consumer_a',
  format(
    'delete from public.oauth_consumed_tokens where token_hash = %L',
    (select token_hash from oauth_competing_token_hash)
  )
);
select extensions.dblink_disconnect('oauth_consumer_a');
select extensions.dblink_disconnect('oauth_consumer_b');

select * from finish();
rollback;
