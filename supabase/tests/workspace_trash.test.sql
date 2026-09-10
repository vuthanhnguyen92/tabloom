begin;
select plan(18);
select has_table('public', 'workspace_trash', 'workspace trash table exists');
select has_table('public', 'workspace_delete_intents', 'workspace delete intents table exists');
select has_function('public', 'prepare_workspace_delete', array['text', 'uuid']);
select has_function('public', 'trash_workspace_entity', array['text', 'uuid', 'text', 'uuid', 'uuid']);
select has_function('public', 'restore_workspace_trash', array['uuid', 'uuid']);

insert into auth.users(id, aud, role, email) values
 ('00000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'trash-owner@example.test'),
 ('00000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'trash-other@example.test');
insert into public.spaces(id,user_id,name,position) values
 ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Tree',0),
 ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','Destination',1),
 ('10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','Other',0);
insert into public.collections(id,user_id,space_id,name,position) values
 ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','First',0),
 ('20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Second',1),
 ('20000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000003','Other',0);
insert into public.links(id,user_id,collection_id,url,title,position) values
 ('30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','https://first.test','First',0),
 ('30000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','https://second.test','Second',1);
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';

select lives_ok($test$ do $$ declare intent jsonb; begin
 intent := public.prepare_workspace_delete('collection','20000000-0000-4000-8000-000000000001');
 if intent->>'targetName' <> 'First' or (intent->>'linkCount')::int <> 2
    or (intent->>'expiresAt')::timestamptz <> now() + interval '10 minutes' then
   raise exception 'wrong confirmation summary'; end if;
 perform set_config('test.intent', intent->>'intentId', true);
end $$ $test$, 'owner prepares a 10-minute intent with exact descendant counts');

select throws_ok($$select public.prepare_workspace_delete('collection','20000000-0000-4000-8000-000000000003')$$,
 'P0002','workspace collection not found','cross-owner target is indistinguishable from missing');
select throws_ok($$select public.trash_workspace_entity('collection','20000000-0000-4000-8000-000000000001','mcp',gen_random_uuid(),null)$$,
 'P0001','confirmation_required','container deletion requires confirmation');

reset role;
update public.workspace_delete_intents set expires_at = now() - interval '1 second';
set local role authenticated;
select throws_ok($$select public.trash_workspace_entity('collection','20000000-0000-4000-8000-000000000001','mcp',gen_random_uuid(),current_setting('test.intent')::uuid)$$,
 'P0001','confirmation_expired','expired intent cannot delete');
select set_config('test.intent',public.prepare_workspace_delete('collection','20000000-0000-4000-8000-000000000001')->>'intentId',true);
update public.collections set updated_at = now() + interval '1 second' where id = '20000000-0000-4000-8000-000000000001';
select lives_ok($test$ do $$ declare intent uuid; begin
 begin
   perform public.trash_workspace_entity('collection','20000000-0000-4000-8000-000000000001','web',gen_random_uuid(),current_setting('test.intent')::uuid);
   raise exception 'changed root accepted';
 exception when serialization_failure then null; end;
 intent := (public.prepare_workspace_delete('collection','20000000-0000-4000-8000-000000000001')->>'intentId')::uuid;
 update public.links set title='Edited after confirmation' where id='30000000-0000-4000-8000-000000000001';
 begin
   perform public.trash_workspace_entity('collection','20000000-0000-4000-8000-000000000001','web',gen_random_uuid(),intent);
   raise exception 'changed descendant accepted';
 exception when serialization_failure then null; end;
end $$ $test$, 'root timestamps and descendant content changes invalidate confirmation');

select lives_ok($test$ do $$ declare receipt jsonb; rev bigint; begin
 select revision into rev from public.workspace_sync_state where user_id=auth.uid();
 receipt := public.trash_workspace_entity('link','30000000-0000-4000-8000-000000000001','extension','40000000-0000-4000-8000-000000000001',null);
 if receipt->>'rootType' <> 'link' or (receipt->>'restoreUntil')::timestamptz <> now()+interval '30 days'
   or exists(select 1 from public.links where id='30000000-0000-4000-8000-000000000001')
   or (select revision from public.workspace_sync_state where user_id=auth.uid()) <> rev+1 then raise exception 'link deletion failed'; end if;
 if public.trash_workspace_entity('link','30000000-0000-4000-8000-000000000001','extension','40000000-0000-4000-8000-000000000001',null) <> receipt
   or (select revision from public.workspace_sync_state where user_id=auth.uid()) <> rev+1 then raise exception 'retry was not idempotent'; end if;
 begin
   perform public.trash_workspace_entity('link','30000000-0000-4000-8000-000000000002','extension','40000000-0000-4000-8000-000000000001',null);
   raise exception 'operation reused for different target';
 exception when serialization_failure then null; end;
 if (select array_agg(key order by key) from jsonb_object_keys(receipt) key)
   <> array['operationId','restoreUntil','rootId','rootType','trashId'] then raise exception 'invalid receipt contract'; end if;
 perform set_config('test.link_trash',receipt->>'trashId',true);
end $$ $test$, 'link deletes without confirmation, retains 30 days, and operation retry is idempotent');

select lives_ok($test$ do $$ declare receipt jsonb; snapshot jsonb; rev bigint; intent uuid; begin
 intent := (public.prepare_workspace_delete('space','10000000-0000-4000-8000-000000000001')->>'intentId')::uuid;
 perform set_config('test.space_intent',intent::text,true);
 select revision into rev from public.workspace_sync_state where user_id=auth.uid();
 receipt := public.trash_workspace_entity('space','10000000-0000-4000-8000-000000000001','mcp','40000000-0000-4000-8000-000000000002',intent);
 select t.snapshot into snapshot from public.workspace_trash t where id=(receipt->>'trashId')::uuid;
 if jsonb_array_length(snapshot->'spaces') <> 1 or jsonb_array_length(snapshot->'collections') <> 2
    or jsonb_array_length(snapshot->'links') <> 1 or snapshot #>> '{spaces,0,origin}' <> 'saved'
    or snapshot #>> '{spaces,0,read_only}' <> 'false'
    or (select count(*) from public.workspace_tombstones where user_id=auth.uid()) <> 5
    or exists(select 1 from public.spaces where id='10000000-0000-4000-8000-000000000001')
    or (select revision from public.workspace_sync_state where user_id=auth.uid()) <> rev+1 then raise exception 'incomplete tree deletion'; end if;
 if jsonb_array_length(public.list_workspace_trash()) <> 2 then raise exception 'active Trash not listed'; end if;
 perform set_config('test.space_trash',receipt->>'trashId',true);
end $$ $test$, 'space deletion snapshots and tombstones the whole tree in one revision');

select lives_ok($test$ do $$ declare rev bigint; begin
 select revision into rev from public.workspace_sync_state where user_id=auth.uid();
 perform public.restore_workspace_trash(current_setting('test.space_trash')::uuid,null);
 if (select array_agg(id order by position) from public.collections where space_id='10000000-0000-4000-8000-000000000001')
    <> array['20000000-0000-4000-8000-000000000001'::uuid,'20000000-0000-4000-8000-000000000002'::uuid]
    or not exists(select 1 from public.links where id='30000000-0000-4000-8000-000000000002')
    or (select count(*) from public.workspace_tombstones where user_id=auth.uid()) <> 1
    or (select revision from public.workspace_sync_state where user_id=auth.uid()) <> rev+1 then raise exception 'restore lost IDs, order or revision'; end if;
 perform public.restore_workspace_trash(current_setting('test.space_trash')::uuid,null);
 if (select revision from public.workspace_sync_state where user_id=auth.uid()) <> rev+1 then raise exception 'restore retry mutated revision'; end if;
end $$ $test$, 'restore preserves IDs and sibling order, removes tree tombstones and advances revision once');
select throws_ok($$select public.trash_workspace_entity('space','10000000-0000-4000-8000-000000000001','mcp',gen_random_uuid(),current_setting('test.space_intent')::uuid)$$,
 'P0001','confirmation_required','consumed intent cannot be reused after restore');

select lives_ok($test$ do $$ declare result jsonb; intent uuid; receipt jsonb; rev bigint; begin
 intent := (public.prepare_workspace_delete('collection','20000000-0000-4000-8000-000000000001')->>'intentId')::uuid;
 receipt := public.trash_workspace_entity('collection','20000000-0000-4000-8000-000000000001','web',gen_random_uuid(),intent);
 select revision into rev from public.workspace_sync_state where user_id=auth.uid();
 result := public.restore_workspace_trash(current_setting('test.link_trash')::uuid,null);
 if result->>'status' <> 'destination_required' or (select revision from public.workspace_sync_state where user_id=auth.uid()) <> rev then raise exception 'missing parent mutated state'; end if;
 begin
   perform public.restore_workspace_trash(current_setting('test.link_trash')::uuid,'20000000-0000-4000-8000-000000000003');
   raise exception 'cross-owner destination accepted';
 exception when no_data_found then null; end;
 perform public.restore_workspace_trash(current_setting('test.link_trash')::uuid,'20000000-0000-4000-8000-000000000002');
 if not exists(select 1 from public.links where id='30000000-0000-4000-8000-000000000001' and collection_id='20000000-0000-4000-8000-000000000002') then raise exception 'alternate destination failed'; end if;
 intent := (public.prepare_workspace_delete('space','10000000-0000-4000-8000-000000000001')->>'intentId')::uuid;
 perform public.trash_workspace_entity('space','10000000-0000-4000-8000-000000000001','web',gen_random_uuid(),intent);
 select revision into rev from public.workspace_sync_state where user_id=auth.uid();
 result := public.restore_workspace_trash((receipt->>'trashId')::uuid,null);
 if result->>'status' <> 'destination_required' or result->>'destinationType' <> 'space'
   or (select revision from public.workspace_sync_state where user_id=auth.uid()) <> rev then raise exception 'missing space mutated state'; end if;
 perform public.restore_workspace_trash((receipt->>'trashId')::uuid,'10000000-0000-4000-8000-000000000002');
 if not exists(select 1 from public.collections where id='20000000-0000-4000-8000-000000000001' and space_id='10000000-0000-4000-8000-000000000002') then raise exception 'alternate space failed'; end if;
end $$ $test$, 'missing parent is non-mutating and owned alternate collection/space destinations work');

select lives_ok($test$ do $$ begin
 if has_function_privilege('anon','public.trash_workspace_entity(text,uuid,text,uuid,uuid)','EXECUTE')
   or has_function_privilege('service_role','public.trash_workspace_entity(text,uuid,text,uuid,uuid)','EXECUTE')
   or has_function_privilege('authenticated','public.workspace_trash_snapshot(text,uuid)','EXECUTE') then raise exception 'RPC grants too broad'; end if;
 perform set_config('request.jwt.claim.sub','',true);
 begin
   perform public.list_workspace_trash();
   raise exception 'missing authentication accepted';
 exception when invalid_authorization_specification then null; end;
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
 if public.list_workspace_trash() <> '[]'::jsonb or exists(select 1 from public.workspace_trash) or exists(select 1 from public.workspace_delete_intents) then raise exception 'cross-owner data leaked'; end if;
 begin
   perform public.restore_workspace_trash(current_setting('test.space_trash')::uuid,null);
   raise exception 'cross-owner restore succeeded';
 exception when no_data_found then null; end;
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
 begin
   update public.workspace_delete_intents set consumed_at=null;
   raise exception 'client changed intent';
 exception when insufficient_privilege then null; end;
 begin
   delete from public.workspace_trash;
   raise exception 'client deleted trash';
 exception when insufficient_privilege then null; end;
end $$ $test$, 'RLS isolates users and clients cannot mutate Trash or confirmations directly');

reset role;
insert into public.bookmark_sources(id,user_id,device_key,device_name)
 values('50000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','trash-test-browser-device','Browser');
insert into public.bookmark_sync_runs(id,user_id,source_id,generation,status,expected_entry_count)
 values('60000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001',1,'active',1);
insert into public.bookmark_entries(id,user_id,source_id,run_id,chrome_bookmark_id,url,normalized_url,title,folder_path,position)
 values('70000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','1','https://browser.test/','https://browser.test/','Browser','Folder',0);
set local role authenticated;
select lives_ok($test$ do $$ begin
 begin
   perform public.trash_workspace_entity('space','system:browser-bookmarks'::uuid,'web',gen_random_uuid(),null);
   raise exception 'browser projection accepted';
 exception when invalid_text_representation then null; end;
 begin
   perform public.trash_workspace_entity('link','70000000-0000-4000-8000-000000000001','web',gen_random_uuid(),null);
   raise exception 'browser entry deleted';
 exception when insufficient_privilege then
   if sqlerrm <> 'read_only' then raise; end if;
 end;
 if not exists(select 1 from public.bookmark_entries where id='70000000-0000-4000-8000-000000000001') then raise exception 'browser data lost'; end if;
end $$ $test$, 'read-only browser projections and stored browser entries reject deletion');

reset role;
update public.workspace_trash set expires_at=now()-interval '1 second' where id=current_setting('test.space_trash')::uuid;
set local role authenticated;
select lives_ok($test$ do $$ begin
 if exists(select 1 from public.workspace_trash where id=current_setting('test.space_trash')::uuid) then raise exception 'expired trash visible'; end if;
 begin
   perform public.restore_workspace_trash(current_setting('test.space_trash')::uuid,null);
   raise exception 'expired restore succeeded';
 exception when no_data_found then null; end;
 if public.purge_expired_workspace_trash(1) <> 1 then raise exception 'purge failed'; end if;
end $$ $test$, 'expired Trash is hidden, unrestorable and purged in a bounded batch');
select * from finish();
rollback;
