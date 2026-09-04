import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSharedCollection, SharedCollectionUnavailableError } from "../app/lib/shared-collection";

const token = "a".repeat(43);
const validSnapshot = {
  name: "Design references",
  links: [
    { id: "link-2", title: "Second", description: "", url: "https://example.com/2", favicon_url: null, position: 2 },
    { id: "link-1", title: "First", description: "Useful", url: "https://example.com/1", favicon_url: "https://example.com/favicon.ico", position: 1 },
  ],
};

describe("loadSharedCollection", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co/");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-anon-key");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("loads the allow-listed public snapshot without caching", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(validSnapshot), { status: 200 }));

    await expect(loadSharedCollection(token, fetcher)).resolves.toEqual({
      name: "Design references",
      links: [validSnapshot.links[1], validSnapshot.links[0]],
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://project.supabase.co/rest/v1/rpc/load_shared_collection",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        headers: expect.objectContaining({ apikey: "public-anon-key", "Content-Type": "application/json" }),
        body: JSON.stringify({ share_token: token }),
      }),
    );
  });

  it("preserves a null RPC response as unavailable", async () => {
    const fetcher = vi.fn(async () => new Response("null", { status: 200 }));
    await expect(loadSharedCollection(token, fetcher)).resolves.toBeNull();
  });

  it("rejects malformed tokens without making a request", async () => {
    const fetcher = vi.fn();
    await expect(loadSharedCollection("bad/token", fetcher)).rejects.toBeInstanceOf(SharedCollectionUnavailableError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["failed response", () => new Response("denied", { status: 500 })],
    ["malformed JSON", () => new Response("not-json", { status: 200 })],
    ["private fields", () => new Response(JSON.stringify({ ...validSnapshot, user_id: "private" }), { status: 200 })],
    ["unsafe URL", () => new Response(JSON.stringify({ ...validSnapshot, links: [{ ...validSnapshot.links[0], url: "javascript:alert(1)" }] }), { status: 200 })],
    ["invalid link", () => new Response(JSON.stringify({ ...validSnapshot, links: [{ ...validSnapshot.links[0], title: "" }] }), { status: 200 })],
  ])("turns %s into a generic token-free error", async (_label, response) => {
    const fetcher = vi.fn(async () => response());
    const error = await loadSharedCollection(token, fetcher).catch((reason) => reason);
    expect(error).toBeInstanceOf(SharedCollectionUnavailableError);
    expect(String(error)).not.toContain(token);
  });

  it("never reads or sends a service-role secret", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "never-send-this");
    const fetcher = vi.fn(async () => new Response("null", { status: 200 }));
    await loadSharedCollection(token, fetcher);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("never-send-this");
  });
});
