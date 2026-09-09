begin;

select plan(37);

select has_table('public', 'collection_shares', 'collection shares table exists');
select has_function('public', 'enable_collection_share', array['uuid'], 'enable share RPC exists');
select has_function('public', 'regenerate_collection_share', array['uuid'], 'regenerate share RPC exists');
select has_function('public', 'disable_collection_share', array['uuid'], 'disable share RPC exists');
select has_function('public', 'load_shared_collection', array['text'], 'public snapshot RPC exists');

insert into auth.users(id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'share-a@example.test', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'share-b@example.test', '', '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.spaces(id, user_id, name, color, position)
values
  ('10000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'Private A', '#7357e6', 0),
  ('10000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'Private B', '#f56f72', 0);

insert into public.collections(id, user_id, space_id, name, position)
values
  ('20000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-00000000000a', '10000000-0000-4000-8000-00000000000a', 'Shared reading', 0),
  ('20000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-00000000000b', '10000000-0000-4000-8000-00000000000b', 'Owner B', 0);

insert into public.links(id, user_id, collection_id, url, title, description, favicon_url, position, created_at)
values
  ('30000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-00000000000a', '20000000-0000-4000-8000-00000000000a', 'https://second.example/', 'Second', '', null, 1, '2026-09-04T00:00:02Z'),
  ('30000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-00000000000a', '20000000-0000-4000-8000-00000000000a', 'https://first.example/', 'First', 'First note', 'https://first.example/favicon.ico', 0, '2026-09-04T00:00:01Z'),
  ('30000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-00000000000b', '20000000-0000-4000-8000-00000000000b', 'https://private.example/', 'Private B', '', null, 0, '2026-09-04T00:00:03Z');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
set local request.jwt.claim.role = 'authenticated';

select lives_ok(
  $$ select * from public.enable_collection_share('20000000-0000-4000-8000-00000000000a') $$,
  'owner can enable sharing'
);
select is((select count(*) from public.collection_shares), 1::bigint, 'owner sees the active share');
select matches((select token from public.collection_shares), '^[A-Za-z0-9_-]{43}$', 'token is 32-byte base64url without padding');
select set_config('app.share_token', (select token from public.collection_shares), true);
select is(
  (select token from public.enable_collection_share('20000000-0000-4000-8000-00000000000a')),
  current_setting('app.share_token'),
  'enable is idempotent'
);

set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select is((select count(*) from public.collection_shares), 0::bigint, 'RLS hides another owner share');
select throws_ok(
  $$ select * from public.enable_collection_share('20000000-0000-4000-8000-00000000000a') $$,
  'P0001', 'collection not found', 'another owner cannot enable sharing'
);
select throws_ok(
  $$ select * from public.regenerate_collection_share('20000000-0000-4000-8000-00000000000a') $$,
  'P0001', 'collection not found', 'another owner cannot regenerate sharing'
);
select throws_ok(
  $$ select public.disable_collection_share('20000000-0000-4000-8000-00000000000a') $$,
  'P0001', 'collection not found', 'another owner cannot disable sharing'
);

set local role anon;
set local request.jwt.claim.sub = '';
set local request.jwt.claim.role = 'anon';
select throws_ok(
  $$ select * from public.collection_shares $$,
  '42501', null, 'anonymous callers cannot query share rows directly'
);
select is((select count(*) from public.collections), 0::bigint, 'anonymous callers cannot read collections directly');
select is((select count(*) from public.links), 0::bigint, 'anonymous callers cannot read links directly');
select is(
  public.load_shared_collection(current_setting('app.share_token'))->>'name',
  'Shared reading',
  'active token exposes the collection name'
);
select is(
  jsonb_array_length(public.load_shared_collection(current_setting('app.share_token'))->'links'),
  2,
  'active token exposes only that collection links'
);
select is(
  public.load_shared_collection(current_setting('app.share_token')) #>> '{links,0,id}',
  '30000000-0000-4000-8000-000000000001',
  'public links retain canonical order'
);
select is(
  (select array_agg(key order by key) from jsonb_object_keys(public.load_shared_collection(current_setting('app.share_token'))) as key),
  array['links', 'name']::text[],
  'public snapshot exposes only approved top-level fields'
);
select is(
  (select array_agg(key order by key) from jsonb_object_keys(public.load_shared_collection(current_setting('app.share_token')) #> '{links,0}') as key),
  array['description', 'favicon_url', 'id', 'position', 'title', 'url']::text[],
  'public link exposes only approved fields'
);
select is(
  public.load_shared_collection(current_setting('app.share_token')) #> '{links,0,favicon_url}',
  'null'::jsonb,
  'public snapshots omit captured favicon URLs'
);
select is(public.load_shared_collection('bad token'), null::jsonb, 'malformed tokens are unavailable');
select is(public.load_shared_collection('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), null::jsonb, 'unknown tokens are unavailable');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
set local request.jwt.claim.role = 'authenticated';
select lives_ok(
  $$ select * from public.regenerate_collection_share('20000000-0000-4000-8000-00000000000a') $$,
  'owner can regenerate sharing'
);
select isnt((select token from public.collection_shares), current_setting('app.share_token'), 'regeneration replaces the token');
select set_config('app.replacement_share_token', (select token from public.collection_shares), true);

set local role anon;
set local request.jwt.claim.sub = '';
set local request.jwt.claim.role = 'anon';
select is(public.load_shared_collection(current_setting('app.share_token')), null::jsonb, 'regeneration invalidates the old URL');
select is(public.load_shared_collection(current_setting('app.replacement_share_token'))->>'name', 'Shared reading', 'replacement URL is active');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
set local request.jwt.claim.role = 'authenticated';
select lives_ok(
  $$ select public.disable_collection_share('20000000-0000-4000-8000-00000000000a') $$,
  'owner can disable sharing'
);

set local role anon;
set local request.jwt.claim.sub = '';
set local request.jwt.claim.role = 'anon';
select is(public.load_shared_collection(current_setting('app.replacement_share_token')), null::jsonb, 'disable invalidates the active URL');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
set local request.jwt.claim.role = 'authenticated';
select lives_ok(
  $$ select public.disable_collection_share('20000000-0000-4000-8000-00000000000a') $$,
  'disable is idempotent'
);
select lives_ok(
  $$ select * from public.enable_collection_share('20000000-0000-4000-8000-00000000000a') $$,
  'owner can enable sharing again'
);
select set_config('app.cascade_share_token', (select token from public.collection_shares), true);
select lives_ok(
  $$ select public.trash_workspace_entity('collection', '20000000-0000-4000-8000-00000000000a', 'web',
    '40000000-0000-4000-8000-000000000033',
    (public.prepare_workspace_delete('collection', '20000000-0000-4000-8000-00000000000a')->>'intentId')::uuid) $$,
  'owner can delete a shared collection'
);
select is((select count(*) from public.collection_shares), 0::bigint, 'collection deletion cascades to the share');

set local role anon;
set local request.jwt.claim.sub = '';
set local request.jwt.claim.role = 'anon';
select is(public.load_shared_collection(current_setting('app.cascade_share_token')), null::jsonb, 'cascade deletion invalidates the URL');

reset role;
select throws_ok(
  $$ insert into public.collection_shares(user_id, collection_id, token) values ('00000000-0000-0000-0000-00000000000b', '20000000-0000-4000-8000-00000000000b', 'invalid') $$,
  '23514', null, 'database rejects malformed tokens'
);
select throws_ok(
  $$ insert into public.collection_shares(user_id, collection_id, token) values ('00000000-0000-0000-0000-00000000000a', '20000000-0000-4000-8000-00000000000b', 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB') $$,
  '23503', null, 'composite ownership rejects a cross-owner collection reference'
);

select * from finish();
rollback;
