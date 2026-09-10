-- Operation identity outlives the recoverable snapshot. Purging Trash must
-- never free an old operation ID to bind to a later deletion generation.
alter table public.workspace_trash_operation_aliases
  drop constraint workspace_trash_operation_aliases_trash_id_fkey,
  add column root_type text,
  add column root_id uuid;
update public.workspace_trash_operation_aliases a set root_type=t.root_type,root_id=t.root_id
  from public.workspace_trash t where t.user_id=a.user_id and t.id=a.trash_id;
insert into public.workspace_trash_operation_aliases(user_id,operation_id,trash_id,root_type,root_id)
  select user_id,created_operation_id,id,root_type,root_id from public.workspace_trash
  where created_operation_id is not null on conflict do nothing;
alter table public.workspace_trash_operation_aliases
  alter column root_type set not null, alter column root_id set not null;

create function public.remember_workspace_trash_identity()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.created_operation_id is not null then
    if exists(select 1 from public.workspace_trash_operation_aliases a where a.user_id=new.user_id
      and a.operation_id=new.created_operation_id and (a.trash_id<>new.id or a.root_type<>new.root_type or a.root_id<>new.root_id)) then
      raise exception 'workspace delete operation identity was already used' using errcode='22023';
    end if;
    insert into public.workspace_trash_operation_aliases(user_id,operation_id,trash_id,root_type,root_id)
      values(new.user_id,new.created_operation_id,new.id,new.root_type,new.root_id) on conflict do nothing;
  end if;
  return new;
end;
$$;
revoke all on function public.remember_workspace_trash_identity() from public,anon,authenticated,service_role;
create trigger remember_workspace_trash_identity after insert on public.workspace_trash
  for each row execute function public.remember_workspace_trash_identity();

-- A fresh-but-old offline request must also prove it observed this live
-- generation. Track server restoration revisions for every restored descendant.
create table public.workspace_entity_generations (
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null check(entity_type in ('space','collection','link')),
  entity_id uuid not null,
  restored_revision bigint not null,
  primary key(user_id,entity_type,entity_id)
);
alter table public.workspace_entity_generations enable row level security;
revoke all on public.workspace_entity_generations from public,anon,authenticated,service_role;
-- Pre-migration lineage cannot be reconstructed after historic purges. Require
-- a fresh account revision for unknown aliases rather than guess old lineage.
insert into public.workspace_entity_generations(user_id,entity_type,entity_id,restored_revision)
  select n.user_id,n.entity_type,n.entity_id,s.revision from (
    select user_id,'space'::text as entity_type,id as entity_id from public.spaces
    union select user_id,'collection',id from public.collections
    union select user_id,'link',id from public.links
    union select user_id,entity_type,entity_id from public.workspace_tombstones
  ) n join public.workspace_sync_state s on s.user_id=n.user_id;

create function public.remember_workspace_restore_generation()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare restored_revision_value bigint;
begin
  if old.restored_at is null and new.restored_at is not null then
    select revision+1 into restored_revision_value from public.workspace_sync_state where user_id=new.user_id;
    insert into public.workspace_entity_generations(user_id,entity_type,entity_id,restored_revision)
      select new.user_id,n.entity_type,n.entity_id,restored_revision_value from (
        select 'space'::text as entity_type,(value->>'id')::uuid as entity_id from jsonb_array_elements(new.snapshot->'spaces')
        union all select 'collection',(value->>'id')::uuid from jsonb_array_elements(new.snapshot->'collections')
        union all select 'link',(value->>'id')::uuid from jsonb_array_elements(new.snapshot->'links')
      ) n on conflict(user_id,entity_type,entity_id) do update
        set restored_revision=greatest(workspace_entity_generations.restored_revision,excluded.restored_revision);
  end if;
  return new;
end;
$$;
revoke all on function public.remember_workspace_restore_generation() from public,anon,authenticated,service_role;
create trigger remember_workspace_restore_generation after update of restored_at on public.workspace_trash
  for each row execute function public.remember_workspace_restore_generation();

create or replace function public.workspace_delete_receipt_alias(operation jsonb, outcome jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  owner_id uuid := auth.uid(); operation_id_value uuid;
  history public.workspace_trash_operation_aliases;
  trash public.workspace_trash; receipt_id uuid;
begin
  if owner_id is null then raise exception 'authentication required' using errcode='28000'; end if;
  if operation->>'action'<>'delete' or outcome->>'status' not in ('applied','deleted','already_applied') then return outcome; end if;
  operation_id_value := (operation->>'operationId')::uuid;
  select * into history from public.workspace_trash_operation_aliases a
    where a.user_id=owner_id and a.operation_id=operation_id_value;
  if found then
    -- Missing snapshot means expired/purged, NOT permission to find a new one.
    select t.* into trash from public.workspace_trash t where t.user_id=owner_id and t.id=history.trash_id
      and t.root_type=operation->>'entity' and t.root_id=(operation->>'entityId')::uuid
      and t.root_type=history.root_type and t.root_id=history.root_id;
  else
    -- Only a freshly processed DELETE can establish a same-generation alias.
    -- The strict batch processor emits already_applied for any replay. Its
    -- actual recorded device/sequence must match; a synthetic restore lookup
    -- (or an unknown/legacy expired ID) cannot establish this authority.
    if outcome->>'status'<>'deleted' or not (operation ? 'deviceId' and operation ? 'sequence') then return outcome; end if;
    if coalesce(operation->>'baseRevision','') !~ '^[0-9]+$' then return outcome; end if;
    if (operation->>'baseRevision')::bigint < coalesce((select g.restored_revision from public.workspace_entity_generations g
      where g.user_id=owner_id and g.entity_type=operation->>'entity' and g.entity_id=(operation->>'entityId')::uuid),0) then return outcome; end if;
    if not exists(select 1 from public.workspace_operations a where a.user_id=owner_id
      and a.operation_id=operation_id_value and a.device_id=(operation->>'deviceId')::uuid
      and a.sequence=(operation->>'sequence')::bigint) then return outcome; end if;
    select case when count(*)=1 then (array_agg(t.id))[1] end into receipt_id
      from public.workspace_trash t join public.workspace_tombstones d
        on d.user_id=t.user_id and d.entity_type=t.root_type and d.entity_id=t.root_id and d.deleted_at=t.deleted_at
      where t.user_id=owner_id and t.root_type=operation->>'entity' and t.root_id=(operation->>'entityId')::uuid
        and t.restored_at is null and t.expires_at>clock_timestamp();
    if receipt_id is not null then
      insert into public.workspace_trash_operation_aliases(user_id,operation_id,trash_id,root_type,root_id)
        values(owner_id,operation_id_value,receipt_id,operation->>'entity',(operation->>'entityId')::uuid) on conflict do nothing;
      select * into trash from public.workspace_trash where user_id=owner_id and id=receipt_id;
    end if;
  end if;
  if trash.id is not null then return outcome || jsonb_build_object('trashId',trash.id,'restoreUntil',trash.expires_at); end if;
  return outcome;
end;
$$;
