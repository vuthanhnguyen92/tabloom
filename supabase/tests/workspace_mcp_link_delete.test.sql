begin;
select plan(12);

select has_function('public','trash_workspace_link_if_unchanged',array['uuid','timestamp with time zone','uuid']);
insert into auth.users(id,aud,role,email) values
 ('00000000-0000-4000-8000-000000000001','authenticated','authenticated','mcp-delete@example.test'),
 ('00000000-0000-4000-8000-000000000002','authenticated','authenticated','mcp-delete-other@example.test');
insert into public.spaces(id,user_id,name,position) values
 ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Workspace',0),
 ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002','Other',0);
insert into public.collections(id,user_id,space_id,name,position) values
 ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Collection',0),
 ('20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','Other',0);
insert into public.links(id,user_id,collection_id,url,title,position,updated_at) values
 ('30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','https://one.test','Delete me',0,'2026-09-10T00:00:00.000002Z'),
 ('30000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','https://two.test','Keep me',1,'2026-09-10T00:00:00.000002Z'),
 ('30000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','https://other.test','Other',0,'2026-09-10T00:00:00.000002Z');
insert into public.bookmark_sources(id,user_id,device_key,device_name) values
 ('50000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','mcp-delete-browser','Browser');
insert into public.bookmark_sync_runs(id,user_id,source_id,generation,status,expected_entry_count) values
 ('60000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001',1,'active',1);
insert into public.bookmark_entries(id,user_id,source_id,run_id,chrome_bookmark_id,url,normalized_url,title,folder_path,position) values
 ('70000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','1','https://browser.test/','https://browser.test/','Browser','Folder',0);

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role='authenticated';
select set_config('test.before_revision',(select revision::text from public.workspace_sync_state where user_id=auth.uid()),true);

select throws_ok($$select public.trash_workspace_link_if_unchanged('30000000-0000-4000-8000-000000000001','2026-09-10T00:00:00.000001Z','40000000-0000-4000-8000-000000000001')$$,
 '40001','workspace delete target changed','microsecond timestamp mismatch conflicts inside the deleting transaction');
select lives_ok($test$ do $$ begin
 if not exists(select 1 from public.links where id='30000000-0000-4000-8000-000000000001')
   or exists(select 1 from public.workspace_trash) or exists(select 1 from public.workspace_tombstones)
   or (select revision::text from public.workspace_sync_state where user_id=auth.uid()) <> current_setting('test.before_revision')
   then raise exception 'stale delete changed state'; end if;
end $$ $test$,'timestamp conflict leaves link, Trash, tombstones and revision unchanged');

select lives_ok($test$ do $$ declare receipt jsonb; begin
 receipt := public.trash_workspace_link_if_unchanged('30000000-0000-4000-8000-000000000001','2026-09-10T00:00:00.000002Z','40000000-0000-4000-8000-000000000001');
 if exists(select 1 from public.links where id='30000000-0000-4000-8000-000000000001')
   or (receipt->>'restoreUntil')::timestamptz <> now()+interval '30 days'
   or (select source from public.workspace_trash where id=(receipt->>'trashId')::uuid) <> 'mcp'
   or (select revision from public.workspace_sync_state where user_id=auth.uid()) <> current_setting('test.before_revision')::bigint+1
   then raise exception 'matching delete did not commit once'; end if;
 perform set_config('test.delete_receipt',receipt::text,true);
end $$ $test$,'matching timestamp atomically deletes and returns a 30-day MCP Trash receipt');

select lives_ok($test$ do $$ begin
 if public.trash_workspace_link_if_unchanged('30000000-0000-4000-8000-000000000001','2026-09-09T00:00:00Z','40000000-0000-4000-8000-000000000001') <> current_setting('test.delete_receipt')::jsonb
   or (select revision from public.workspace_sync_state where user_id=auth.uid()) <> current_setting('test.before_revision')::bigint+1
   then raise exception 'replay changed state or response'; end if;
end $$ $test$,'same operation replays before missing or stale timestamp checks');

select throws_ok($$select public.trash_workspace_link_if_unchanged('30000000-0000-4000-8000-000000000001','2026-09-10T00:00:00.000002Z','40000000-0000-4000-8000-000000000002')$$,
 'P0002','workspace link not found','different operation cannot replay an absent target');
select throws_ok($$select public.trash_workspace_link_if_unchanged('30000000-0000-4000-8000-000000000002','2026-09-10T00:00:00.000002Z','40000000-0000-4000-8000-000000000001')$$,
 '40001','workspace operation conflict','operation cannot be reused for a different link');

select lives_ok($test$ do $$ declare rev bigint; begin
 perform public.restore_workspace_trash((current_setting('test.delete_receipt')::jsonb->>'trashId')::uuid,null);
 select revision into rev from public.workspace_sync_state where user_id=auth.uid();
 if public.trash_workspace_link_if_unchanged('30000000-0000-4000-8000-000000000001','2026-09-09T00:00:00Z','40000000-0000-4000-8000-000000000001') <> current_setting('test.delete_receipt')::jsonb
   or not exists(select 1 from public.links where id='30000000-0000-4000-8000-000000000001')
   or (select revision from public.workspace_sync_state where user_id=auth.uid()) <> rev then raise exception 'retry deleted a restored link'; end if;
end $$ $test$,'replaying a restored operation returns its original receipt without deleting again');

select throws_ok($$select public.trash_workspace_link_if_unchanged('30000000-0000-4000-8000-000000000003','2026-09-10T00:00:00.000002Z',gen_random_uuid())$$,
 'P0002','workspace link not found','foreign link is indistinguishable from missing');
select throws_ok($$select public.trash_workspace_link_if_unchanged('70000000-0000-4000-8000-000000000001','2026-09-10T00:00:00.000002Z',gen_random_uuid())$$,
 '42501','read_only','browser bookmark deletion is rejected');
select throws_ok($$select public.trash_workspace_link_if_unchanged('30000000-0000-4000-8000-000000000002',null,gen_random_uuid())$$,
 '22023','invalid workspace link delete request','missing expected timestamp is rejected');
select lives_ok($test$ do $$ begin
 if has_function_privilege('anon','public.trash_workspace_link_if_unchanged(uuid,timestamptz,uuid)','EXECUTE')
   or has_function_privilege('service_role','public.trash_workspace_link_if_unchanged(uuid,timestamptz,uuid)','EXECUTE')
   then raise exception 'RPC grants too broad'; end if;
 perform set_config('request.jwt.claim.sub','',true);
 begin
   perform public.trash_workspace_link_if_unchanged('30000000-0000-4000-8000-000000000002','2026-09-10T00:00:00.000002Z',gen_random_uuid());
   raise exception 'missing authentication accepted';
 exception when invalid_authorization_specification then null; end;
end $$ $test$,'only authenticated owner requests can execute the hardened RPC');
select * from finish();
rollback;
