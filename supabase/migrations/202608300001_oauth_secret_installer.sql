begin;

do $$
begin
  if to_regrole('oauth_facade_owner') is null
    or not exists (
      select 1
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'oauth_private'
        and relation.relname = 'facade_secret'
        and relation.relkind = 'r'
    ) then
    raise exception 'OAuth facade must exist before installing its secret writer';
  end if;
  if exists (
    select 1
    from pg_auth_members membership
    join pg_roles parent_role on parent_role.oid = membership.roleid
    join pg_roles member_role on member_role.oid = membership.member
    where parent_role.rolname = 'oauth_facade_owner'
      and (
        member_role.rolname <> session_user
        or pg_has_role(member_role.oid, parent_role.oid, 'usage')
        or case
          when current_setting('server_version_num')::integer >= 160000
            then pg_has_role(member_role.oid, parent_role.oid, 'set')
          else false
        end
      )
  ) then
    raise exception 'OAuth facade owner has unsafe role memberships';
  end if;
end
$$;

do $$
begin
  execute format('grant oauth_facade_owner to %I', current_user);
end
$$;

set local role oauth_facade_owner;

create or replace function oauth_private.install_facade_secret(new_secret bytea)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, extensions, oauth_private, pg_temp
as $$
declare
  fingerprint text;
begin
  if new_secret is null or octet_length(new_secret) <> 32 then
    raise exception 'invalid OAuth facade secret' using errcode = '22023';
  end if;

  insert into oauth_private.facade_secret as configured (singleton, secret)
  values (true, new_secret)
  on conflict (singleton) do update
    set secret = excluded.secret,
        updated_at = clock_timestamp()
  returning encode(extensions.digest(configured.secret, 'sha256'), 'hex')
    into fingerprint;

  return fingerprint;
end
$$;

revoke all on function oauth_private.install_facade_secret(bytea)
  from public, anon, authenticated, service_role;
do $$
begin
  execute format('grant usage on schema oauth_private to %I', session_user);
  execute format(
    'grant execute on function oauth_private.install_facade_secret(bytea) to %I',
    session_user
  );
end
$$;

reset role;

do $$
begin
  if not has_schema_privilege(session_user, 'oauth_private', 'usage')
    or not has_function_privilege(
      session_user,
      'oauth_private.install_facade_secret(bytea)',
      'execute'
    ) then
    raise exception 'Managed database administrator cannot install OAuth facade secret';
  end if;
  if has_function_privilege(
    'anon',
    'oauth_private.install_facade_secret(bytea)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'oauth_private.install_facade_secret(bytea)',
    'execute'
  ) or has_function_privilege(
    'service_role',
    'oauth_private.install_facade_secret(bytea)',
    'execute'
  ) then
    raise exception 'OAuth facade secret installer has unsafe execution grants';
  end if;
end
$$;

do $$
begin
  execute format('revoke oauth_facade_owner from %I', current_user);
end
$$;

do $$
begin
  if exists (
    select 1
    from pg_auth_members membership
    join pg_roles parent_role on parent_role.oid = membership.roleid
    join pg_roles member_role on member_role.oid = membership.member
    where parent_role.rolname = 'oauth_facade_owner'
      and (
        member_role.rolname <> session_user
        or pg_has_role(member_role.oid, parent_role.oid, 'usage')
        or case
          when current_setting('server_version_num')::integer >= 160000
            then pg_has_role(member_role.oid, parent_role.oid, 'set')
          else false
        end
      )
  ) then
    raise exception 'OAuth facade owner has unsafe role memberships';
  end if;
end
$$;

commit;
