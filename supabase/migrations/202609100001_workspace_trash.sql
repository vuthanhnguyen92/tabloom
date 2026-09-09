-- Trash is written only by authenticated, ownership-checking RPCs. Direct saved
-- table DELETE privileges are retained until the callers migrate in Task 3.
create table public.workspace_trash (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  root_type text not null check (root_type in ('space', 'collection', 'link')),
  root_id uuid not null,
  root_name text not null,
  snapshot jsonb not null check ((snapshot->>'version')::integer = 1),
  source text not null check (source in ('web', 'extension', 'mcp')),
  deleted_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  restored_at timestamptz,
  created_operation_id uuid,
  unique (user_id, created_operation_id)
);

create table public.workspace_delete_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  target_type text not null check (target_type in ('space', 'collection')),
  target_id uuid not null,
  target_updated_at timestamptz not null,
  target_summary jsonb not null,
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  consumed_at timestamptz
);

create index workspace_trash_owner_expiry_idx on public.workspace_trash(user_id, expires_at);
create index workspace_delete_intents_owner_expiry_idx on public.workspace_delete_intents(user_id, expires_at);
alter table public.workspace_trash enable row level security;
alter table public.workspace_delete_intents enable row level security;
create policy "owners read unexpired workspace trash" on public.workspace_trash
  for select using (user_id = auth.uid() and expires_at > now());
create policy "owners read workspace delete intents" on public.workspace_delete_intents
  for select using (user_id = auth.uid());
revoke all on public.workspace_trash, public.workspace_delete_intents from public, anon, authenticated, service_role;
grant select on public.workspace_trash, public.workspace_delete_intents to authenticated;

-- Private helper. FOR UPDATE on parents also prevents FK inserts racing the
-- snapshot; descendant locks prevent concurrent edits or moves being omitted.
create function public.workspace_trash_snapshot(p_root_type text, p_root_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
  root_row jsonb;
  space_rows jsonb := '[]'::jsonb;
  collection_rows jsonb := '[]'::jsonb;
  link_rows jsonb := '[]'::jsonb;
begin
  if owner_id is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_root_type is null or p_root_type not in ('space','collection','link') or p_root_id is null then
    raise exception 'invalid workspace trash target' using errcode = '22023';
  end if;
  if p_root_type = 'space' then
    select to_jsonb(s) into root_row from public.spaces s where s.user_id=owner_id and s.id=p_root_id for update;
    if root_row is null then raise exception 'workspace space not found' using errcode = 'P0002'; end if;
    space_rows := jsonb_build_array(root_row || '{"origin":"saved","read_only":false}'::jsonb);
  elsif p_root_type = 'collection' then
    select to_jsonb(c) into root_row from public.collections c where c.user_id=owner_id and c.id=p_root_id for update;
    if root_row is null then raise exception 'workspace collection not found' using errcode = 'P0002'; end if;
  else
    select to_jsonb(l) into root_row from public.links l where l.user_id=owner_id and l.id=p_root_id for update;
    if root_row is null then
      if exists(select 1 from public.bookmark_entries where user_id=owner_id and id=p_root_id) then
        raise exception 'read_only' using errcode = '42501';
      end if;
      raise exception 'workspace link not found' using errcode = 'P0002';
    end if;
  end if;
  if p_root_type in ('space','collection') then
    select coalesce(jsonb_agg(to_jsonb(c) || '{"origin":"saved","read_only":false}'::jsonb
      order by c.position,c.created_at,c.id),'[]'::jsonb) into collection_rows
    from (select * from public.collections where user_id=owner_id
      and ((p_root_type='space' and space_id=p_root_id) or (p_root_type='collection' and id=p_root_id))
      order by id for update) c;
  end if;
  select coalesce(jsonb_agg(to_jsonb(l) || '{"origin":"saved","read_only":false}'::jsonb
    order by l.collection_id,l.position,l.created_at,l.id),'[]'::jsonb) into link_rows
  from (select * from public.links where user_id=owner_id
    and ((p_root_type='link' and id=p_root_id) or collection_id in
      (select (value->>'id')::uuid from jsonb_array_elements(collection_rows)))
    order by id for update) l;
  return jsonb_build_object('version',1,'rootType',p_root_type,'spaces',space_rows,
    'collections',collection_rows,'links',link_rows);
end;
$$;
revoke all on function public.workspace_trash_snapshot(text,uuid) from public, anon, authenticated, service_role;

create function public.list_workspace_trash()
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare owner_id uuid := auth.uid();
begin
  if owner_id is null then raise exception 'authentication required' using errcode = '28000'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id',id,'rootType',root_type,'rootId',root_id,'rootName',root_name,
    'source',source,'deletedAt',deleted_at,'expiresAt',expires_at,'restoredAt',restored_at,'snapshot',snapshot
  ) order by deleted_at desc,id) from public.workspace_trash
    where user_id=owner_id and expires_at > clock_timestamp() and restored_at is null),'[]'::jsonb);
