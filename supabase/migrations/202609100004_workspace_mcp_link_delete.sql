-- MCP link deletion must compare the last-seen timestamp in the same transaction
-- that snapshots and deletes the link. Reuse Trash's receipt and mutation path.
create function public.trash_workspace_link_if_unchanged(
  p_link_id uuid, p_expected_updated_at timestamptz, p_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
  current_updated_at timestamptz;
begin
  if owner_id is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_link_id is null or p_expected_updated_at is null or not isfinite(p_expected_updated_at) or p_operation_id is null then
    raise exception 'invalid workspace link delete request' using errcode='22023';
  end if;

  -- Match Trash/sync lock order and serialize concurrent identical operations.
  insert into public.workspace_sync_state(user_id,revision) values(owner_id,0) on conflict(user_id) do nothing;
  perform 1 from public.workspace_sync_state where user_id=owner_id for update;
  if exists(select 1 from public.workspace_trash where user_id=owner_id and created_operation_id=p_operation_id) then
    -- The authoritative path validates target/source identity and returns the
    -- original receipt even after restoration, without deleting the link again.
    return public.trash_workspace_entity('link',p_link_id,'mcp',p_operation_id,null);
  end if;

  select updated_at into current_updated_at from public.links
    where user_id=owner_id and id=p_link_id for update;
  if not found then
    if exists(select 1 from public.bookmark_entries where user_id=owner_id and id=p_link_id) then
      raise exception 'read_only' using errcode='42501';
    end if;
    raise exception 'workspace link not found' using errcode='P0002';
  end if;
  if current_updated_at <> p_expected_updated_at then
    raise exception 'workspace delete target changed' using errcode='40001';
  end if;
  return public.trash_workspace_entity('link',p_link_id,'mcp',p_operation_id,null);
end;
$$;
revoke all on function public.trash_workspace_link_if_unchanged(uuid,timestamptz,uuid) from public, anon, service_role;
grant execute on function public.trash_workspace_link_if_unchanged(uuid,timestamptz,uuid) to authenticated;
