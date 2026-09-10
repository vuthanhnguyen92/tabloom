begin;
select plan(13);

select has_table('public', 'workspace_command_receipts', 'durable command receipts exist');
select has_function('public', 'apply_workspace_command', array['uuid','text','text','jsonb','bigint']);

insert into auth.users(id,aud,role,email) values
 ('00000000-0000-4000-8000-000000000001','authenticated','authenticated','command-owner@example.test'),
 ('00000000-0000-4000-8000-000000000002','authenticated','authenticated','command-other@example.test');
insert into public.spaces(id,user_id,name,position) values
 ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Workspace',0);
insert into public.collections(id,user_id,space_id,name,position) values
 ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Source',0),
 ('20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Destination',1);
insert into public.links(id,user_id,collection_id,url,title,position) values
 ('30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','https://one.test','Moving',0),
 ('30000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','https://two.test','Remaining',1),
 ('30000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','https://four.test','Destination',0);

create function pg_temp.command_op(op_id uuid, entity_id uuid, action text, payload jsonb, seq integer default 1)
returns jsonb language sql as $$ select jsonb_build_object(
 'operationId',op_id,'deviceId','50000000-0000-4000-8000-000000000001','sequence',seq,
 'entity','link','entityId',entity_id,'action',action,'payload',payload,'createdAt',now(),'baseRevision',0)
$$;

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role='authenticated';

