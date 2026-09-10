// @vitest-environment node
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Explicit opt-in: these tests create and remove dedicated users on LOCAL Supabase.
const url = process.env.TABLOOM_SAVE_TEST_SUPABASE_URL;
const key = process.env.TABLOOM_SAVE_TEST_SERVICE_ROLE_KEY;
const local = (() => {
  try {
    const parsed = new URL(url ?? "");
    return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
      && ["http:", "https:"].includes(parsed.protocol);
  } catch { return false; }
})();
const enabled = Boolean(local && key);

describe.skipIf(!enabled)("save RPC concurrency (requires explicit local URL and service role key)", () => {
  let admin: SupabaseClient;
  let owner: SupabaseClient;
  let recipient: SupabaseClient;
  let ownerId: string;
  let recipientId: string;
  let spaceId: string;
  const users: string[] = [];

  beforeAll(async () => {
    admin = createClient(url!, key!, { auth: { persistSession: false, autoRefreshToken: false } });
    async function identity() {
      const email = `save-race-${randomUUID()}@example.test`;
      const password = randomUUID();
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (created.error) throw created.error;
      const id = created.data.user.id;
      users.push(id);
      const client = createClient(url!, key!, { auth: { persistSession: false, autoRefreshToken: false } });
      const signedIn = await client.auth.signInWithPassword({ email, password });
      if (signedIn.error) throw signedIn.error;
      return { id, client };
    }
    const a = await identity();
    const b = await identity();
    owner = a.client; ownerId = a.id;
    recipient = b.client; recipientId = b.id;
    spaceId = randomUUID();
    const { error } = await owner.from("spaces").insert({ id: spaceId, user_id: ownerId, name: "Race source", position: 0 });
    if (error) throw error;
  });

  afterAll(async () => {
    // Remove only users created by this run; cascading FKs clean up fixtures.
    for (const id of users) {
      const removed = await admin.from("spaces").delete().eq("user_id", id);
      if (removed.error) throw removed.error;
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw error;
    }
  });

  async function fixture() {
    const id = randomUUID();
    const name = `Atomic ${id}`;
    const inserted = await owner.from("collections").insert({ id, user_id: ownerId, space_id: spaceId, name, position: 0 });
    if (inserted.error) throw inserted.error;
    const links = await owner.from("links").insert([0, 1, 2].map(position => ({
      id: randomUUID(), user_id: ownerId, collection_id: id,
      url: `https://example.test/${position}`, title: `Link ${position}`, position,
    })));
    if (links.error) throw links.error;
    const shared = await owner.rpc("enable_collection_share", { target_collection_id: id });
    if (shared.error) throw shared.error;
    return { id, name, token: shared.data[0].token as string };
  }

  async function mappings(sourceId: string) {
    const result = await recipient.from("collection_saved_copies").select("saved_collection_id")
      .eq("source_collection_id", sourceId);
    if (result.error) throw result.error;
    return result.data;
  }

  it("two simultaneous saves return one complete private copy", async () => {
    const source = await fixture();
    const results = await Promise.all([0, 1].map(() => recipient.rpc("save_shared_collection", { share_token: source.token })));
    expect(results.map(result => result.error)).toEqual([null, null]);
    expect(results[0].data.collectionId).toBe(results[1].data.collectionId);
    expect(results.map(result => result.data.status).sort()).toEqual(["created", "saved"]);
    expect(await mappings(source.id)).toHaveLength(1);
    const copied = await recipient.from("links").select("title,position").eq("collection_id", results[0].data.collectionId).order("position");
    expect(copied.error).toBeNull();
    expect(copied.data).toEqual([0, 1, 2].map(position => ({ title: `Link ${position}`, position })));
    const privateShare = await recipient.from("collection_shares").select("id").eq("collection_id", results[0].data.collectionId);
    expect(privateShare.error).toBeNull();
    expect(privateShare.data).toEqual([]);
  });

  it("revocation racing a save leaves either a complete copy or no copy", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const source = await fixture();
      const [save, revoke] = await Promise.all([
        recipient.rpc("save_shared_collection", { share_token: source.token }),
        owner.rpc("disable_collection_share", { target_collection_id: source.id }),
      ]);
      expect(revoke.error).toBeNull();
      const rows = await mappings(source.id);
      if (save.error) {
        expect(save.error.code).toBe("P0002");
        expect(rows).toEqual([]);
        const orphan = await recipient.from("collections").select("id").eq("name", source.name);
        expect(orphan.error).toBeNull();
        expect(orphan.data).toEqual([]);
      } else {
        expect(rows).toEqual([{ saved_collection_id: save.data.collectionId }]);
        const copied = await recipient.from("links").select("id").eq("collection_id", save.data.collectionId).eq("user_id", recipientId);
        expect(copied.error).toBeNull();
        expect(copied.data).toHaveLength(3);
      }
    }
  });
});
