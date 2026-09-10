import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

test("durable collection moves change parent and both orders atomically without recreating content", async () => {
  const db = new pg.Client({ host: "127.0.0.1", port: 54322, database: "postgres", user: "postgres", password: "postgres" });
  await db.connect(); await db.query("begin");
  try {
    const owner = randomUUID(), foreign = randomUUID(), source = randomUUID(), target = randomUUID(), forbidden = randomUUID();
    const collection = randomUUID(), sibling = randomUUID(), targetSibling = randomUUID(), link = randomUUID(), device = randomUUID();
    await db.query("insert into auth.users(id,aud,role,email) values($1,'authenticated','authenticated',$2),($3,'authenticated','authenticated',$4)", [owner, `${owner}@example.test`, foreign, `${foreign}@example.test`]);
    await db.query("insert into spaces(id,user_id,name,position) values($1,$2,'Source',0),($3,$2,'Target',1),($4,$5,'Foreign',0)", [source, owner, target, forbidden, foreign]);
    await db.query("insert into collections(id,user_id,space_id,name,position) values($1,$2,$3,'Latest content',0),($4,$2,$3,'Source sibling',1),($5,$2,$6,'Target sibling',0)", [collection, owner, source, sibling, targetSibling, target]);
    await db.query("insert into links(id,user_id,collection_id,title,url,position) values($1,$2,$3,'Keep link','https://example.com',0)", [link, owner, collection]);
    await db.query("set local role authenticated"); await db.query("select set_config('request.jwt.claim.sub',$1,true)", [owner]);
    let sequence = 0;
    const op = (action, entityId, payload) => ({ operationId: randomUUID(), deviceId: device, sequence: ++sequence, entity: "collection", entityId, action, payload, createdAt: new Date().toISOString(), baseRevision: 0 });
    const apply = async (operations) => {
      const revision = (await db.query("select revision from workspace_sync_state where user_id=$1", [owner])).rows[0].revision;
      return (await db.query("select apply_workspace_operations($1::jsonb,$2) as result", [JSON.stringify(operations), revision])).rows[0].result;
    };
    const move = op("move", collection, { sourceSpaceId: source, destinationSpaceId: target });
    const moved = await apply([move]);
    assert.equal(moved.outcomes[0].status, "applied");
    assert.deepEqual((await db.query("select id,space_id,position,name from collections where user_id=$1 order by id", [owner])).rows,
      [{ id: collection, space_id: target, position: 1, name: "Latest content" }, { id: sibling, space_id: source, position: 0, name: "Source sibling" }, { id: targetSibling, space_id: target, position: 0, name: "Target sibling" }].sort((a,b) => a.id.localeCompare(b.id)));
    assert.equal((await db.query("select collection_id from links where id=$1", [link])).rows[0].collection_id, collection);
    const replay = await apply([move]);
    assert.equal(replay.outcomes[0].status, "already_applied"); assert.equal(replay.revision, moved.revision);
    assert.equal((await apply([{ ...move, payload: { sourceSpaceId: target, destinationSpaceId: source } }])).outcomes[0].status, "rejected");
    const rejected = await apply([op("move", collection, { sourceSpaceId: target, destinationSpaceId: forbidden }), op("update", collection, { name: "Queue continues" })]);
    assert.equal(rejected.outcomes[0].status, "rejected"); assert.equal(rejected.outcomes[1].status, "applied");
    assert.equal((await db.query("select space_id,name from collections where id=$1", [collection])).rows[0].space_id, target);
    assert.equal((await db.query("select name from collections where id=$1", [collection])).rows[0].name, "Queue continues");
  } finally { await db.query("rollback"); await db.end(); }
});
