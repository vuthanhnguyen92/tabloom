begin;
select no_plan();
insert into auth.users(id,aud,role,email) values ('00000000-0000-4000-8000-000000000011','authenticated','authenticated','delete-generation@example.test');
insert into spaces(id,user_id,name,position) values ('10000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000011','Space',0);
insert into collections(id,user_id,space_id,name,position) values ('20000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000011','10000000-0000-4000-8000-000000000011','Collection',0);
insert into links(id,user_id,collection_id,title,url,position) values ('30000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000011','20000000-0000-4000-8000-000000000011','Original','https://example.test',0);
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000011';
select is((select revision::integer from workspace_sync_state where user_id=auth.uid()),3,'offline device observed revision 3');
select set_config('test.receipt',trash_workspace_entity('link','30000000-0000-4000-8000-000000000011','web',gen_random_uuid(),null)->>'trashId',true);
select restore_workspace_trash(current_setting('test.receipt')::uuid,null);
select is((select revision::integer from workspace_sync_state where user_id=auth.uid()),5,'restoration creates revision 5');
update links set title='Restored and edited' where id='30000000-0000-4000-8000-000000000011';
select set_config('test.stale',jsonb_build_object('operationId','40000000-0000-4000-8000-000000000011','deviceId','50000000-0000-4000-8000-000000000011','sequence',1,'baseRevision',3,'entity','link','entityId','30000000-0000-4000-8000-000000000011','action','delete','payload','{}'::jsonb)::text,true);
select set_config('test.result',apply_workspace_operations(jsonb_build_array(current_setting('test.stale')::jsonb),(select revision from workspace_sync_state where user_id=auth.uid()))::text,true);
select is(current_setting('test.result')::jsonb #>> '{outcomes,0,status}','rejected','stale delete is rejected before mutation');
select matches(current_setting('test.result')::jsonb #>> '{outcomes,0,message}','Refresh.*delete','rejection gives an actionable fresh-delete instruction');
select is((select title from links where id='30000000-0000-4000-8000-000000000011'),'Restored and edited','server contents survive stale delete');
select is(jsonb_array_length(list_workspace_trash()),0,'stale deletion creates no new Trash');
select is(current_setting('test.result')::jsonb #>> '{patches,links,0,title}','Restored and edited','rejection returns canonical recovery patch');
select set_config('test.replay',apply_workspace_operations(jsonb_build_array(current_setting('test.stale')::jsonb),(select revision from workspace_sync_state where user_id=auth.uid()))::text,true);
select is(current_setting('test.replay')::jsonb #>> '{outcomes,0,status}','rejected','lost rejected response replays as rejected');
select set_config('test.fresh',jsonb_set(jsonb_set(current_setting('test.stale')::jsonb,'{operationId}','"40000000-0000-4000-8000-000000000012"'),'{baseRevision}','5')::text,true);
select set_config('test.fresh_result',apply_workspace_operations(jsonb_build_array(current_setting('test.fresh')::jsonb),(select revision from workspace_sync_state where user_id=auth.uid()))::text,true);
select is(current_setting('test.fresh_result')::jsonb #>> '{outcomes,0,status}','applied','same-generation offline delete is accepted despite a later content edit');
select is(jsonb_array_length(list_workspace_trash()),1,'accepted fresh delete has recoverable Trash');
select set_config('test.fresh_replay',apply_workspace_operations(jsonb_build_array(current_setting('test.fresh')::jsonb),(select revision from workspace_sync_state where user_id=auth.uid()))::text,true);
select is(current_setting('test.fresh_replay')::jsonb #>> '{outcomes,0,status}','already_applied','existing delete idempotency is preserved');

reset role;
insert into auth.users(id,aud,role,email) values ('00000000-0000-4000-8000-000000000012','authenticated','authenticated','ordered-delete-generation@example.test');
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000012';
insert into spaces(id,user_id,name,position) values ('10000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000012','Ordered Space',0);
insert into collections(id,user_id,space_id,name,position) values
  ('20000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000012','10000000-0000-4000-8000-000000000012','Source',0),
  ('20000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000012','10000000-0000-4000-8000-000000000012','Destination',1);
insert into links(id,user_id,collection_id,title,url,position) values ('30000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000012','20000000-0000-4000-8000-000000000012','Restored link','https://ordered.example.test',0);
select set_config('test.ordered_receipt',trash_workspace_entity('link','30000000-0000-4000-8000-000000000012','web',gen_random_uuid(),null)->>'trashId',true);
select restore_workspace_trash(current_setting('test.ordered_receipt')::uuid,null);
select set_config('test.ordered_result',apply_workspace_operations(jsonb_build_array(
  jsonb_build_object('operationId','40000000-0000-4000-8000-000000000013','deviceId','50000000-0000-4000-8000-000000000012','sequence',1,'baseRevision',4,'entity','link','entityId','30000000-0000-4000-8000-000000000012','action','reorder','payload',jsonb_build_object('parentId','20000000-0000-4000-8000-000000000013','orderedIds',jsonb_build_array('30000000-0000-4000-8000-000000000012'))),
  jsonb_build_object('operationId','40000000-0000-4000-8000-000000000014','deviceId','50000000-0000-4000-8000-000000000012','sequence',2,'baseRevision',4,'entity','collection','entityId','20000000-0000-4000-8000-000000000013','action','delete','payload','{}'::jsonb),
  jsonb_build_object('operationId','40000000-0000-4000-8000-000000000015','deviceId','50000000-0000-4000-8000-000000000012','sequence',3,'baseRevision',6,'entity','space','entityId','10000000-0000-4000-8000-000000000012','action','update','payload',jsonb_build_object('name','Later operation applied'))
),(select revision from workspace_sync_state where user_id=auth.uid()))::text,true);
select is(current_setting('test.ordered_result')::jsonb #>> '{outcomes,1,status}','rejected','delete is checked after the preceding reorder changes its descendants');
select is((select collection_id::text from links where id='30000000-0000-4000-8000-000000000012'),'20000000-0000-4000-8000-000000000013','preceding reorder survives the rejected delete');
select ok(exists(select 1 from collections where id='20000000-0000-4000-8000-000000000013'),'destination collection survives the rejected delete');
select is((select name from spaces where id='10000000-0000-4000-8000-000000000012'),'Later operation applied','later operation continues after the rejected delete');
select is((select revision::integer from workspace_sync_state where user_id=auth.uid()),7,'accepted operations in the ordinary batch advance one revision');
select * from finish();
rollback;