select lives_ok($test$ do $$ declare result jsonb; operations jsonb; rev bigint; begin
 operations := jsonb_build_array(pg_temp.command_op('40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000003','create',
   jsonb_build_object('id','30000000-0000-4000-8000-000000000003','collection_id','20000000-0000-4000-8000-000000000001',
     'title','Original','url','https://original.test','description','','favicon_url',null,'position',2,'created_at',now(),'updated_at',now())));
 select revision into rev from public.workspace_sync_state where user_id=auth.uid();
 result := public.apply_workspace_command('40000000-0000-4000-8000-000000000001','createCollectionItem',repeat('a',64),operations,rev);
 if result #>> '{snapshot,links,0,title}' <> 'Original' or jsonb_array_length(result #> '{snapshot,links}') <> 1
   or jsonb_array_length(result #> '{snapshot,collections}') <> 1 or jsonb_array_length(result #> '{snapshot,spaces}') <> 1
   or (result->>'revision')::bigint <> rev+1 then raise exception 'wrong scoped response'; end if;
 perform set_config('test.command_response',result::text,true);
 perform set_config('test.command_operations',operations::text,true);
 perform set_config('test.command_revision',rev::text,true);
 if (select response from public.workspace_command_receipts where operation_id='40000000-0000-4000-8000-000000000001') <> result
   then raise exception 'response was not persisted atomically'; end if;
end $$ $test$, 'command stores the original scoped server result in the mutation transaction');

select lives_ok($test$ do $$ declare result jsonb; rev bigint; begin
 update public.links set title='Later edit' where id='30000000-0000-4000-8000-000000000003';
 select revision into rev from public.workspace_sync_state where user_id=auth.uid();
 result := public.apply_workspace_command('40000000-0000-4000-8000-000000000001','createCollectionItem',repeat('a',64),current_setting('test.command_operations')::jsonb,current_setting('test.command_revision')::bigint);
 if result <> current_setting('test.command_response')::jsonb
   or (select revision from public.workspace_sync_state where user_id=auth.uid()) <> rev
   or (select title from public.links where id='30000000-0000-4000-8000-000000000003') <> 'Later edit' then raise exception 'historical replay failed'; end if;
end $$ $test$, 'create replay after editing returns the original response without another write');

select lives_ok($test$ do $$ declare result jsonb; rev bigint; begin
 perform public.trash_workspace_entity('link','30000000-0000-4000-8000-000000000003','mcp','40000000-0000-4000-8000-000000000009',null);
 select revision into rev from public.workspace_sync_state where user_id=auth.uid();
 result := public.apply_workspace_command('40000000-0000-4000-8000-000000000001','createCollectionItem',repeat('a',64),current_setting('test.command_operations')::jsonb,0);
 if result <> current_setting('test.command_response')::jsonb
   or exists(select 1 from public.links where id='30000000-0000-4000-8000-000000000003')
   or (select revision from public.workspace_sync_state where user_id=auth.uid()) <> rev then raise exception 'deleted replay resurrected target'; end if;
end $$ $test$, 'create replay survives deletion and never resurrects the record');

select throws_ok($$select public.apply_workspace_command('40000000-0000-4000-8000-000000000001','createCollectionItem',repeat('b',64),current_setting('test.command_operations')::jsonb,0)$$,
 '40001','workspace command idempotency conflict','different input with the same key conflicts');

select lives_ok($test$ do $$ declare operations jsonb; result jsonb; rev bigint; begin
 operations := jsonb_build_array(
  pg_temp.command_op('40000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001','update','{"collection_id":"20000000-0000-4000-8000-000000000002"}'),
  pg_temp.command_op('40000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000001','reorder','{"parentId":"20000000-0000-4000-8000-000000000001","orderedIds":["30000000-0000-4000-8000-000000000002"]}',2),
  pg_temp.command_op('40000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000002','reorder','{"parentId":"20000000-0000-4000-8000-000000000002","orderedIds":["30000000-0000-4000-8000-000000000004","30000000-0000-4000-8000-000000000001"]}',3));
 select revision into rev from public.workspace_sync_state where user_id=auth.uid();
 result := public.apply_workspace_command('40000000-0000-4000-8000-000000000002','moveCollectionItem',repeat('c',64),operations,rev);
 perform set_config('test.move_operations',operations::text,true);
 if (select array_agg(position order by position) from public.links where collection_id='20000000-0000-4000-8000-000000000001') <> array[0]
   or (select array_agg(id order by position) from public.links where collection_id='20000000-0000-4000-8000-000000000002') <> array['30000000-0000-4000-8000-000000000004'::uuid,'30000000-0000-4000-8000-000000000001'::uuid]
   or (select array_agg(position order by position) from public.links where collection_id='20000000-0000-4000-8000-000000000002') <> array[0,1]
   or (result->>'revision')::bigint <> rev+1 then raise exception 'move did not normalize atomically'; end if;
end $$ $test$, 'move normalizes both populated collections in a single revision');

select throws_ok($$select public.apply_workspace_command('40000000-0000-4000-8000-000000000008','moveCollectionItem',repeat('e',64),
 jsonb_set(jsonb_set(jsonb_set(current_setting('test.move_operations')::jsonb,
 '{0,operationId}','"40000000-0000-4000-8000-000000000008"'),
 '{1,operationId}','"40000000-0000-4000-8000-000000000010"'),
 '{2,operationId}','"40000000-0000-4000-8000-000000000011"'),0)$$,
 '40001','workspace revision conflict','stale moves report conflict before validating obsolete membership');

select lives_ok($test$ do $$ declare operations jsonb; rev bigint; begin
 operations := jsonb_build_array(
  pg_temp.command_op('40000000-0000-4000-8000-000000000005','30000000-0000-4000-8000-000000000001','update','{"collection_id":"20000000-0000-4000-8000-000000000001"}'),
  pg_temp.command_op('40000000-0000-4000-8000-000000000006','20000000-0000-4000-8000-000000000002','reorder','{"parentId":"20000000-0000-4000-8000-000000000002","orderedIds":[]}',2),
  pg_temp.command_op('40000000-0000-4000-8000-000000000007','20000000-0000-4000-8000-000000000001','reorder','{"parentId":"20000000-0000-4000-8000-000000000001","orderedIds":[]}',3));
 select revision into rev from public.workspace_sync_state where user_id=auth.uid();
 begin
  perform public.apply_workspace_command('40000000-0000-4000-8000-000000000005','moveCollectionItem',repeat('d',64),operations,rev);
  raise exception 'invalid membership accepted';
 exception when invalid_parameter_value then null; end;
 if (select collection_id from public.links where id='30000000-0000-4000-8000-000000000001') <> '20000000-0000-4000-8000-000000000002'::uuid
   or (select revision from public.workspace_sync_state where user_id=auth.uid()) <> rev
   or exists(select 1 from public.workspace_command_receipts where operation_id='40000000-0000-4000-8000-000000000005') then raise exception 'partial failed command persisted'; end if;
end $$ $test$, 'invalid reorder membership rolls back the move, revision and receipt');

select lives_ok($test$ do $$ begin
 if has_table_privilege('authenticated','public.workspace_command_receipts','INSERT,UPDATE,DELETE')
   or has_table_privilege('service_role','public.workspace_command_receipts','INSERT,UPDATE,DELETE')
   or has_function_privilege('anon','public.apply_workspace_command(uuid,text,text,jsonb,bigint)','EXECUTE')
   or has_function_privilege('service_role','public.apply_workspace_command(uuid,text,text,jsonb,bigint)','EXECUTE') then raise exception 'receipt grants too broad'; end if;
 begin
  update public.workspace_command_receipts set command_hash=repeat('f',64);
  raise exception 'receipt mutated';
 exception when insufficient_privilege then null; end;
end $$ $test$, 'receipts are immutable to clients and service-role mutation is revoked');

select lives_ok($test$ do $$ begin
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
 if exists(select 1 from public.workspace_command_receipts) then raise exception 'receipt leaked across owners'; end if;
 begin
  perform public.apply_workspace_command('40000000-0000-4000-8000-000000000001','createCollectionItem',repeat('a',64),current_setting('test.command_operations')::jsonb,0);
  raise exception 'other owner received or mutated record';
 exception when invalid_parameter_value or foreign_key_violation then null; end;
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
end $$ $test$, 'RLS isolates receipts and command mutations preserve parent ownership');

select lives_ok($test$ do $$ begin
 perform set_config('request.jwt.claim.sub','',true);
 begin
  perform public.apply_workspace_command('40000000-0000-4000-8000-000000000001','createCollectionItem',repeat('a',64),current_setting('test.command_operations')::jsonb,0);
  raise exception 'unauthenticated command accepted';
 exception when invalid_authorization_specification then null; end;
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
end $$ $test$, 'missing authentication cannot read or write a receipt');

select throws_ok($$select public.apply_workspace_command('40000000-0000-4000-8000-000000000008','createCollectionItem',repeat('e',64),
 jsonb_set(current_setting('test.command_operations')::jsonb,'{0,operationId}','"40000000-0000-4000-8000-000000000008"'),0)$$,
 '40001','workspace revision conflict','new commands reject stale revisions before mutation');

select * from finish();
rollback;
