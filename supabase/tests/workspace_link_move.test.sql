begin;
select no_plan();

select has_function('public','move_workspace_link',array['uuid','uuid','uuid','jsonb','jsonb','uuid[]','uuid[]']);
insert into auth.users(id,aud,role,email) values
 ('00000000-0000-4000-8000-000000000001','authenticated','authenticated','move@example.test'),
 ('00000000-0000-4000-8000-000000000002','authenticated','authenticated','move-other@example.test');
insert into public.spaces(id,user_id,name,position) values
 ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Workspace',0),
 ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002','Other',0);
insert into public.collections(id,user_id,space_id,name,position) values
 ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Source',0),
 ('20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Destination',1),
 ('20000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','Foreign',0);
insert into public.links(id,user_id,collection_id,url,title,description,favicon_url,position,updated_at) values
 ('30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','https://one.test','Original','Original note','https://one.test/icon',0,'2026-09-10T00:00:00Z'),
 ('30000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','https://two.test','Sibling','','https://two.test/icon',5,'2026-09-10T00:00:00Z'),
 ('30000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','https://three.test','Destination','','https://three.test/icon',7,'2026-09-10T00:00:00Z');

-- Capture the same structural expectations a client saw before another writer.
select set_config('test.move_source','[{"id":"30000000-0000-4000-8000-000000000001","position":0},{"id":"30000000-0000-4000-8000-000000000002","position":5}]',true);
select set_config('test.move_destination','[{"id":"30000000-0000-4000-8000-000000000003","position":7}]',true);
create function pg_temp.move_link() returns bigint language plpgsql as $$ begin
 return public.move_workspace_link(
  '30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
  current_setting('test.move_source')::jsonb,current_setting('test.move_destination')::jsonb,
  array['30000000-0000-4000-8000-000000000002']::uuid[],
  array['30000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000001']::uuid[]);
end $$;
create function pg_temp.capture_state() returns void language plpgsql as $$ begin
 perform set_config('test.move_snapshot',public.workspace_snapshot_json(auth.uid())::text,true);
 perform set_config('test.move_revision',(select revision::text from public.workspace_sync_state where user_id=auth.uid()),true);
end $$;
create function pg_temp.state_unchanged() returns boolean language sql as $$
 select public.workspace_snapshot_json(auth.uid())=current_setting('test.move_snapshot')::jsonb
 and (select revision from public.workspace_sync_state where user_id=auth.uid())=current_setting('test.move_revision')::bigint;
$$;

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role='authenticated';

update public.links set title='Concurrent edit',url='https://edited.test',description='New note',favicon_url='https://edited.test/icon',updated_at='2026-09-10T01:00:00Z'
 where id='30000000-0000-4000-8000-000000000001';
select pg_temp.capture_state();
select lives_ok($$select pg_temp.move_link()$$,'content edit after the captured snapshot does not conflict');
select is((select title||'|'||url||'|'||description||'|'||favicon_url from public.links where id='30000000-0000-4000-8000-000000000001'),
 'Concurrent edit|https://edited.test|New note|https://edited.test/icon','move never overwrites concurrent content');
select results_eq($$select id,collection_id,position from public.links order by id$$,
 $$values ('30000000-0000-4000-8000-000000000001'::uuid,'20000000-0000-4000-8000-000000000002'::uuid,1),
 ('30000000-0000-4000-8000-000000000002'::uuid,'20000000-0000-4000-8000-000000000001'::uuid,0),
 ('30000000-0000-4000-8000-000000000003'::uuid,'20000000-0000-4000-8000-000000000002'::uuid,0)$$,
 'both sibling groups are updated and normalized atomically');
select is((select revision from public.workspace_sync_state where user_id=auth.uid()),current_setting('test.move_revision')::bigint+1,'move advances workspace revision exactly once');
select isnt(current_setting('tabloom.merge_in_progress',true),'on','move restores the revision-trigger guard');
select pg_temp.capture_state();
select throws_ok($$select pg_temp.move_link()$$,'40001','workspace move structure changed','replayed stale membership is rejected');
select ok(pg_temp.state_unchanged(),'membership conflict leaves both groups and revision unchanged');

