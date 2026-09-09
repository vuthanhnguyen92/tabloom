-- A cross-collection move has one structural compare-and-swap boundary. Content
-- edits are deliberately not part of that version and are never copied back.
create function public.move_workspace_link(
  p_link_id uuid,
  p_source_collection_id uuid,
  p_destination_collection_id uuid,
  p_expected_source jsonb,
  p_expected_destination jsonb,
  p_source_ordered_ids uuid[],
  p_destination_ordered_ids uuid[]
) returns bigint
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
  expected_source jsonb;
  expected_destination jsonb;
  current_source jsonb;
  current_destination jsonb;
  source_ids uuid[];
  destination_ids uuid[];
  affected_count integer;
  updated_count integer;
  next_revision bigint;
  previous_merge_setting text := current_setting('tabloom.merge_in_progress', true);
begin
  if owner_id is null then
    raise exception using errcode='28000', message='authentication required';
  end if;
  if p_link_id is null or p_source_collection_id is null or p_destination_collection_id is null
    or p_source_collection_id=p_destination_collection_id
    or p_expected_source is null or jsonb_typeof(p_expected_source)<>'array'
    or p_expected_destination is null or jsonb_typeof(p_expected_destination)<>'array'
    or p_source_ordered_ids is null or p_destination_ordered_ids is null then
    raise exception using errcode='22023', message='invalid workspace move request';
  end if;
  if exists(select 1 from jsonb_to_recordset(p_expected_source || p_expected_destination) as x(id uuid, position integer)
    where x.id is null or x.position is null or x.position<0) then
    raise exception using errcode='22023', message='invalid workspace move request';
  end if;

  -- Same lock order as sync/Trash. Parent locks exclude FK insert/move phantoms;
  -- row locks retain any content edits committed before this transaction wins.
  insert into public.workspace_sync_state(user_id) values(owner_id) on conflict(user_id) do nothing;
  perform 1 from public.workspace_sync_state where user_id=owner_id for update;
  perform 1 from public.spaces s where s.user_id=owner_id and s.id in
    (select c.space_id from public.collections c where c.user_id=owner_id and c.id in (p_source_collection_id,p_destination_collection_id))
    order by s.id for update;
  perform 1 from public.collections c where c.user_id=owner_id and c.id in (p_source_collection_id,p_destination_collection_id)
    order by c.id for update;
  if (select count(*) from public.collections c join public.spaces s on s.id=c.space_id and s.user_id=c.user_id
      where c.user_id=owner_id and c.id in (p_source_collection_id,p_destination_collection_id))<>2 then
    raise exception using errcode='P0002', message='workspace collection not found';
  end if;
  perform 1 from public.links l where l.user_id=owner_id and l.collection_id in (p_source_collection_id,p_destination_collection_id)
    order by l.id for update;

  select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'position',x.position) order by x.position,x.id),'[]'::jsonb),
    coalesce(array_agg(x.id order by x.id),'{}'::uuid[]) into expected_source,source_ids
    from jsonb_to_recordset(p_expected_source) as x(id uuid,position integer);
  select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'position',x.position) order by x.position,x.id),'[]'::jsonb),
    coalesce(array_agg(x.id order by x.id),'{}'::uuid[]) into expected_destination,destination_ids
    from jsonb_to_recordset(p_expected_destination) as x(id uuid,position integer);
  select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'position',l.position) order by l.position,l.id),'[]'::jsonb)
    into current_source from public.links l where l.user_id=owner_id and l.collection_id=p_source_collection_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'position',l.position) order by l.position,l.id),'[]'::jsonb)
    into current_destination from public.links l where l.user_id=owner_id and l.collection_id=p_destination_collection_id;
  if current_source<>expected_source or current_destination<>expected_destination
    or not p_link_id=any(source_ids)
    or exists(select 1 from public.workspace_tombstones t where t.user_id=owner_id and (
      (t.entity_type='link' and t.entity_id=any(source_ids || destination_ids))
      or (t.entity_type='collection' and t.entity_id in (p_source_collection_id,p_destination_collection_id))
      or (t.entity_type='space' and t.entity_id in (select c.space_id from public.collections c where c.user_id=owner_id and c.id in (p_source_collection_id,p_destination_collection_id)))
    )) then
    raise exception using errcode='40001', message='workspace move structure changed';
  end if;
  -- Exact sets (including multiplicity) prevent dropped/foreign/duplicate IDs.
  if (select coalesce(array_agg(id order by id),'{}'::uuid[]) from unnest(p_source_ordered_ids) as x(id)) <> array_remove(source_ids,p_link_id)
    or (select coalesce(array_agg(id order by id),'{}'::uuid[]) from unnest(p_destination_ordered_ids) as x(id)) <>
       (select array_agg(id order by id) from unnest(destination_ids || p_link_id) as x(id)) then
    raise exception using errcode='22023', message='invalid workspace move order';
  end if;

  affected_count := cardinality(source_ids)+cardinality(destination_ids);
  perform set_config('tabloom.merge_in_progress','on',true);
  with desired as (
    select id,p_source_collection_id as parent_id,ordinality-1 as position from unnest(p_source_ordered_ids) with ordinality as x(id,ordinality)
    union all
    select id,p_destination_collection_id,ordinality-1 from unnest(p_destination_ordered_ids) with ordinality as x(id,ordinality)
  )
  update public.links l set collection_id=d.parent_id,position=d.position,updated_at=clock_timestamp()
    from desired d where l.id=d.id and l.user_id=owner_id and l.collection_id in (p_source_collection_id,p_destination_collection_id);
  get diagnostics updated_count = row_count;
  if updated_count<>affected_count then
    raise exception using errcode='40001', message='workspace move structure changed';
  end if;
  update public.workspace_sync_state set revision=revision+1,updated_at=now() where user_id=owner_id returning revision into next_revision;
  perform set_config('tabloom.merge_in_progress',coalesce(previous_merge_setting,''),true);
  return next_revision;
end;
$$;

revoke all on function public.move_workspace_link(uuid,uuid,uuid,jsonb,jsonb,uuid[],uuid[]) from public,anon,service_role;
grant execute on function public.move_workspace_link(uuid,uuid,uuid,jsonb,jsonb,uuid[],uuid[]) to authenticated;
