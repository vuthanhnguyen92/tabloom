import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

test("explicit extension restore uses owned Trash, preserves IDs and is idempotent", async () => {
  const db = new pg.Client({ host: "127.0.0.1", port: 54322, database: "postgres", user: "postgres", password: "postgres" });
  await db.connect();
  await db.query("begin");
  try {
    const owner = randomUUID(), other = randomUUID(), space = randomUUID(), collection = randomUUID(), link = randomUUID(), device = randomUUID();
    await db.query("insert into auth.users(id,aud,role,email) values($1,'authenticated','authenticated',$2),($3,'authenticated','authenticated',$4)", [owner, `${owner}@example.test`, other, `${other}@example.test`]);
    assert.equal((await db.query("select has_function_privilege('anon','public.list_workspace_trash_for_sync()','EXECUTE') as allowed")).rows[0].allowed, false);
    assert.equal((await db.query("select has_function_privilege('authenticated','public.apply_workspace_operations_before_restore(jsonb,bigint)','EXECUTE') as allowed")).rows[0].allowed, false);
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [owner]);
    await db.query("insert into spaces(id,user_id,name,position) values($1,$2,'Space',0)", [space, owner]);
    await db.query("insert into collections(id,user_id,space_id,name,position) values($1,$2,$3,'Collection',0)", [collection, owner, space]);
    await db.query("insert into links(id,user_id,collection_id,title,url,position) values($1,$2,$3,'Original','https://example.com',0)", [link, owner, collection]);
    let sequence = 0;
    const op = (action, payload, entity = "link", entityId = link) => ({ operationId: randomUUID(), deviceId: device, sequence: ++sequence, entity, entityId, action, payload, createdAt: new Date().toISOString(), baseRevision: 0 });
    const apply = async (operations) => {
      const revision = (await db.query("select revision from workspace_sync_state where user_id=$1", [owner])).rows[0].revision;
      return (await db.query("select apply_workspace_operations($1::jsonb,$2) as result", [JSON.stringify(operations), revision])).rows[0].result;
    };
    const deletion = op("delete", {});
    const restoration = op("restore", { deleteOperationId: deletion.operationId, snapshot: { links: [{ id: link, title: "Forged" }], spaces: [], collections: [] } });
    const result = await apply([deletion, restoration]);
    assert.equal(result.outcomes.length, 2);
    assert.equal(result.outcomes[1].status, "applied");
    assert.equal(result.patches.links[0].title, "Original");
    assert.equal(result.patches.links[0].id, link);
    assert.equal(result.tombstones.some((item) => item.entityId === link), false);
    const replay = await apply([restoration]);
    assert.equal(replay.outcomes[0].status, "already_applied");
    assert.equal(replay.revision, result.revision);

    const deleteAgain = op("delete", {});
    await apply([deleteAgain]);
    const forSync = (await db.query("select list_workspace_trash_for_sync() as entries")).rows[0].entries;
    assert.equal(forSync[0].operationId, deleteAgain.operationId);
    await apply([op("delete", {}, "collection", collection)]);
    const missing = op("restore", { deleteOperationId: deleteAgain.operationId, snapshot: {} });
    const missingResult = await apply([missing]);
    assert.equal(missingResult.outcomes[0].status, "rejected");
    assert.equal(missingResult.outcomes[0].message, "destination_required");
    const target = randomUUID();
    await db.query("insert into collections(id,user_id,space_id,name,position) values($1,$2,$3,'Target',0)", [target, owner, space]);
    const altered = await apply([{ ...missing, payload: { ...missing.payload, destinationId: target } }]);
    assert.equal(altered.outcomes[0].status, "rejected");
    await apply([op("restore", { ...missing.payload, destinationId: target })]);
    assert.equal((await db.query("select collection_id from links where id=$1", [link])).rows[0].collection_id, target);
    const finalDeletion = await apply([op("delete", {})]);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [other]);
    assert.deepEqual((await db.query("select list_workspace_trash_for_sync() as entries")).rows[0].entries, []);
    const foreign = await db.query("select apply_workspace_operations($1::jsonb,0) as result", [JSON.stringify([op("restore", { trashId: finalDeletion.outcomes[0].trashId, snapshot: {} })])]);
    assert.equal(foreign.rows[0].result.outcomes[0].status, "rejected");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [owner]);
    await apply([op("restore", { trashId: finalDeletion.outcomes[0].trashId, snapshot: {} })]);
    assert.equal((await db.query("select title from links where id=$1", [link])).rows[0].title, "Original");

    // Another device deletes first. Our queued delete must bind to precisely
    // that owner's same-root current tombstone receipt, not an ancestor tree.
    const remoteDelete = op("delete", {});
    const remoteReceipt = (await apply([remoteDelete])).outcomes[0];
    const offlineDelete = op("delete", {});
    const undo = op("restore", { deleteOperationId: offlineDelete.operationId, snapshot: { links: [{ id: link, title: "Never trusted" }] } });
    const update = op("update", { title: "After Undo" });
    const concurrent = await apply([offlineDelete, undo, update]);
    assert.equal(concurrent.outcomes[0].trashId, remoteReceipt.trashId);
    assert.equal(concurrent.outcomes[1].status, "applied");
    assert.equal(concurrent.patches.links[0].title, "After Undo");
    const lossReplay = await apply([undo]);
    assert.equal(lossReplay.outcomes[0].status, "already_applied");
    const changedReplay = await apply([{ ...undo, payload: { ...undo.payload, destinationId: collection } }]);
    assert.equal(changedReplay.outcomes[0].status, "rejected");
    const alreadyRestored = await apply([op("restore", { ...undo.payload, destinationId: collection })]);
    assert.equal(alreadyRestored.outcomes[0].status, "rejected");
    assert.equal((await db.query("select collection_id from links where id=$1", [link])).rows[0].collection_id, target);

    const orphan = op("restore", { deleteOperationId: randomUUID(), snapshot: {} });
    const later = op("update", { name: "Queue proceeds" }, "space", space);
    const rejected = await apply([orphan, later]);
    assert.equal(rejected.outcomes[0].status, "rejected");
    assert.equal(rejected.outcomes[1].status, "applied");
    assert.equal((await apply([orphan])).outcomes[0].status, "rejected");
    // A prior read may have dropped a redundant local delete BEFORE Undo
    // existed. Resolve its now-orphaned receipt only with the same proof.
    await apply([op("delete", {})]);
    const lateUndo = op("restore", { deleteOperationId: randomUUID(), snapshot: {} });
    assert.equal((await apply([lateUndo])).outcomes[0].status, "applied");
    // An ancestor receipt is not equivalent to a child delete. Reject only
    // this restore; an unrelated later write must still complete.
    await apply([op("delete", {}, "collection", target)]);
    const childDelete = op("delete", {});
    const childUndo = op("restore", { deleteOperationId: childDelete.operationId, snapshot: {} });
    const ancestorResult = await apply([childDelete, childUndo, op("update", { name: "After rejection" }, "space", space)]);
    assert.equal(ancestorResult.outcomes[0].trashId, undefined);
    assert.equal(ancestorResult.outcomes[1].status, "rejected");
    assert.equal(ancestorResult.outcomes[2].status, "applied");
    assert.equal(ancestorResult.patches.links.length, 0);
  } finally { await db.query("rollback"); await db.end(); }
});
