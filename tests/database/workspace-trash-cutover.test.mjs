import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

// Deliberately fixed to this repository's local Supabase port. No environment
// variable or CLI argument can redirect this mutating test to hosted data.
test("operator Trash privilege cutover against local Supabase", async (t) => {
  const client = new pg.Client({ host: "127.0.0.1", port: 54322, database: "postgres", user: "postgres", password: "postgres" });
  await client.connect();
  await client.query("begin");
  try {
    const cutover = await readFile(new URL("../../supabase/operations/workspace_trash_privilege_cutover.sql", import.meta.url), "utf8");
    const tables = ["spaces", "collections", "links"];
    const hasDelete = async (table) => (await client.query("select has_table_privilege('authenticated',$1,'DELETE') as allowed", [`public.${table}`])).rows[0].allowed;
    const rejectsSql = async (sql, code, message) => {
      await client.query("savepoint rejected_command");
      await assert.rejects(client.query(sql), (error) => error.code === code && (!message || message.test(error.message)));
      await client.query("rollback to savepoint rejected_command");
      await client.query("release savepoint rejected_command");
    };

    await t.test("additive migrations preserve old client DELETE before cutover", async () => {
      for (const table of tables) assert.equal(await hasDelete(table), true, table);
    });
    await t.test("operator must attest compatible clients before any privilege changes", async () => {
      await client.query("select set_config('tabloom.trash_clients_ready','',true)");
      await rejectsSql(cutover, "P0001", /compatible clients/);
      for (const table of tables) assert.equal(await hasDelete(table), true, table);
    });
    await client.query("select set_config('tabloom.trash_clients_ready','on',true)");
    await t.test("missing RPC prerequisite aborts the whole cutover", async () => {
      await client.query("savepoint missing_rpc");
      await client.query("alter function public.trash_workspace_link_if_unchanged(uuid,timestamptz,uuid) rename to unavailable_link_delete");
      await rejectsSql(cutover, "P0001", /required Trash RPC/);
      for (const table of tables) assert.equal(await hasDelete(table), true, table);
      await client.query("rollback to savepoint missing_rpc");
    });
    await t.test("a failed final postcheck rolls back earlier table privilege changes", async () => {
      await client.query("savepoint unexpected_policy");
      await client.query("create policy unexpected_delete_policy on public.links for delete using (auth.uid()=user_id)");
      await rejectsSql(cutover, "P0001", /postcheck failed/);
      for (const table of tables) assert.equal(await hasDelete(table), true, table);
      await client.query("rollback to savepoint unexpected_policy");
    });
    await t.test("cutover and repeat cutover revoke direct DELETE and preserve owned CRUD grants", async () => {
      await client.query(cutover);
      await client.query(cutover);
      for (const table of tables) {
        assert.equal(await hasDelete(table), false, table);
        for (const privilege of ["SELECT", "INSERT", "UPDATE"]) {
          assert.equal((await client.query("select has_table_privilege('authenticated',$1,$2) as allowed", [`public.${table}`, privilege])).rows[0].allowed, true);
        }
      }
      assert.equal((await client.query("select count(*)::int as count from pg_policies where schemaname='public' and tablename=any($1) and cmd in ('ALL','DELETE')", [tables])).rows[0].count, 0);
      const postcheck = await readFile(new URL("../../supabase/operations/workspace_trash_privilege_postcheck.sql", import.meta.url), "utf8");
      const rows = (await client.query(postcheck)).rows;
      assert.equal(rows.length, 3);
      for (const { saved_table, ...checks } of rows) assert.ok(Object.values(checks).every((value) => value === true), saved_table);
    });

    const owner = randomUUID(), other = randomUUID(), space = randomUUID(), foreign = randomUUID(), collection = randomUUID(), link = randomUUID();
    await client.query("insert into auth.users(id,aud,role,email) values($1,'authenticated','authenticated',$3),($2,'authenticated','authenticated',$4)", [owner, other, `${owner}@example.test`, `${other}@example.test`]);
    await client.query("insert into public.spaces(id,user_id,name,position) values($1,$2,'Foreign',0)", [foreign, other]);
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)", [owner]);
    await t.test("owned create/update/read still work and cross-owner RLS remains enforced", async () => {
      await client.query("insert into public.spaces(id,user_id,name,position) values($1,$2,'Own',0)", [space, owner]);
      await client.query("insert into public.collections(id,user_id,space_id,name,position) values($1,$2,$3,'Collection',0)", [collection, owner, space]);
      await client.query("insert into public.links(id,user_id,collection_id,title,url,position) values($1,$2,$3,'Link','https://example.test',0)", [link, owner, collection]);
      for (const [table, id, field] of [["spaces", space, "name"], ["collections", collection, "name"], ["links", link, "title"]]) {
        assert.equal((await client.query(`update public.${table} set ${field}='Updated' where id=$1`, [id])).rowCount, 1);
        assert.equal((await client.query(`select id from public.${table} where id=$1`, [id])).rowCount, 1);
      }
      assert.equal((await client.query("update public.spaces set name='Forbidden' where id=$1", [foreign])).rowCount, 0);
      assert.equal((await client.query("select id from public.spaces where id=$1", [foreign])).rowCount, 0);
    });
    await t.test("legacy direct deletion fails closed on every saved table after cutover", async () => {
      for (const table of tables) await rejectsSql(`delete from public.${table}`, "42501");
      assert.equal((await client.query("select id from public.links where id=$1", [link])).rowCount, 1);
    });
    await t.test("authenticated Trash delete/list/restore and extension sync still work after cutover", async () => {
      const intent = (await client.query("select public.prepare_workspace_delete('collection',$1) as value", [collection])).rows[0].value;
      const receipt = (await client.query("select public.trash_workspace_entity('collection',$1,'web',$2,$3) as value", [collection, randomUUID(), intent.intentId])).rows[0].value;
      assert.equal((await client.query("select id from public.links where id=$1", [link])).rowCount, 0);
      assert.equal((await client.query("select public.list_workspace_trash() as value")).rows[0].value[0].id, receipt.trashId);
      assert.equal((await client.query("select public.restore_workspace_trash($1,null) as value", [receipt.trashId])).rows[0].value.status, "restored");
      assert.equal((await client.query("select id from public.links where id=$1", [link])).rowCount, 1);
      const revision = (await client.query("select revision from public.workspace_sync_state where user_id=$1", [owner])).rows[0].revision;
      const operations = [{ operationId: randomUUID(), deviceId: randomUUID(), sequence: 1, entity: "link", entityId: link, action: "delete", payload: {}, createdAt: new Date().toISOString(), baseRevision: Number(revision) }];
      const result = (await client.query("select public.apply_workspace_operations($1::jsonb,$2) as value", [JSON.stringify(operations), revision])).rows[0].value;
      assert.equal(result.outcomes[0].status, "applied");
      assert.ok(result.outcomes[0].trashId);
      assert.equal((await client.query("select id from public.links where id=$1", [link])).rowCount, 0);
    });
  } finally {
    // This also rolls back DDL and grants, preserving the additive-migration
    // baseline for other local work and allowing the whole test to run again.
    await client.query("rollback");
    await client.end();
  }
});