-- Restore the initial structure only, retaining the concurrent content edit.
update public.links set collection_id='20000000-0000-4000-8000-000000000001',position=0 where id='30000000-0000-4000-8000-000000000001';
update public.links set position=5 where id='30000000-0000-4000-8000-000000000002';
update public.links set position=8 where id='30000000-0000-4000-8000-000000000003';
select pg_temp.capture_state();
select throws_ok($$select pg_temp.move_link()$$,'40001','workspace move structure changed','destination position change invalidates the structural revision');
select ok(pg_temp.state_unchanged(),'position conflict does not partially move or normalize rows');
update public.links set position=7 where id='30000000-0000-4000-8000-000000000003';
insert into public.links(id,user_id,collection_id,url,title,position) values
 ('30000000-0000-4000-8000-000000000004',auth.uid(),'20000000-0000-4000-8000-000000000002','https://new.test','Inserted concurrently',8);
select pg_temp.capture_state();
select throws_ok($$select pg_temp.move_link()$$,'40001','workspace move structure changed','new destination member invalidates the captured membership');
select ok(pg_temp.state_unchanged(),'concurrent insertion is not lost or partially reordered');
select public.trash_workspace_entity('link','30000000-0000-4000-8000-000000000004','web',gen_random_uuid(),null);

select pg_temp.capture_state();
select throws_ok($$select public.move_workspace_link('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000003',current_setting('test.move_source')::jsonb,'[]','{}',array['30000000-0000-4000-8000-000000000001']::uuid[])$$,
 'P0002','workspace collection not found','foreign destination is rejected without disclosing its contents');
select throws_ok($$select public.move_workspace_link('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',current_setting('test.move_source')::jsonb,current_setting('test.move_destination')::jsonb,'{}',array['30000000-0000-4000-8000-000000000001']::uuid[])$$,
 '22023','invalid workspace move order','incomplete output orders cannot drop siblings');
select ok(pg_temp.state_unchanged(),'invalid ownership/order requests leave all state unchanged');

-- Even a row-filtering trigger must not turn the UPDATE into a partial move.
reset role;
create function pg_temp.skip_move_sibling() returns trigger language plpgsql as $$ begin
 if new.id='30000000-0000-4000-8000-000000000002' then return null; end if;
 return new;
end $$;
create trigger test_skip_move_sibling before update on public.links for each row execute function pg_temp.skip_move_sibling();
set local role authenticated;
select pg_temp.capture_state();
select throws_ok($$select pg_temp.move_link()$$,'40001','workspace move structure changed','row-count assertion rejects a filtered partial update');
select ok(pg_temp.state_unchanged(),'row-count conflict rolls back the moved row, siblings, and revision');
reset role;
drop trigger test_skip_move_sibling on public.links;
set local role authenticated;

select public.trash_workspace_entity('link','30000000-0000-4000-8000-000000000001','web',gen_random_uuid(),null);
select pg_temp.capture_state();
select throws_ok($$select pg_temp.move_link()$$,'40001','workspace move structure changed','delete between snapshot and move rejects the whole transaction');
select ok(pg_temp.state_unchanged(),'failed move cannot resurrect or partially modify a deleted link');
select ok(exists(select 1 from public.workspace_tombstones where entity_type='link' and entity_id='30000000-0000-4000-8000-000000000001'),'move retains the deletion tombstone');

-- A stale legacy insert can coexist with a tombstone before client cutover.
-- Matching membership alone must not authorize moving that tombstoned identity.
insert into public.links(id,user_id,collection_id,url,title,position) values
 ('30000000-0000-4000-8000-000000000001',auth.uid(),'20000000-0000-4000-8000-000000000001','https://stale.test','Stale legacy write',0);
select pg_temp.capture_state();
select throws_ok($$select pg_temp.move_link()$$,'40001','workspace move structure changed','explicit tombstone guard rejects even a matching live structure');
select ok(pg_temp.state_unchanged(),'tombstone conflict preserves all rows and revision');

select ok(has_function_privilege('authenticated','public.move_workspace_link(uuid,uuid,uuid,jsonb,jsonb,uuid[],uuid[])','EXECUTE'),'authenticated can execute the RPC');
select ok(not has_function_privilege('anon','public.move_workspace_link(uuid,uuid,uuid,jsonb,jsonb,uuid[],uuid[])','EXECUTE')
 and not has_function_privilege('service_role','public.move_workspace_link(uuid,uuid,uuid,jsonb,jsonb,uuid[],uuid[])','EXECUTE'),'anonymous and service-role execution is revoked');
select ok((select prosecdef and proconfig @> array['search_path=public, pg_temp'] from pg_proc where oid='public.move_workspace_link(uuid,uuid,uuid,jsonb,jsonb,uuid[],uuid[])'::regprocedure),'definer RPC has a pinned safe search path');
select set_config('request.jwt.claim.sub','',true);
select throws_ok($$select pg_temp.move_link()$$,'28000','authentication required','authenticated role still requires an authenticated user');
select * from finish();
rollback;
