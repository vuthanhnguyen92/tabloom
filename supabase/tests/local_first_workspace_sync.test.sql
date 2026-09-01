begin;

select plan(52);

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

select throws_ok(
  $$ select public.apply_workspace_operations(
    '[{"operationId":"40000000-0000-4000-8000-000000000008","deviceId":"50000000-0000-4000-8000-000000000001","sequence":8,"entity":"collection","entityId":"10000000-0000-4000-8000-000000000001","action":"reorder","payload":{"parentId":"10000000-0000-4000-8000-000000000001","orderedIds":["20000000-0000-4000-8000-000000000001","20000000-0000-4000-8000-000000000001"]},"createdAt":"2026-08-31T00:00:00Z","baseRevision":1}]'::jsonb,
    1
  ) $$,
  '22023',
  'invalid collection reorder',
  'collection reorder rejects duplicate ids'
);
select is((select revision from public.workspace_sync_state), 1::bigint, 'invalid collection reorder does not increment revision');

select throws_ok(
  $$ select public.apply_workspace_operations(
    '[{"operationId":"40000000-0000-4000-8000-000000000009","deviceId":"50000000-0000-4000-8000-000000000001","sequence":9,"entity":"link","entityId":"20000000-0000-4000-8000-000000000001","action":"reorder","payload":{"parentId":"20000000-0000-4000-8000-000000000001","orderedIds":["30000000-0000-4000-8000-000000000001","30000000-0000-4000-8000-000000000001"]},"createdAt":"2026-08-31T00:00:00Z","baseRevision":1}]'::jsonb,
    1
  ) $$,
  '22023',
  'invalid link reorder',
  'link reorder rejects duplicate ids'
);
select is((select revision from public.workspace_sync_state), 1::bigint, 'invalid link reorder does not increment revision');

select lives_ok(
  $$ select public.apply_workspace_operations(
    '[
      {"operationId":"40000000-0000-4000-8000-000000000010","deviceId":"50000000-0000-4000-8000-000000000001","sequence":10,"entity":"collection","entityId":"20000000-0000-4000-8000-000000000002","action":"create","payload":{"id":"20000000-0000-4000-8000-000000000002","space_id":"10000000-0000-4000-8000-000000000001","name":"Temporary","position":1,"created_at":"2026-08-31T00:00:00Z","updated_at":"2026-08-31T00:00:00Z"},"createdAt":"2026-08-31T00:00:00Z","baseRevision":1},
      {"operationId":"40000000-0000-4000-8000-000000000011","deviceId":"50000000-0000-4000-8000-000000000001","sequence":11,"entity":"link","entityId":"30000000-0000-4000-8000-000000000002","action":"create","payload":{"id":"30000000-0000-4000-8000-000000000002","collection_id":"20000000-0000-4000-8000-000000000002","url":"https://temporary.example/","title":"Temporary","description":"","favicon_url":null,"position":0,"created_at":"2026-08-31T00:00:00Z","updated_at":"2026-08-31T00:00:00Z"},"createdAt":"2026-08-31T00:00:00Z","baseRevision":1}
    ]'::jsonb,
    1
  ) $$,
  'second hierarchy applies for mixed-delete regression'
);
select lives_ok(
  $$ select public.apply_workspace_operations(
    '[
      {"operationId":"40000000-0000-4000-8000-000000000012","deviceId":"50000000-0000-4000-8000-000000000001","sequence":12,"entity":"link","entityId":"30000000-0000-4000-8000-000000000001","action":"update","payload":{"title":"Still here"},"createdAt":"2026-08-31T00:00:00Z","baseRevision":2},
      {"operationId":"40000000-0000-4000-8000-000000000013","deviceId":"50000000-0000-4000-8000-000000000001","sequence":13,"entity":"collection","entityId":"20000000-0000-4000-8000-000000000002","action":"delete","payload":{},"createdAt":"2026-08-31T00:00:00Z","baseRevision":2}
    ]'::jsonb,
    2
  ) $$,
  'mixed update and unrelated collection delete applies'
);
select is((select title from public.links where id = '30000000-0000-4000-8000-000000000001'), 'Still here', 'unrelated updated link survives the delete');
select is((select count(*) from public.workspace_tombstones where entity_id = '30000000-0000-4000-8000-000000000001'), 0::bigint, 'unrelated updated link receives no tombstone');
select is((select count(*) from public.workspace_tombstones), 2::bigint, 'only deleted collection descendants receive mixed-batch tombstones');

select lives_ok(
  $$ select public.apply_workspace_operations(
    '[{"operationId":"40000000-0000-4000-8000-000000000006","deviceId":"50000000-0000-4000-8000-000000000001","sequence":6,"entity":"collection","entityId":"20000000-0000-4000-8000-000000000001","action":"delete","payload":{},"createdAt":"2026-08-31T00:00:00Z","baseRevision":1}]'::jsonb,
    3
  ) $$,
  'collection delete applies'
);
select is((select count(*) from public.collections), 0::bigint, 'collection is deleted');
select is((select count(*) from public.links), 0::bigint, 'collection delete cascades links');
select is((select count(*) from public.workspace_tombstones), 4::bigint, 'collection and descendant receive tombstones');
select is((select revision from public.workspace_sync_state), 4::bigint, 'delete batch increments revision once');
select is(jsonb_array_length(public.load_workspace_snapshot()->'tombstones'), 4, 'canonical load includes owner tombstones');

