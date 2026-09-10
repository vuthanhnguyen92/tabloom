begin;
select no_plan();

insert into auth.users(id,aud,role,email) values
 ('00000000-0000-4000-8000-000000000001','authenticated','authenticated','restore-versions@example.test');
insert into public.spaces(id,user_id,name,position,created_at,updated_at) values
 ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Tree',0,'2020-01-01Z','2020-01-01Z'),
 ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','Destination',1,'2020-01-01Z','2020-01-01Z');
insert into public.collections(id,user_id,space_id,name,position,created_at,updated_at) values
 ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Tree collection',0,'2020-01-01Z','2020-01-01Z'),
 ('20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','Occupied collection',0,'2020-01-01Z','2020-01-01Z');
insert into public.links(id,user_id,collection_id,url,title,position,created_at,updated_at) values
 ('30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','https://one.test','Tree link',0,'2020-01-01Z','2020-01-01Z'),
 ('30000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','https://two.test','Occupied link',0,'2020-01-01Z','2020-01-01Z'),
 ('30000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','https://three.test','Gap sibling',4,'2020-01-01Z','2020-01-01Z');

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role='authenticated';
select set_config('test.unused_intent',public.prepare_workspace_delete('collection','20000000-0000-4000-8000-000000000001')->>'intentId',true);
select set_config('test.used_intent',public.prepare_workspace_delete('space','10000000-0000-4000-8000-000000000001')->>'intentId',true);
select set_config('test.receipt',public.trash_workspace_entity('space','10000000-0000-4000-8000-000000000001','mcp',
 '40000000-0000-4000-8000-000000000001',current_setting('test.used_intent')::uuid)::text,true);
