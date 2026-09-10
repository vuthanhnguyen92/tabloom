begin;
select no_plan();
select has_function('public', 'save_shared_collection', array['text'], 'authenticated save RPC exists');
select has_function('public', 'get_shared_collection_save_state', array['text'], 'recipient save status RPC exists');
select ok(not has_function_privilege('anon', 'public.save_shared_collection(text)', 'EXECUTE'), 'anon cannot save');
select ok(not has_function_privilege('anon', 'public.get_shared_collection_save_state(text)', 'EXECUTE'), 'anon cannot inspect provenance');
select ok(not has_table_privilege('authenticated', 'public.collection_saved_copies', 'INSERT,UPDATE,DELETE'), 'provenance cannot be forged');
insert into auth.users(id, email) values
 ('00000000-0000-0000-0000-00000000000a', 'save-owner@example.test'),
 ('00000000-0000-0000-0000-00000000000b', 'save-recipient@example.test'),
 ('00000000-0000-0000-0000-00000000000c', 'save-empty@example.test');
insert into public.spaces(id, user_id, name, position) values
 ('10000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'Secret space', 0),
 ('10000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'First destination', 0),
 ('10000000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-00000000000b', 'Later destination', 1);
insert into public.collections(id, user_id, space_id, name, position, created_at) values
 ('20000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-00000000000a', '10000000-0000-4000-8000-00000000000a', 'Reading', 0, '2020-01-01'),
 ('20000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-00000000000b', '10000000-0000-4000-8000-00000000000b', 'Existing', 3, '2020-01-01'),
 ('20000000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-00000000000a', '10000000-0000-4000-8000-00000000000a', 'Empty', 1, '2020-01-01');
insert into public.links(id, user_id, collection_id, url, title, description, favicon_url, position, created_at) values
 ('30000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-00000000000a', '20000000-0000-4000-8000-00000000000a', 'https://b.test/', 'B', '', 'https://secret.test/icon', 5, '2020-01-01'),
 ('30000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-00000000000a', '20000000-0000-4000-8000-00000000000a', 'https://a.test/', 'A', 'Note', 'https://secret.test/icon', 5, '2020-01-01'),
 ('30000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-00000000000a', '20000000-0000-4000-8000-00000000000a', 'https://c.test/', 'C', 'Last', null, 5, '2020-01-02');
insert into public.collection_shares(user_id, collection_id, token) values
 ('00000000-0000-0000-0000-00000000000a', '20000000-0000-4000-8000-00000000000a', repeat('A',43)),
 ('00000000-0000-0000-0000-00000000000a', '20000000-0000-4000-8000-00000000000c', repeat('C',43));
set local role authenticated;
set local request.jwt.claim.sub = '';
select throws_ok($$select public.save_shared_collection(repeat('A',43))$$, '28000', 'authentication required', 'save requires identity');
select throws_ok($$select public.get_shared_collection_save_state(repeat('A',43))$$, '28000', 'authentication required', 'status requires identity');
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select is(public.save_shared_collection(repeat('A',43))->>'status', 'owned', 'owner shortcut');
select is(public.get_shared_collection_save_state(repeat('A',43))->>'collectionId', '20000000-0000-4000-8000-00000000000a', 'owner destination');
select is((select count(*) from public.collection_saved_copies), 0::bigint, 'owner creates no mapping');
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select is(public.get_shared_collection_save_state('bad')->>'status', 'unavailable', 'malformed status');
select is(public.get_shared_collection_save_state(repeat('X',43))->>'status', 'unavailable', 'unknown status');
select throws_ok($$select public.save_shared_collection('bad')$$, 'P0002', 'shared collection unavailable', 'invalid save rejected');
select is(public.get_shared_collection_save_state(repeat('A',43))->>'status', 'available', 'new recipient can save');
select set_config('test.before_revision', (public.get_workspace_revision()->>'revision'), true);
select set_config('test.saved', public.save_shared_collection(repeat('A',43))::text, true);
select is(current_setting('test.saved')::jsonb->>'status', 'created', 'creates copy');
select is(current_setting('test.saved')::jsonb->>'spaceId', '10000000-0000-4000-8000-00000000000b', 'first ordinary space selected');
select set_config('test.copy', current_setting('test.saved')::jsonb->>'collectionId', true);
select isnt(current_setting('test.copy'), '20000000-0000-4000-8000-00000000000a', 'fresh collection ID');
select is((select name from public.collections where id=current_setting('test.copy')::uuid), 'Reading', 'name preserved');
select is((select position from public.collections where id=current_setting('test.copy')::uuid), 4, 'appends destination');
select ok((select created_at > '2020-01-01' from public.collections where id=current_setting('test.copy')::uuid), 'fresh collection timestamp');
select is((select jsonb_agg(jsonb_build_array(title,url,description,position) order by position) from public.links where collection_id=current_setting('test.copy')::uuid),
 '[ ["A","https://a.test/","Note",0], ["B","https://b.test/","",1], ["C","https://c.test/","Last",2] ]'::jsonb, 'content and tied order preserved');
select ok((select bool_and(favicon_url is null and created_at > '2020-01-02' and id not in ('30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000003')) from public.links where collection_id=current_setting('test.copy')::uuid), 'fresh links without favicons');
select is((select count(*) from public.collection_shares), 0::bigint, 'copy is private');
select ok((public.get_workspace_revision()->>'revision')::bigint > current_setting('test.before_revision')::bigint, 'create changes revision');
select ok(exists(select 1 from jsonb_array_elements(public.load_workspace_snapshot() #> '{snapshot,collections}') item where item->>'id'=current_setting('test.copy')), 'extension snapshot contains copy');
select set_config('test.after_revision', public.get_workspace_revision()->>'revision', true);
select is(public.save_shared_collection(repeat('A',43))->>'collectionId', current_setting('test.copy'), 'retry returns same copy');
select is(public.save_shared_collection(repeat('A',43))->>'status', 'saved', 'repeat status');
select is(public.get_workspace_revision()->>'revision', current_setting('test.after_revision'), 'repeat leaves revision unchanged');
update public.collections set space_id='10000000-0000-4000-8000-00000000000c' where id=current_setting('test.copy')::uuid;
select is(public.get_shared_collection_save_state(repeat('A',43))->>'spaceId', '10000000-0000-4000-8000-00000000000c', 'status follows moved copy');
select is(public.save_shared_collection(repeat('A',43))->>'spaceId', '10000000-0000-4000-8000-00000000000c', 'save follows moved copy');
select throws_ok($$delete from public.collection_saved_copies$$, '42501', null, 'recipient cannot directly delete provenance');
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
select is((select count(*) from public.collection_saved_copies), 0::bigint, 'other recipient cannot read provenance');
-- Inject a late write failure to prove default space, collection, and links roll back.
reset role;
create function pg_temp.reject_test_copy_link() returns trigger language plpgsql as $$
begin
  if new.user_id = '00000000-0000-0000-0000-00000000000c' then
    raise exception 'test copy rejected';
  end if;
  return new;
end;
$$;
create trigger test_reject_copy before insert on public.links
  for each row execute function pg_temp.reject_test_copy_link();
set local role authenticated;
select throws_ok($$select public.save_shared_collection(repeat('A',43))$$, 'P0001', 'test copy rejected', 'late insertion error propagates');
select is((select count(*) from public.spaces), 0::bigint, 'failed save rolls back default space');
select is((select count(*) from public.collections), 0::bigint, 'failed save rolls back collection');
select is((select count(*) from public.links), 0::bigint, 'failed save rolls back links');
select is((select count(*) from public.collection_saved_copies), 0::bigint, 'failed save creates no provenance');
reset role;
drop trigger test_reject_copy on public.links;
set local role authenticated;
select set_config('test.empty_saved', public.save_shared_collection(repeat('C',43))::text, true);
select is(current_setting('test.empty_saved')::jsonb->>'status', 'created', 'empty source can be saved');
select is((select name from public.spaces), 'My collections', 'default space created');
select is((select color from public.spaces), '#f56f72', 'default space color');
select is((select count(*) from public.links), 0::bigint, 'empty copy has no links');
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select set_config('test.new_token', (select token from public.regenerate_collection_share('20000000-0000-4000-8000-00000000000a')), true);
update public.collections set name='Changed source' where id='20000000-0000-4000-8000-00000000000a';
update public.links set title='Changed link' where id='30000000-0000-4000-8000-000000000001';
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select is(public.get_shared_collection_save_state(repeat('A',43))->>'status', 'unavailable', 'old token unavailable');
select is(public.save_shared_collection(current_setting('test.new_token'))->>'collectionId', current_setting('test.copy'), 'deduplicates regenerated tokens');
select is((select name from public.collections where id=current_setting('test.copy')::uuid), 'Reading', 'source edits leave copy unchanged');
delete from public.collections where id=current_setting('test.copy')::uuid;
select is((select count(*) from public.collection_saved_copies), 0::bigint, 'copy deletion clears provenance');
select is(public.get_shared_collection_save_state(current_setting('test.new_token'))->>'status', 'available', 'view does not recreate deleted copy');
select set_config('test.resaved', public.save_shared_collection(current_setting('test.new_token'))::text, true);
select isnt(current_setting('test.resaved')::jsonb->>'collectionId', current_setting('test.copy'), 'explicit save creates fresh copy');
select is((select name from public.collections where id=(current_setting('test.resaved')::jsonb->>'collectionId')::uuid), 'Changed source', 'new save uses current snapshot');
delete from public.spaces where id=(current_setting('test.resaved')::jsonb->>'spaceId')::uuid;
select is(public.get_shared_collection_save_state(current_setting('test.new_token'))->>'status', 'available', 'space deletion permits new save');
select set_config('test.surviving', public.save_shared_collection(current_setting('test.new_token'))::text, true);
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select public.disable_collection_share('20000000-0000-4000-8000-00000000000a');
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select throws_ok($$select public.save_shared_collection(current_setting('test.new_token'))$$, 'P0002', 'shared collection unavailable', 'revoked save rejected');
select is((select count(*) from public.collection_saved_copies), 1::bigint, 'revocation preserves existing copy');
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
delete from public.collections where id='20000000-0000-4000-8000-00000000000a';
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select is((select count(*) from public.collection_saved_copies), 1::bigint, 'source deletion preserves provenance');
select ok(exists(select 1 from public.collections where id=(current_setting('test.surviving')::jsonb->>'collectionId')::uuid), 'source deletion preserves copy');
reset role;
select * from finish();
rollback;
