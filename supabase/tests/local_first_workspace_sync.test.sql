begin;

select plan(31);

select has_table('public', 'workspace_operations', 'applied operation table exists');
select has_table('public', 'workspace_tombstones', 'workspace tombstone table exists');
select has_function('public', 'get_workspace_revision', array[]::text[], 'revision RPC exists');
select has_function('public', 'apply_workspace_operations', array['jsonb', 'bigint'], 'operation RPC exists');

insert into auth.users(id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sync-a@example.test', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sync-b@example.test', '', '{}'::jsonb, '{}'::jsonb, now(), now());

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
set local request.jwt.claim.role = 'authenticated';

select is((public.get_workspace_revision()->>'revision')::bigint, 0::bigint, 'new account starts at revision zero');
select is(jsonb_array_length(public.load_workspace_snapshot()->'tombstones'), 0, 'canonical load starts without tombstones');

select lives_ok(
  $$ select public.apply_workspace_operations(
    '[
      {"operationId":"40000000-0000-4000-8000-000000000001","deviceId":"50000000-0000-4000-8000-000000000001","sequence":1,"entity":"space","entityId":"10000000-0000-4000-8000-000000000001","action":"create","payload":{"id":"10000000-0000-4000-8000-000000000001","name":"Research","color":"#7357e6","position":0,"created_at":"2026-08-31T00:00:00Z","updated_at":"2026-08-31T00:00:00Z"},"createdAt":"2026-08-31T00:00:00Z","baseRevision":0},
      {"operationId":"40000000-0000-4000-8000-000000000002","deviceId":"50000000-0000-4000-8000-000000000001","sequence":2,"entity":"collection","entityId":"20000000-0000-4000-8000-000000000001","action":"create","payload":{"id":"20000000-0000-4000-8000-000000000001","space_id":"10000000-0000-4000-8000-000000000001","name":"Reading","position":0,"created_at":"2026-08-31T00:00:00Z","updated_at":"2026-08-31T00:00:00Z"},"createdAt":"2026-08-31T00:00:00Z","baseRevision":0},
      {"operationId":"40000000-0000-4000-8000-000000000003","deviceId":"50000000-0000-4000-8000-000000000001","sequence":3,"entity":"link","entityId":"30000000-0000-4000-8000-000000000001","action":"create","payload":{"id":"30000000-0000-4000-8000-000000000001","collection_id":"20000000-0000-4000-8000-000000000001","url":"https://example.com/","title":"Example","description":"","favicon_url":null,"position":0,"created_at":"2026-08-31T00:00:00Z","updated_at":"2026-08-31T00:00:00Z"},"createdAt":"2026-08-31T00:00:00Z","baseRevision":0}
    ]'::jsonb,
    0
  ) $$,
  'a hierarchy create batch applies atomically'
);
select is((select count(*) from public.spaces), 1::bigint, 'batch creates one space');
select is((select count(*) from public.collections), 1::bigint, 'batch creates one collection');
select is((select count(*) from public.links), 1::bigint, 'batch creates one link');
select is((select revision from public.workspace_sync_state), 1::bigint, 'batch increments revision once');
select is((select count(*) from public.workspace_operations), 3::bigint, 'batch records all operation ids');
select is(
  jsonb_array_length(public.apply_workspace_operations(
    '[
      {"operationId":"40000000-0000-4000-8000-000000000001","deviceId":"50000000-0000-4000-8000-000000000001","sequence":1,"entity":"space","entityId":"10000000-0000-4000-8000-000000000001","action":"create","payload":{"id":"10000000-0000-4000-8000-000000000001","name":"Research","color":"#7357e6","position":0},"createdAt":"2026-08-31T00:00:00Z","baseRevision":0}
    ]'::jsonb,
    1
  )->'outcomes'),
  1,
  'an idempotent retry returns one outcome'
);
select is((select revision from public.workspace_sync_state), 1::bigint, 'idempotent retry does not increment revision');
select is((select count(*) from public.spaces), 1::bigint, 'idempotent retry does not duplicate data');

select throws_ok(
  $$ select public.apply_workspace_operations(
    '[{"operationId":"40000000-0000-4000-8000-000000000004","deviceId":"50000000-0000-4000-8000-000000000001","sequence":4,"entity":"space","entityId":"10000000-0000-4000-8000-000000000001","action":"update","payload":{"name":"Stale"},"createdAt":"2026-08-31T00:00:00Z","baseRevision":0}]'::jsonb,
    0
  ) $$,
  '40001',
  'workspace revision conflict',
  'a stale expected revision rejects the whole batch'
);
select is((select name from public.spaces), 'Research', 'stale update performs no partial write');

select throws_ok(
  $$ select public.apply_workspace_operations(
    '[{"operationId":"40000000-0000-4000-8000-000000000005","deviceId":"50000000-0000-4000-8000-000000000001","sequence":5,"entity":"link","entityId":"30000000-0000-4000-8000-000000000005","action":"create","payload":{"id":"30000000-0000-4000-8000-000000000005","collection_id":"20000000-0000-4000-8000-000000000001","url":"chrome://settings","title":"Settings","description":"","position":1},"createdAt":"2026-08-31T00:00:00Z","baseRevision":1}]'::jsonb,
    1
  ) $$,
  '22023',
  'unsupported workspace URL',
  'unsupported URLs reject the batch'
);
select is((select count(*) from public.links), 1::bigint, 'invalid URL creates no link');
select is((select revision from public.workspace_sync_state), 1::bigint, 'invalid batch does not increment revision');

select lives_ok(
  $$ select public.apply_workspace_operations(
    '[{"operationId":"40000000-0000-4000-8000-000000000006","deviceId":"50000000-0000-4000-8000-000000000001","sequence":6,"entity":"collection","entityId":"20000000-0000-4000-8000-000000000001","action":"delete","payload":{},"createdAt":"2026-08-31T00:00:00Z","baseRevision":1}]'::jsonb,
    1
  ) $$,
  'collection delete applies'
);
select is((select count(*) from public.collections), 0::bigint, 'collection is deleted');
select is((select count(*) from public.links), 0::bigint, 'collection delete cascades links');
select is((select count(*) from public.workspace_tombstones), 2::bigint, 'collection and descendant receive tombstones');
select is((select revision from public.workspace_sync_state), 2::bigint, 'delete batch increments revision once');
select is(jsonb_array_length(public.load_workspace_snapshot()->'tombstones'), 2, 'canonical load includes owner tombstones');

select is(
  public.apply_workspace_operations(
    '[{"operationId":"40000000-0000-4000-8000-000000000007","deviceId":"50000000-0000-4000-8000-000000000001","sequence":7,"entity":"link","entityId":"30000000-0000-4000-8000-000000000001","action":"update","payload":{"title":"Resurrected"},"createdAt":"2026-08-31T00:00:00Z","baseRevision":2}]'::jsonb,
    2
  ) #>> '{outcomes,0,status}',
  'deleted',
  'stale update against a tombstone is rejected as deleted'
);
select is((select count(*) from public.links), 0::bigint, 'tombstoned link is not resurrected');
select is((select revision from public.workspace_sync_state), 2::bigint, 'deleted outcome does not increment revision');

set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select is((select count(*) from public.workspace_operations), 0::bigint, 'RLS hides another user operation ids');
select is((select count(*) from public.workspace_tombstones), 0::bigint, 'RLS hides another user tombstones');

select * from finish();
rollback;