select ok(not exists(select 1 from jsonb_array_elements(public.load_workspace_snapshot() #> '{snapshot,links}') where value->>'id'='30000000-0000-4000-8000-000000000001'),
 'deleted link is absent from the synchronized snapshot before restore');

-- Another space has occupied the deleted root's old slot.
update public.spaces set position=0 where id='10000000-0000-4000-8000-000000000002';
select public.restore_workspace_trash((current_setting('test.receipt')::jsonb->>'trashId')::uuid,null);
select ok(exists(select 1 from jsonb_array_elements(public.load_workspace_snapshot() #> '{snapshot,links}') where value->>'id'='30000000-0000-4000-8000-000000000001'),
 'fresh synchronized snapshot contains the restored link');
select results_eq('select name,position from public.spaces order by position', $$values ('Tree'::text,0),('Destination'::text,1)$$,
 'space restore inserts before an occupied slot and keeps stable order');
select ok((select bool_and(updated_at > '2020-01-01Z'::timestamptz) from (
 select updated_at from public.spaces where id='10000000-0000-4000-8000-000000000001'
 union all select updated_at from public.collections where id='20000000-0000-4000-8000-000000000001'
 union all select updated_at from public.links where id='30000000-0000-4000-8000-000000000001') restored),
 'space restore assigns fresh server versions to every restored record');
select ok((select updated_at > '2020-01-01Z'::timestamptz from public.spaces where id='10000000-0000-4000-8000-000000000002'),
 'space displaced by restore receives a fresh version');
select ok((select bool_and(created_at='2020-01-01Z'::timestamptz) from (
 select created_at from public.spaces union all select created_at from public.collections union all select created_at from public.links) records),
 'restoration preserves original created_at values');
select lives_ok($test$ do $$ begin
 begin
   perform public.trash_workspace_link_if_unchanged('30000000-0000-4000-8000-000000000001','2020-01-01Z',gen_random_uuid());
   raise exception 'old link timestamp accepted after restore';
 exception when serialization_failure then null; end;
end $$ $test$,'pre-delete expectedUpdatedAt cannot delete a restored descendant');
select lives_ok($test$ do $$ begin
 begin
   perform public.trash_workspace_entity('collection','20000000-0000-4000-8000-000000000001','mcp',gen_random_uuid(),current_setting('test.unused_intent')::uuid);
   raise exception 'unused pre-delete intent accepted after restore';
 exception when serialization_failure then null; end;
end $$ $test$,'unused pre-delete confirmation cannot delete the restored tree');
select lives_ok($test$ do $$ declare rev bigint; begin
 select revision into rev from public.workspace_sync_state where user_id=auth.uid();
 if public.trash_workspace_entity('space','10000000-0000-4000-8000-000000000001','mcp',
   '40000000-0000-4000-8000-000000000001',current_setting('test.used_intent')::uuid) <> current_setting('test.receipt')::jsonb
   or not exists(select 1 from public.spaces where id='10000000-0000-4000-8000-000000000001')
   or (select revision from public.workspace_sync_state where user_id=auth.uid()) <> rev then raise exception 'completed receipt replay mutated restoration'; end if;
end $$ $test$,'completed container operation still replays safely after fresh restore versions');

-- Restore a collection into a different space with an occupied slot.
select set_config('test.collection_version',(select updated_at::text from public.collections where id='20000000-0000-4000-8000-000000000001'),true);
select set_config('test.link_version',(select updated_at::text from public.links where id='30000000-0000-4000-8000-000000000001'),true);
select set_config('test.collection_trash',public.trash_workspace_entity('collection','20000000-0000-4000-8000-000000000001','web',gen_random_uuid(),
 (public.prepare_workspace_delete('collection','20000000-0000-4000-8000-000000000001')->>'intentId')::uuid)->>'trashId',true);
select public.restore_workspace_trash(current_setting('test.collection_trash')::uuid,'10000000-0000-4000-8000-000000000002');
select results_eq($$select name,position from public.collections where space_id='10000000-0000-4000-8000-000000000002' order by position$$,
 $$values ('Tree collection'::text,0),('Occupied collection'::text,1)$$,'alternate collection restore keeps the requested slot and sibling order');
select ok((select updated_at > current_setting('test.collection_version')::timestamptz from public.collections where id='20000000-0000-4000-8000-000000000001')
 and (select updated_at > current_setting('test.link_version')::timestamptz from public.links where id='30000000-0000-4000-8000-000000000001'),
 'alternate collection restoration refreshes root and descendant versions');
select ok((select updated_at > '2020-01-01Z'::timestamptz from public.collections where id='20000000-0000-4000-8000-000000000002'),
 'collection displaced in alternate destination receives a fresh version');

-- Restore a single link into a different collection and normalize a gap.
select set_config('test.link_version',(select updated_at::text from public.links where id='30000000-0000-4000-8000-000000000001'),true);
select set_config('test.link_receipt',public.trash_workspace_link_if_unchanged('30000000-0000-4000-8000-000000000001',
 current_setting('test.link_version')::timestamptz,'40000000-0000-4000-8000-000000000002')::text,true);
select public.restore_workspace_trash((current_setting('test.link_receipt')::jsonb->>'trashId')::uuid,'20000000-0000-4000-8000-000000000002');
select results_eq($$select title,position from public.links where collection_id='20000000-0000-4000-8000-000000000002' order by position$$,
 $$values ('Tree link'::text,0),('Occupied link'::text,1),('Gap sibling'::text,2)$$,'alternate link restore inserts at occupied slot and compacts sibling positions');
select ok((select updated_at > current_setting('test.link_version')::timestamptz from public.links where id='30000000-0000-4000-8000-000000000001'),
 'alternate link restore receives a fresh version');
select ok((select bool_and(updated_at > '2020-01-01Z'::timestamptz) from public.links where id in ('30000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000003')),
 'displaced and compacted links receive fresh versions');
select lives_ok($test$ do $$ begin
 begin
   perform public.trash_workspace_link_if_unchanged('30000000-0000-4000-8000-000000000001',current_setting('test.link_version')::timestamptz,gen_random_uuid());
   raise exception 'old timestamp accepted in alternate destination';
 exception when serialization_failure then null; end;
end $$ $test$,'old timestamp cannot authorize a new deletion after alternate restore');
select lives_ok($test$ do $$ declare rev bigint; version timestamptz; begin
 select revision into rev from public.workspace_sync_state where user_id=auth.uid();
 select updated_at into version from public.links where id='30000000-0000-4000-8000-000000000001';
 perform public.restore_workspace_trash((current_setting('test.link_receipt')::jsonb->>'trashId')::uuid,null);
 if public.trash_workspace_link_if_unchanged('30000000-0000-4000-8000-000000000001',current_setting('test.link_version')::timestamptz,
   '40000000-0000-4000-8000-000000000002') <> current_setting('test.link_receipt')::jsonb
   or (select updated_at from public.links where id='30000000-0000-4000-8000-000000000001') is distinct from version
   or (select revision from public.workspace_sync_state where user_id=auth.uid()) <> rev then raise exception 'restore or delete replay mutated restored data'; end if;
end $$ $test$,'completed link deletion and restore replay preserve the fresh version and revision');

-- A sibling before the insertion slot is not shifted by the make-room update,
-- but filling an earlier gap still changes its position during normalization.
update public.links set position=case id when '30000000-0000-4000-8000-000000000002' then 1 else 2 end;
select set_config('test.predecessor_version',(select updated_at::text from public.links where id='30000000-0000-4000-8000-000000000002'),true);
select set_config('test.gap_trash',public.trash_workspace_entity('link','30000000-0000-4000-8000-000000000001','web',gen_random_uuid(),null)->>'trashId',true);
select public.restore_workspace_trash(current_setting('test.gap_trash')::uuid,null);
select ok((select position=0 and updated_at > current_setting('test.predecessor_version')::timestamptz from public.links where id='30000000-0000-4000-8000-000000000002'),
 'a predecessor changed only by normalization also receives a fresh version');

select * from finish();
rollback;
