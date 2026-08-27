begin;

select plan(34);

select has_table('public', 'bookmark_sources', 'bookmark sources table exists');
select has_table('public', 'bookmark_sync_runs', 'bookmark sync runs table exists');
select has_table('public', 'bookmark_entries', 'bookmark entries table exists');
select has_function('public', 'begin_bookmark_sync', array['text', 'text', 'integer'], 'begin sync RPC exists');
select has_function('public', 'append_bookmark_sync_batch', array['uuid', 'jsonb'], 'append batch RPC exists');
select has_function('public', 'finalize_bookmark_sync', array['uuid'], 'finalize sync RPC exists');
select has_function('public', 'rename_bookmark_source', array['uuid', 'text'], 'rename source RPC exists');
select has_function('public', 'forget_bookmark_source', array['uuid'], 'forget source RPC exists');

insert into auth.users(id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@example.test', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@example.test', '', '{}'::jsonb, '{}'::jsonb, now(), now());

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
set local request.jwt.claim.role = 'authenticated';

select lives_ok(
  $$ select * from public.begin_bookmark_sync('device-a-00000001', 'Chrome on macOS', 2) $$,
  'owner can begin a sync'
);
select is((select count(*) from public.bookmark_sources), 1::bigint, 'owner sees the created source');
select is((select generation from public.bookmark_sync_runs where status = 'staging'), 1::bigint, 'first run receives generation one');

select lives_ok(
  format(
    'select public.append_bookmark_sync_batch(%L::uuid, %L::jsonb)',
    (select id from public.bookmark_sync_runs where status = 'staging'),
    '[{"chrome_bookmark_id":"one","url":"https://example.com/one","normalized_url":"https://example.com/one","title":"One","folder_path":"Work","syncing":true,"position":0}]'
  ),
  'owner can append a valid batch'
);
select is((select count(*) from public.bookmark_entries), 1::bigint, 'the valid entry is staged');
select throws_ok(
  format('select * from public.finalize_bookmark_sync(%L::uuid)', (select id from public.bookmark_sync_runs where status = 'staging')),
  '22000', null, 'count mismatch rejects finalization'
);
select is((select active_run_id from public.bookmark_sources), null::uuid, 'count mismatch preserves the prior active pointer');

select lives_ok(
  $$ select * from public.begin_bookmark_sync('device-a-00000001', 'Chrome on macOS', 1) $$,
  'a replacement sync can begin'
);
select is((select count(*) from public.bookmark_sync_runs where status = 'abandoned'), 1::bigint, 'a prior staging run becomes abandoned');
select is((select max(generation) from public.bookmark_sync_runs), 2::bigint, 'replacement run receives the next generation');
select lives_ok(
  format(
    'select public.append_bookmark_sync_batch(%L::uuid, %L::jsonb)',
    (select id from public.bookmark_sync_runs where status = 'staging'),
    '[{"chrome_bookmark_id":"two","url":"https://example.com/two","normalized_url":"https://example.com/two","title":"Two","folder_path":"Work / Design","syncing":true,"position":0}]'
  ),
  'replacement batch uploads'
);
select lives_ok(
  format('select * from public.finalize_bookmark_sync(%L::uuid)', (select id from public.bookmark_sync_runs where status = 'staging')),
  'complete generation activates'
);
select is(
  (select r.generation from public.bookmark_sources s join public.bookmark_sync_runs r on r.id = s.active_run_id),
  2::bigint,
  'newest complete generation is active'
);

select lives_ok(
  $$ select * from public.begin_bookmark_sync('device-a-00000001', 'Chrome on macOS', 1) $$,
  'another generation can stage beside the active snapshot'
);
select throws_ok(
  format(
    'select public.append_bookmark_sync_batch(%L::uuid, %L::jsonb)',
    (select id from public.bookmark_sync_runs where status = 'staging'),
    '[{"chrome_bookmark_id":"internal","url":"chrome://settings","normalized_url":"chrome://settings","title":"Settings","folder_path":"Unfiled bookmarks","syncing":null,"position":0}]'
  ),
  '23514', null, 'unsupported URLs are rejected by the database'
);
select is(
  (select r.generation from public.bookmark_sources s join public.bookmark_sync_runs r on r.id = s.active_run_id),
  2::bigint,
  'a failed staged write leaves the active generation unchanged'
);

set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select is((select count(*) from public.bookmark_sources), 0::bigint, 'RLS hides another user source');
select is((select count(*) from public.bookmark_sync_runs), 0::bigint, 'RLS hides another user runs');
select is((select count(*) from public.bookmark_entries), 0::bigint, 'RLS hides another user entries');

reset role;
select throws_ok(
  format(
    'insert into public.bookmark_sync_runs(user_id, source_id, generation, status, expected_entry_count) values (%L::uuid, %L::uuid, 99, %L, 0)',
    '00000000-0000-0000-0000-00000000000b',
    (select id from public.bookmark_sources where device_key = 'device-a-00000001'),
    'staging'
  ),
  '23503', null, 'composite ownership rejects a cross-user source reference'
);

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select lives_ok(
  format('select public.rename_bookmark_source(%L::uuid, %L)', (select id from public.bookmark_sources), 'Work Mac'),
  'owner can rename a source'
);
select is((select device_name from public.bookmark_sources), 'Work Mac', 'renamed source is canonical');
select lives_ok(
  format('select public.forget_bookmark_source(%L::uuid)', (select id from public.bookmark_sources)),
  'owner can forget a source'
);
select is((select count(*) from public.bookmark_sources), 0::bigint, 'forget removes the selected source');
select is((select count(*) from public.bookmark_sync_runs), 0::bigint, 'forget cascades to source runs');
select is((select count(*) from public.bookmark_entries), 0::bigint, 'forget cascades to source entries');

select * from finish();
rollback;
