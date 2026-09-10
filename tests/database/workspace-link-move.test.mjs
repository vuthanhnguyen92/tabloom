import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import pg from "pg";

// Fixed local endpoint only; these fixtures can never target hosted data.
const localDatabase = { host: "127.0.0.1", port: 54322, database: "postgres", user: "postgres", password: "postgres" };

for (const change of ["content edit", "Trash delete", "membership change"]) {
  test(`structural move waits for an in-flight ${change} and checks its committed result`, { timeout: 10000 }, async () => {
    const admin = new pg.Client(localDatabase), writer = new pg.Client(localDatabase), mover = new pg.Client(localDatabase);
    const owner = randomUUID(), space = randomUUID(), source = randomUUID(), destination = randomUUID(), third = randomUUID();
    const link = randomUUID(), sibling = randomUUID(), target = randomUUID();
    await Promise.all([admin.connect(), writer.connect(), mover.connect()]);
    let moving;
    try {
      await admin.query("insert into auth.users(id,aud,role,email) values($1,'authenticated','authenticated',$2)", [owner, `${owner}@move.test`]);
      await admin.query("insert into public.spaces(id,user_id,name,position) values($1,$2,'Race test',0)", [space, owner]);
      await admin.query("insert into public.collections(id,user_id,space_id,name,position) values($1,$4,$5,'Source',0),($2,$4,$5,'Destination',1),($3,$4,$5,'Other',2)", [source, destination, third, owner, space]);
      await admin.query("insert into public.links(id,user_id,collection_id,url,title,position) values($1,$4,$5,'https://one.test','Original',0),($2,$4,$5,'https://two.test','Sibling',3),($3,$4,$6,'https://three.test','Target',5)", [link, sibling, target, owner, source, destination]);
      const expectedSource = [{ id: link, position: 0 }, { id: sibling, position: 3 }];
      const expectedDestination = [{ id: target, position: 5 }];
      for (const client of [writer, mover]) {
        await client.query("begin");
        await client.query("set local role authenticated");
        await client.query("set local statement_timeout='5s'");
        await client.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)", [owner]);
      }
      if (change === "content edit") await writer.query("update public.links set title='Edited elsewhere',url='https://edited.test',description='New note',favicon_url='https://edited.test/icon',updated_at=clock_timestamp() where id=$1", [link]);
      if (change === "Trash delete") await writer.query("select public.trash_workspace_entity('link',$1,'web',$2,null)", [link, randomUUID()]);
      if (change === "membership change") await writer.query("update public.links set collection_id=$2,position=7 where id=$1", [link, third]);
      moving = mover.query("select public.move_workspace_link($1,$2,$3,$4::jsonb,$5::jsonb,$6::uuid[],$7::uuid[]) as revision", [link, source, destination, JSON.stringify(expectedSource), JSON.stringify(expectedDestination), [sibling], [target, link]])
        .then((result) => ({ result }), (error) => ({ error }));
      // Prove the operations overlap, rather than relying on a timed sleep.
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        blocked = (await admin.query("select wait_event_type='Lock' as blocked from pg_stat_activity where pid=$1", [mover.processID])).rows[0]?.blocked;
        if (blocked) break;
        await setTimeout(10);
      }
      assert.equal(blocked, true, "move must wait for the concurrent transaction");
      await writer.query("commit");
      const beforeMove = (await admin.query("select id,collection_id,position,title,url,description,favicon_url from public.links where user_id=$1 order by id", [owner])).rows;
      const beforeRevision = (await admin.query("select revision from public.workspace_sync_state where user_id=$1", [owner])).rows[0].revision;
      const outcome = await moving;
      if (change === "content edit") {
        assert.equal(outcome.error, undefined);
        await mover.query("commit");
        const moved = (await admin.query("select collection_id,position,title,url,description,favicon_url from public.links where id=$1", [link])).rows[0];
        assert.deepEqual(moved, { collection_id: destination, position: 1, title: "Edited elsewhere", url: "https://edited.test", description: "New note", favicon_url: "https://edited.test/icon" });
        assert.equal(BigInt(outcome.result.rows[0].revision), BigInt(beforeRevision) + 1n);
      } else {
        assert.equal(outcome.error?.code, "40001");
        await mover.query("rollback");
        assert.deepEqual((await admin.query("select id,collection_id,position,title,url,description,favicon_url from public.links where user_id=$1 order by id", [owner])).rows, beforeMove);
        assert.equal((await admin.query("select revision from public.workspace_sync_state where user_id=$1", [owner])).rows[0].revision, beforeRevision);
        if (change === "Trash delete") assert.equal((await admin.query("select entity_id from public.workspace_tombstones where user_id=$1 and entity_type='link' and entity_id=$2", [owner, link])).rowCount, 1);
      }
    } finally {
      // Release the writer first so an assertion failure cannot strand the waiter.
      await writer.query("rollback");
      if (moving) await moving;
      await mover.query("rollback");
      // Only this test's randomly generated owner and cascading test fixtures.
      try {
        await admin.query("begin");
        // Cascading fixture deletion must not recreate the removed owner's sync state.
        await admin.query("select set_config('tabloom.merge_in_progress','on',true)");
        await admin.query("delete from auth.users where id=$1", [owner]);
        await admin.query("commit");
      } finally {
        await Promise.all([writer.end(), mover.end(), admin.end()]);
      }
    }
  });
}