select is(
  public.apply_workspace_operations(
    '[{"operationId":"40000000-0000-4000-8000-000000000007","deviceId":"50000000-0000-4000-8000-000000000001","sequence":7,"entity":"link","entityId":"30000000-0000-4000-8000-000000000001","action":"update","payload":{"title":"Resurrected"},"createdAt":"2026-08-31T00:00:00Z","baseRevision":2}]'::jsonb,
    4
  ) #>> '{outcomes,0,status}',
  'deleted',
  'stale update against a tombstone is rejected as deleted'
);
select is((select count(*) from public.links), 0::bigint, 'tombstoned link is not resurrected');
select is((select revision from public.workspace_sync_state), 4::bigint, 'deleted outcome does not increment revision');
select is(
  jsonb_array_length(public.apply_workspace_operations(
    '[{"operationId":"40000000-0000-4000-8000-000000000014","deviceId":"50000000-0000-4000-8000-000000000001","sequence":14,"entity":"link","entityId":"30000000-0000-4000-8000-000000000001","action":"update","payload":{"title":"Still deleted"},"createdAt":"2026-08-31T00:00:00Z","baseRevision":4}]'::jsonb,
    4
  )->'tombstones'),
  1,
  'deleted outcomes return the older tombstone needed to clear stale local data'
);

insert into public.collections(id, user_id, space_id, name, position)
values ('20000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-00000000000a', '10000000-0000-4000-8000-000000000001', 'Legacy removed', 0);
delete from public.collections
where user_id = '00000000-0000-0000-0000-00000000000a'
  and id = '20000000-0000-4000-8000-000000000003';

select is(
  public.apply_workspace_operations(
    '[{"operationId":"40000000-0000-4000-8000-000000000015","deviceId":"50000000-0000-4000-8000-000000000001","sequence":15,"entity":"collection","entityId":"20000000-0000-4000-8000-000000000003","action":"delete","payload":{},"createdAt":"2026-08-31T00:00:00Z","baseRevision":4}]'::jsonb,
    4
  ) #>> '{outcomes,0,status}',
  'deleted',
  'a legacy-missing collection delete is acknowledged'
);
select is((select revision from public.workspace_sync_state), 5::bigint, 'a recovery tombstone advances the revision');
select is((select count(*) from public.workspace_tombstones where entity_type = 'collection' and entity_id = '20000000-0000-4000-8000-000000000003'), 1::bigint, 'legacy-missing collection receives a recovery tombstone');
select is((select count(*) from public.workspace_operations where operation_id = '40000000-0000-4000-8000-000000000015'), 1::bigint, 'legacy-missing delete operation is recorded');

select is(
  public.apply_workspace_operations(
    '[{"operationId":"40000000-0000-4000-8000-000000000016","deviceId":"50000000-0000-4000-8000-000000000001","sequence":16,"entity":"collection","entityId":"20000000-0000-4000-8000-000000000003","action":"delete","payload":{},"createdAt":"2026-08-31T00:00:00Z","baseRevision":5}]'::jsonb,
    5
  ) #>> '{outcomes,0,status}',
  'deleted',
  'a repeated missing delete is idempotent'
);
select is((select revision from public.workspace_sync_state), 5::bigint, 'a repeated missing delete does not advance the revision');

insert into public.collections(id, user_id, space_id, name, position)
values ('20000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-00000000000a', '10000000-0000-4000-8000-000000000001', 'Existing delete', 0);
select lives_ok(
  $$ select public.apply_workspace_operations(
    '[
      {"operationId":"40000000-0000-4000-8000-000000000017","deviceId":"50000000-0000-4000-8000-000000000001","sequence":17,"entity":"collection","entityId":"20000000-0000-4000-8000-000000000005","action":"delete","payload":{},"createdAt":"2026-08-31T00:00:00Z","baseRevision":5},
      {"operationId":"40000000-0000-4000-8000-000000000018","deviceId":"50000000-0000-4000-8000-000000000001","sequence":18,"entity":"collection","entityId":"20000000-0000-4000-8000-000000000004","action":"delete","payload":{},"createdAt":"2026-08-31T00:00:00Z","baseRevision":5}
    ]'::jsonb,
    5
  ) $$,
  'a batch can combine missing and existing deletes'
);
select is((select revision from public.workspace_sync_state), 6::bigint, 'mixed recovery and existing deletes advance the batch revision once');
select is((select count(*) from public.collections where id = '20000000-0000-4000-8000-000000000004'), 0::bigint, 'mixed batch deletes the existing collection');
select is((select count(*) from public.workspace_tombstones where entity_type = 'collection' and entity_id in ('20000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000005')), 2::bigint, 'mixed batch records both collection tombstones');

reset role;
insert into public.spaces(id, user_id, name, color, position)
values ('10000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'Other owner', '#7357e6', 0);
insert into public.collections(id, user_id, space_id, name, position)
values ('20000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-00000000000b', '10000000-0000-4000-8000-00000000000b', 'Private', 0);
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
set local request.jwt.claim.role = 'authenticated';
select throws_ok(
  $$ select public.apply_workspace_operations(
    '[{"operationId":"40000000-0000-4000-8000-000000000019","deviceId":"50000000-0000-4000-8000-000000000001","sequence":19,"entity":"collection","entityId":"20000000-0000-4000-8000-00000000000b","action":"delete","payload":{},"createdAt":"2026-08-31T00:00:00Z","baseRevision":7}]'::jsonb,
    6
  ) $$,
  '23503',
  'cross-owner workspace id',
  'cross-owner missing recovery remains rejected'
);

set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select is((select count(*) from public.workspace_operations), 0::bigint, 'RLS hides another user operation ids');
select is((select count(*) from public.workspace_tombstones), 0::bigint, 'RLS hides another user tombstones');

select * from finish();
rollback;
