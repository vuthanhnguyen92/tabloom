begin;
select no_plan();
insert into auth.users(id,aud,role,email) values
 ('00000000-0000-4000-8000-000000000001','authenticated','authenticated','purge-owner@example.test'),
 ('00000000-0000-4000-8000-000000000002','authenticated','authenticated','purge-other@example.test');
insert into public.spaces(id,user_id,name,position) values
 ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Workspace',0);
insert into public.collections(id,user_id,space_id,name,position) values
 ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Collection',0);
insert into public.links(id,user_id,collection_id,url,title,position) values
 ('30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','https://one.test','Still trashed',0),
 ('30000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','https://two.test','Restored',1);
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role='authenticated';
select set_config('test.active_receipt',public.trash_workspace_link_if_unchanged('30000000-0000-4000-8000-000000000001',now(),
 '40000000-0000-4000-8000-000000000001')::text,true);
select set_config('test.restored_receipt',public.trash_workspace_link_if_unchanged('30000000-0000-4000-8000-000000000002',now(),
 '40000000-0000-4000-8000-000000000002')::text,true);
select public.restore_workspace_trash((current_setting('test.restored_receipt')::jsonb->>'trashId')::uuid,null);
select set_config('test.revision',(select revision::text from public.workspace_sync_state where user_id=auth.uid()),true);
reset role;
-- An owner has more than one list call's cleanup budget. The other owner's row
-- must survive both calls even though this fixture bypasses RLS for inspection.
insert into public.workspace_trash(user_id,root_type,root_id,root_name,snapshot,source,expires_at)
 select '00000000-0000-4000-8000-000000000001','link',gen_random_uuid(),'Expired','{"version":1}', 'web',now()-interval '1 second'
 from generate_series(1,101);
insert into public.workspace_trash(user_id,root_type,root_id,root_name,snapshot,source,expires_at)
 values('00000000-0000-4000-8000-000000000002','link',gen_random_uuid(),'Other expired','{"version":1}','web',now()-interval '1 second');
set local role authenticated;
select is(jsonb_array_length(public.list_workspace_trash()),1,'normal Trash list returns only the active, unrestored entry');
reset role;
select is((select count(*) from public.workspace_trash where user_id='00000000-0000-4000-8000-000000000001' and expires_at<=now()),1::bigint,
 'normal list physically purges only its bounded batch of 100 expired owner rows');
select is((select count(*) from public.workspace_trash where user_id='00000000-0000-4000-8000-000000000002'),1::bigint,
 'normal list does not purge another owner expired row');
set local role authenticated;
select is(jsonb_array_length(public.list_workspace_trash()),1,'subsequent Trash list remains active-only');
reset role;
select is((select count(*) from public.workspace_trash where user_id='00000000-0000-4000-8000-000000000001' and expires_at<=now()),0::bigint,
 'subsequent normal list finishes owner cleanup');
select is((select count(*) from public.workspace_trash where user_id='00000000-0000-4000-8000-000000000002'),1::bigint,
 'other owner expired row remains after repeated access');
set local role authenticated;
select is(public.trash_workspace_link_if_unchanged('30000000-0000-4000-8000-000000000001',now(),'40000000-0000-4000-8000-000000000001'),
 current_setting('test.active_receipt')::jsonb,'cleanup retains original active deletion receipt within retention');
select is(public.trash_workspace_link_if_unchanged('30000000-0000-4000-8000-000000000002',now(),'40000000-0000-4000-8000-000000000002'),
 current_setting('test.restored_receipt')::jsonb,'cleanup retains restored operation receipt within retention');
select ok(exists(select 1 from public.links where id='30000000-0000-4000-8000-000000000002'),
 'restored receipt replay after cleanup never deletes the restored link');
select is((select revision::text from public.workspace_sync_state where user_id=auth.uid()),current_setting('test.revision'),
 'cleanup and retained receipt retries do not mutate workspace revision');
select * from finish();
rollback;