end;
$$;

create function public.prepare_workspace_delete(p_target_type text, p_target_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
  snapshot jsonb;
  root_row jsonb;
  summary jsonb;
  intent public.workspace_delete_intents;
begin
  if owner_id is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_target_type is null or p_target_type not in ('space','collection') then
    raise exception 'invalid workspace delete target' using errcode = '22023';
  end if;
  insert into public.workspace_sync_state(user_id,revision) values(owner_id,0) on conflict(user_id) do nothing;
  perform 1 from public.workspace_sync_state where user_id=owner_id for update;
  snapshot := public.workspace_trash_snapshot(p_target_type,p_target_id);
  root_row := case p_target_type when 'space' then snapshot #> '{spaces,0}' else snapshot #> '{collections,0}' end;
  summary := jsonb_build_object('targetName',root_row->>'name',
    'collectionCount',jsonb_array_length(snapshot->'collections'),
    'linkCount',jsonb_array_length(snapshot->'links'),'fingerprint',md5(snapshot::text));
  insert into public.workspace_delete_intents(user_id,target_type,target_id,target_updated_at,target_summary)
    values(owner_id,p_target_type,p_target_id,(root_row->>'updated_at')::timestamptz,summary)
    returning * into intent;
  return (summary - 'fingerprint') || jsonb_build_object('intentId',intent.id,
    'targetType',p_target_type,'targetId',p_target_id,'expiresAt',intent.expires_at);
end;
$$;

create function public.trash_workspace_entity(
  p_root_type text, p_root_id uuid, p_source text, p_operation_id uuid, p_intent_id uuid
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
  snapshot_value jsonb;
  root_row jsonb;
  trash public.workspace_trash;
  intent public.workspace_delete_intents;
  next_revision bigint;
  previous_merge_setting text := current_setting('tabloom.merge_in_progress',true);
begin
  if owner_id is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_root_type is null or p_root_type not in ('space','collection','link') or p_root_id is null
    or p_source is null or p_source not in ('web','extension','mcp') or p_operation_id is null then
    raise exception 'invalid workspace trash request' using errcode = '22023';
  end if;
  insert into public.workspace_sync_state(user_id,revision) values(owner_id,0) on conflict(user_id) do nothing;
  select revision+1 into next_revision from public.workspace_sync_state where user_id=owner_id for update;
  select * into trash from public.workspace_trash where user_id=owner_id and created_operation_id=p_operation_id;
  if found then
    if trash.root_type <> p_root_type or trash.root_id <> p_root_id or trash.source <> p_source then
      raise exception 'workspace operation conflict' using errcode = '40001';
    end if;
  else
    if p_root_type in ('space','collection') then
      select * into intent from public.workspace_delete_intents
        where user_id=owner_id and id=p_intent_id and target_type=p_root_type and target_id=p_root_id for update;
      if not found or intent.consumed_at is not null then raise exception 'confirmation_required' using errcode = 'P0001'; end if;
      if intent.expires_at <= clock_timestamp() then raise exception 'confirmation_expired' using errcode = 'P0001'; end if;
    end if;
    snapshot_value := public.workspace_trash_snapshot(p_root_type,p_root_id);
    root_row := case p_root_type when 'space' then snapshot_value #> '{spaces,0}'
      when 'collection' then snapshot_value #> '{collections,0}' else snapshot_value #> '{links,0}' end;
    if p_root_type in ('space','collection') then
      if intent.target_updated_at <> (root_row->>'updated_at')::timestamptz
        or intent.target_summary->>'fingerprint' <> md5(snapshot_value::text) then
        raise exception 'workspace delete target changed' using errcode = '40001';
      end if;
      -- Recheck after acquiring all tree locks: waiting cannot extend an intent.
      if intent.expires_at <= clock_timestamp() then raise exception 'confirmation_expired' using errcode = 'P0001'; end if;
      update public.workspace_delete_intents set consumed_at=clock_timestamp() where id=intent.id and user_id=owner_id;
    end if;
    insert into public.workspace_trash(user_id,root_type,root_id,root_name,snapshot,source,created_operation_id)
      values(owner_id,p_root_type,p_root_id,coalesce(root_row->>'name',root_row->>'title'),snapshot_value,p_source,p_operation_id)
      on conflict(user_id,created_operation_id) do nothing returning * into trash;
    if trash.id is null then raise exception 'workspace operation conflict' using errcode = '40001'; end if;
    insert into public.workspace_tombstones(user_id,entity_type,entity_id,deleted_revision)
      select owner_id,entity.kind,(entity.row_value->>'id')::uuid,next_revision from (
        select 'space' as kind,value as row_value from jsonb_array_elements(snapshot_value->'spaces')
        union all select 'collection',value from jsonb_array_elements(snapshot_value->'collections')
        union all select 'link',value from jsonb_array_elements(snapshot_value->'links')
      ) entity
      on conflict(user_id,entity_type,entity_id) do update
        set deleted_revision=excluded.deleted_revision,deleted_at=now();
    perform set_config('tabloom.merge_in_progress','on',true);
    if p_root_type='space' then delete from public.spaces where user_id=owner_id and id=p_root_id;
    elsif p_root_type='collection' then delete from public.collections where user_id=owner_id and id=p_root_id;
    else delete from public.links where user_id=owner_id and id=p_root_id; end if;
    update public.workspace_sync_state set revision=next_revision,updated_at=now() where user_id=owner_id;
    perform set_config('tabloom.merge_in_progress',coalesce(previous_merge_setting,'off'),true);
  end if;
  return jsonb_build_object('operationId',p_operation_id,'trashId',trash.id,'rootType',trash.root_type,
    'rootId',trash.root_id,'restoreUntil',trash.expires_at);
end;
$$;

create function public.restore_workspace_trash(p_trash_id uuid, p_destination_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
  trash public.workspace_trash;
  snapshot_value jsonb;
  root_row jsonb;
  parent_id uuid;
  next_revision bigint;
  previous_merge_setting text := current_setting('tabloom.merge_in_progress',true);
begin
  if owner_id is null then raise exception 'authentication required' using errcode = '28000'; end if;
  insert into public.workspace_sync_state(user_id,revision) values(owner_id,0) on conflict(user_id) do nothing;
  select revision+1 into next_revision from public.workspace_sync_state where user_id=owner_id for update;
  select * into trash from public.workspace_trash where user_id=owner_id and id=p_trash_id for update;
  if not found or trash.expires_at <= clock_timestamp() then raise exception 'workspace trash not found' using errcode = 'P0002'; end if;
  if trash.restored_at is not null then
    return jsonb_build_object('status','restored','trashId',trash.id,'rootType',trash.root_type,'rootId',trash.root_id,'revision',next_revision-1);
  end if;
  snapshot_value := trash.snapshot;
  root_row := case trash.root_type when 'space' then snapshot_value #> '{spaces,0}'
    when 'collection' then snapshot_value #> '{collections,0}' else snapshot_value #> '{links,0}' end;
  if trash.root_type='space' and p_destination_id is not null then
    raise exception 'space restore does not accept a destination' using errcode = '22023';
  elsif trash.root_type='collection' then
    parent_id := coalesce(p_destination_id,(root_row->>'space_id')::uuid);
    perform 1 from public.spaces where user_id=owner_id and id=parent_id for update;
    if not found then
      if p_destination_id is not null then raise exception 'workspace space not found' using errcode = 'P0002'; end if;
      return jsonb_build_object('status','destination_required','trashId',trash.id,'rootType',trash.root_type,'rootId',trash.root_id,'destinationType','space');
    end if;
  elsif trash.root_type='link' then
    parent_id := coalesce(p_destination_id,(root_row->>'collection_id')::uuid);
    perform 1 from public.collections where user_id=owner_id and id=parent_id for update;
    if not found then
      if p_destination_id is not null then raise exception 'workspace collection not found' using errcode = 'P0002'; end if;
      return jsonb_build_object('status','destination_required','trashId',trash.id,'rootType',trash.root_type,'rootId',trash.root_id,'destinationType','collection');
    end if;
  end if;
  -- Never overwrite a live row, including a row now owned by another user.
  if exists(select 1 from public.spaces where id in (select (value->>'id')::uuid from jsonb_array_elements(snapshot_value->'spaces')))
    or exists(select 1 from public.collections where id in (select (value->>'id')::uuid from jsonb_array_elements(snapshot_value->'collections')))
    or exists(select 1 from public.links where id in (select (value->>'id')::uuid from jsonb_array_elements(snapshot_value->'links'))) then
    raise exception 'workspace restore conflict' using errcode = '40001';
  end if;
  perform set_config('tabloom.merge_in_progress','on',true);
  -- Make room at the original slot before compacting positions. This preserves
  -- order even if a sibling has since occupied the deleted row's old position.
  if trash.root_type='space' then
    update public.spaces set position=position+1 where user_id=owner_id and position >= (root_row->>'position')::int;
  elsif trash.root_type='collection' then
    update public.collections set position=position+1 where user_id=owner_id and space_id=parent_id and position >= (root_row->>'position')::int;
  else
    update public.links set position=position+1 where user_id=owner_id and collection_id=parent_id and position >= (root_row->>'position')::int;
  end if;
  insert into public.spaces(id,user_id,name,color,position,created_at,updated_at)
    select id,owner_id,name,color,position,created_at,updated_at
    from jsonb_populate_recordset(null::public.spaces,snapshot_value->'spaces');
  insert into public.collections(id,user_id,space_id,name,position,created_at,updated_at)
    select id,owner_id,case when trash.root_type='collection' then parent_id else space_id end,name,position,created_at,updated_at
    from jsonb_populate_recordset(null::public.collections,snapshot_value->'collections');
  insert into public.links(id,user_id,collection_id,url,title,description,favicon_url,position,created_at,updated_at)
    select id,owner_id,case when trash.root_type='link' then parent_id else collection_id end,url,title,description,favicon_url,position,created_at,updated_at
    from jsonb_populate_recordset(null::public.links,snapshot_value->'links');

  if trash.root_type='space' then
    with ordered as (select id,row_number() over(order by position,created_at,id)-1 as pos from public.spaces where user_id=owner_id)
    update public.spaces s set position=ordered.pos from ordered where s.id=ordered.id and s.position<>ordered.pos;
  end if;
  with ordered as (
    select id,row_number() over(partition by space_id order by position,created_at,id)-1 as pos from public.collections
    where user_id=owner_id and ((trash.root_type='collection' and space_id=parent_id) or (trash.root_type='space' and space_id=trash.root_id))
  ) update public.collections c set position=ordered.pos from ordered where c.id=ordered.id and c.position<>ordered.pos;
  with ordered as (
    select id,row_number() over(partition by collection_id order by position,created_at,id)-1 as pos from public.links
    where user_id=owner_id and ((trash.root_type='link' and collection_id=parent_id) or collection_id in
      (select (value->>'id')::uuid from jsonb_array_elements(snapshot_value->'collections')))
  ) update public.links l set position=ordered.pos from ordered where l.id=ordered.id and l.position<>ordered.pos;
  delete from public.workspace_tombstones t where t.user_id=owner_id and (
    (t.entity_type='space' and t.entity_id in (select (value->>'id')::uuid from jsonb_array_elements(snapshot_value->'spaces')))
    or (t.entity_type='collection' and t.entity_id in (select (value->>'id')::uuid from jsonb_array_elements(snapshot_value->'collections')))
    or (t.entity_type='link' and t.entity_id in (select (value->>'id')::uuid from jsonb_array_elements(snapshot_value->'links'))));
  update public.workspace_trash set restored_at=clock_timestamp() where user_id=owner_id and id=trash.id;
  update public.workspace_sync_state set revision=next_revision,updated_at=now() where user_id=owner_id;
  perform set_config('tabloom.merge_in_progress',coalesce(previous_merge_setting,'off'),true);
  return jsonb_build_object('status','restored','trashId',trash.id,'rootType',trash.root_type,'rootId',trash.root_id,'revision',next_revision);
end;
$$;

-- Authenticated, owner-scoped cleanup; no service-role mutation path.
create function public.purge_expired_workspace_trash(p_limit integer)
returns integer language plpgsql security definer set search_path = public, pg_temp
as $$
declare owner_id uuid := auth.uid(); purged integer;
begin
  if owner_id is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 1000 then raise exception 'invalid purge limit' using errcode = '22023'; end if;
  delete from public.workspace_trash where user_id=owner_id and id in (
    select id from public.workspace_trash where user_id=owner_id and expires_at <= clock_timestamp()
    order by expires_at,id limit p_limit for update skip locked
  );
  get diagnostics purged = row_count;
  return purged;
end;
$$;

revoke all on function public.list_workspace_trash() from public, anon, service_role;
revoke all on function public.prepare_workspace_delete(text,uuid) from public, anon, service_role;
revoke all on function public.trash_workspace_entity(text,uuid,text,uuid,uuid) from public, anon, service_role;
revoke all on function public.restore_workspace_trash(uuid,uuid) from public, anon, service_role;
revoke all on function public.purge_expired_workspace_trash(integer) from public, anon, service_role;
grant execute on function public.list_workspace_trash() to authenticated;
grant execute on function public.prepare_workspace_delete(text,uuid) to authenticated;
grant execute on function public.trash_workspace_entity(text,uuid,text,uuid,uuid) to authenticated;
grant execute on function public.restore_workspace_trash(uuid,uuid) to authenticated;
grant execute on function public.purge_expired_workspace_trash(integer) to authenticated;
