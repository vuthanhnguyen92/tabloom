begin;

select plan(27);

select has_table('public', 'workspace_sync_state', 'workspace sync state table exists');
select has_function('public', 'load_workspace_snapshot', array[]::text[], 'versioned load RPC exists');
select has_function('public', 'merge_workspace_snapshot', array['jsonb', 'bigint'], 'merge RPC exists');

insert into auth.users(id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'merge-a@example.test', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'merge-b@example.test', '', '{}'::jsonb, '{}'::jsonb, now(), now());

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
set local request.jwt.claim.role = 'authenticated';

select is(
  (public.load_workspace_snapshot()->>'revision')::bigint,
  0::bigint,
  'a missing sync state loads as revision zero'
);
select is(
  jsonb_array_length(public.load_workspace_snapshot() #> '{snapshot,spaces}'),
  0,
  'a new user loads an empty canonical workspace'
);

select lives_ok(
  $$
    select public.merge_workspace_snapshot(
      '{
        "spaces":[{"id":"10000000-0000-4000-8000-000000000001","user_id":"local-user","name":"Research","color":"#7357e6","position":0,"created_at":"2026-08-29T00:00:00Z","updated_at":"2026-08-29T00:00:00Z"}],
        "collections":[{"id":"20000000-0000-4000-8000-000000000001","user_id":"local-user","space_id":"10000000-0000-4000-8000-000000000001","name":"Reading","position":0,"created_at":"2026-08-29T00:00:00Z","updated_at":"2026-08-29T00:00:00Z"}],
        "links":[{"id":"30000000-0000-4000-8000-000000000001","user_id":"local-user","collection_id":"20000000-0000-4000-8000-000000000001","url":"https://example.com/","title":"Cloud title","description":"","favicon_url":null,"position":0,"created_at":"2026-08-29T00:00:00Z","updated_at":"2026-08-29T00:00:00Z"}]
      }'::jsonb,
      0
    )
  $$,
  'first local workspace merges atomically'
);
select is((select count(*) from public.spaces), 1::bigint, 'first merge creates one space');
select is((select count(*) from public.collections), 1::bigint, 'first merge creates one collection');
select is((select count(*) from public.links), 1::bigint, 'first merge creates one link');
select is((select revision from public.workspace_sync_state), 1::bigint, 'merge increments revision exactly once');
select is(
  public.load_workspace_snapshot() #>> '{snapshot,links,0,id}',
  '30000000-0000-4000-8000-000000000001',
  'an unused valid local card UUID is preserved'
);

select lives_ok(
  $$
    select public.merge_workspace_snapshot(
      '{
        "spaces":[{"id":"10000000-0000-4000-8000-000000000001","name":"Research","color":"#000000","position":0}],
        "collections":[{"id":"20000000-0000-4000-8000-000000000001","space_id":"10000000-0000-4000-8000-000000000001","name":"Reading","position":0}],
        "links":[{"id":"30000000-0000-4000-8000-000000000099","collection_id":"20000000-0000-4000-8000-000000000001","url":"https://example.com","title":"Local replacement","description":"Filled locally","favicon_url":"https://example.com/icon.png","position":0}]
      }'::jsonb,
      1
    )
  $$,
  'normalized URL fallback re-merges the same collection without a duplicate'
);
select is((select count(*) from public.links), 1::bigint, 'URL fallback remains idempotent');
select is((select title from public.links), 'Cloud title', 'non-empty cloud metadata wins');
select is((select description from public.links), 'Filled locally', 'local metadata fills an empty cloud field');

select lives_ok(
  $$
    select public.merge_workspace_snapshot(
      '{
        "spaces":[{"id":"10000000-0000-4000-8000-000000000001","name":"Research","color":"#7357e6","position":0}],
        "collections":[{"id":"20000000-0000-4000-8000-000000000002","space_id":"10000000-0000-4000-8000-000000000001","name":"Later","position":1}],
        "links":[{"id":"30000000-0000-4000-8000-000000000002","collection_id":"20000000-0000-4000-8000-000000000002","url":"https://example.com/","title":"Same URL elsewhere","description":"","favicon_url":null,"position":0}]
      }'::jsonb,
      2
    )
  $$,
  'the same URL can be saved in another collection'
);
select is((select count(*) from public.links), 2::bigint, 'URL deduplication is scoped to a collection');

select lives_ok(
  $$
    select public.merge_workspace_snapshot(
      '{"spaces":[{"id":"10000000-0000-4000-8000-000000000001","name":"Personal","color":"#f56f72","position":0}],"collections":[],"links":[]}'::jsonb,
      3
    )
  $$,
  'a colliding hierarchy UUID with a different name is remapped'
);
select is((select count(*) from public.spaces), 2::bigint, 'UUID collision does not merge unrelated spaces');

select throws_ok(
  $$
    select public.merge_workspace_snapshot(
      '{"spaces":[{"id":"10000000-0000-4000-8000-000000000003","name":"Invalid batch","color":"#7357e6","position":0}],"collections":[{"id":"20000000-0000-4000-8000-000000000003","space_id":"10000000-0000-4000-8000-000000000003","name":"Invalid","position":0}],"links":[{"id":"30000000-0000-4000-8000-000000000003","collection_id":"20000000-0000-4000-8000-000000000003","url":"chrome://settings","title":"Settings","description":"","position":0}]}'::jsonb,
      4
    )
  $$,
  '22023',
  'unsupported workspace URL',
  'unsupported URLs reject the whole merge'
);
select is((select count(*) from public.spaces), 2::bigint, 'invalid payload rolls back preceding hierarchy writes');
select is((select revision from public.workspace_sync_state), 4::bigint, 'invalid payload does not advance revision');

select throws_ok(
  $$ select public.merge_workspace_snapshot('{"spaces":[],"collections":[],"links":[]}'::jsonb, 3) $$,
  '40001',
  'workspace revision conflict',
  'a stale preview is rejected'
);

set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select is((select count(*) from public.spaces), 0::bigint, 'RLS hides another user workspace');
select is((select count(*) from public.workspace_sync_state), 0::bigint, 'RLS hides another user revision');
select is(
  jsonb_array_length(public.load_workspace_snapshot() #> '{snapshot,links}'),
  0,
  'versioned load cannot expose another user links'
);

reset role;
select throws_ok(
  $$
    insert into public.collections(id, user_id, space_id, name, position)
    values (
      '20000000-0000-4000-8000-00000000000b',
      '00000000-0000-0000-0000-00000000000b',
      '10000000-0000-4000-8000-000000000001',
      'Cross owner',
      0
    )
  $$,
  '23503',
  null,
  'composite ownership rejects a cross-user collection reference'
);

select * from finish();
rollback;
