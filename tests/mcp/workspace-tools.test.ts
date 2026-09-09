import type { SupabaseClient } from "@supabase/supabase-js";
import { createMcpHandler } from "mcp-handler";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWorkspaceTools } from "../../services/tabloom-mcp/src/workspace/register-tools";
import { workspaceToolError } from "../../services/tabloom-mcp/src/workspace/tool-result";
import { WorkspaceCommandError } from "../../services/tabloom-mcp/src/workspace/errors";
import type { TabloomRequestContext } from "../../services/tabloom-mcp/src/auth/request-context";

const USER = "10000000-0000-4000-8000-000000000001";
const SPACE = "20000000-0000-4000-8000-000000000001";
const COLLECTION = "30000000-0000-4000-8000-000000000001";
const ITEM = "40000000-0000-4000-8000-000000000001";
const KEY = "50000000-0000-4000-8000-000000000001";
const INTENT = "60000000-0000-4000-8000-000000000001";
const TRASH = "70000000-0000-4000-8000-000000000001";
const TIME = "2026-09-10T00:00:00.000Z";
const EXPIRY = "2099-10-10T00:00:00.000Z";
const meta = { user_id: USER, position: 0, origin: "saved", read_only: false, created_at: TIME, updated_at: TIME };
const snapshot = {
  spaces: [{ ...meta, id: SPACE, name: "Research", color: "#7357e6" }],
  collections: [{ ...meta, id: COLLECTION, space_id: SPACE, name: "Reading" }],
  links: [{ ...meta, id: ITEM, collection_id: COLLECTION, title: "Notes", description: "", url: "https://example.com", favicon_url: null, device_label: null }],
};
const reads = ["get_workspace", "list_spaces", "list_collections", "list_collection_items", "search_workspace", "list_trash"];
const writes = ["create_space", "update_space", "prepare_delete_space", "confirm_delete_space", "create_collection", "update_collection", "prepare_delete_collection", "confirm_delete_collection", "create_collection_item", "update_collection_item", "delete_collection_item", "move_collection_item", "reorder_collection_items", "restore_trash_item"];

function requestContext() {
  const calls: string[] = [];
  const rpc = async (name: string, args?: Record<string, unknown>) => {
    calls.push(name);
    if (name === "load_workspace_snapshot") return { data: { revision: 8, snapshot: { ...snapshot, secret: "provider-secret" } }, error: null };
    if (name === "prepare_workspace_delete") return { data: { intentId: INTENT, targetType: args?.p_target_type, targetId: args?.p_target_id, targetName: "Reading", collectionCount: 1, linkCount: 1, expiresAt: EXPIRY }, error: null };
    if (name === "trash_workspace_link_if_unchanged") return { data: { operationId: args?.p_operation_id, trashId: TRASH, rootType: "link", rootId: args?.p_link_id, restoreUntil: EXPIRY }, error: null };
    if (name === "list_workspace_trash") return { data: [], error: null };
    throw new Error(`Unexpected RPC ${name}`);
  };
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: null, error: null }) };
  const context: TabloomRequestContext = { userId: USER, clientId: "https://client.example/oauth.json", scope: "tabloom:workspace", supabase: { rpc, from: () => query } as unknown as SupabaseClient };
  return { context, calls };
}

async function send(mutationsEnabled: boolean, method: string, params: Record<string, unknown>, context?: TabloomRequestContext) {
  const handler = createMcpHandler((server) => registerWorkspaceTools(server, { mutationsEnabled }));
  const request = new Request("https://tabloom.nickvu.dev/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (context) request.auth = { token: "outer-secret", clientId: context.clientId, scopes: [context.scope], extra: { requestContext: context } };
  const response = await handler(request);
  expect(response.status).toBe(200);
  const body = await response.text();
  return JSON.parse(body.startsWith("{") ? body : body.split("\n").find((line) => line.startsWith("data: "))!.slice(6));
}

afterEach(() => vi.restoreAllMocks());

describe("workspace MCP tools", () => {
  it("always registers discovery and excludes every mutation when disabled", async () => {
    const result = await send(false, "tools/list", {});
    expect(result.error).toBeUndefined();
    expect(result.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([...reads].sort());
    const writable = await send(true, "tools/list", {});
    expect(writable.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([...reads, ...writes].sort());
  });

  it("does not execute a disabled write even when called by name", async () => {
    const { context, calls } = requestContext();
    const response = await send(false, "tools/call", { name: "delete_collection_item", arguments: { itemId: ITEM, expectedUpdatedAt: TIME, idempotencyKey: KEY } }, context);
    expect(response.error ?? response.result?.isError).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("advertises strict inputs, typed outputs, and accurate annotations", async () => {
    const { result } = await send(true, "tools/list", {});
    for (const tool of result.tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema.type).toBe("object");
      expect(tool.annotations.openWorldHint).toBe(false);
      expect(tool.annotations.readOnlyHint).toBe(reads.includes(tool.name));
      expect(tool.annotations.destructiveHint, tool.name).toBe([
        "update_space", "update_collection", "update_collection_item", "move_collection_item", "reorder_collection_items",
        "confirm_delete_space", "confirm_delete_collection", "delete_collection_item",
      ].includes(tool.name));
      expect(tool.annotations.idempotentHint).toBe(!tool.name.startsWith("prepare_delete_"));
    }
  });

  it("uses each authenticated request's client and sanitizes workspace output", async () => {
    const { context, calls } = requestContext();
    const response = await send(false, "tools/call", { name: "get_workspace", arguments: {} }, context);
    expect(response.result.structuredContent.data).toEqual({ revision: 8, snapshot });
    expect(calls).toEqual(["load_workspace_snapshot"]);
    expect(JSON.stringify(response)).not.toMatch(/provider-secret|outer-secret|supabase/);
    const other = requestContext();
    other.context.userId = "10000000-0000-4000-8000-000000000002";
    const second = await send(false, "tools/call", { name: "list_spaces", arguments: {} }, other.context);
    expect(second.result.structuredContent.data).toEqual([]);
    expect(other.calls).toEqual(["load_workspace_snapshot"]);
  });

  it("fails closed when the authenticated context is unavailable", async () => {
    const response = await send(true, "tools/call", { name: "list_spaces", arguments: {} });
    expect(response.result).toMatchObject({ isError: true, structuredContent: { error: { code: "validation_failed" } } });
  });

  it.each([
    ["unknown identity key", "list_spaces", { userId: USER }],
    ["invalid field type", "list_collections", { spaceId: 123 }],
    ["invalid mutation field type", "create_space", { name: 123, color: "#7357e6", idempotencyKey: KEY }],
  ])("returns stable validation errors for %s before any workspace call", async (_label, name, args) => {
    const { context, calls } = requestContext();
    const response = await send(true, "tools/call", { name, arguments: args }, context);
    expect(response.result).toMatchObject({ isError: true, structuredContent: { error: {
      code: "validation_failed", message: "The workspace command or response is invalid.", details: {},
    } } });
    expect(response.error).toBeUndefined();
    expect(response.result.content[0].text).toBe("The workspace command or response is invalid.");
    expect(calls).toEqual([]);
  });

  it("prepares without deleting and instructs the host to ask the user before confirmation", async () => {
    const { context, calls } = requestContext();
    const response = await send(true, "tools/call", { name: "prepare_delete_collection", arguments: { collectionId: COLLECTION } }, context);
    expect(response.result.structuredContent.data).toEqual({ intentId: INTENT, targetType: "collection", targetId: COLLECTION, targetName: "Reading", collectionCount: 1, linkCount: 1, expiresAt: EXPIRY });
    expect(response.result.content[0].text).toMatch(/ask.*user.*confirm/i);
    expect(response.result.content[0].text).toContain("confirm_delete_collection");
    expect(calls).toEqual(["load_workspace_snapshot", "prepare_workspace_delete"]);
  });

  it("returns link deletion recovery metadata", async () => {
    const { context, calls } = requestContext();
    const response = await send(true, "tools/call", { name: "delete_collection_item", arguments: { itemId: ITEM, expectedUpdatedAt: TIME, idempotencyKey: KEY } }, context);
    expect(response.result.structuredContent.data).toEqual({ operationId: KEY, trashId: TRASH, rootType: "link", rootId: ITEM, restoreUntil: EXPIRY });
    expect(calls).toEqual(["load_workspace_snapshot", "trash_workspace_link_if_unchanged"]);
  });

  it("removes secret messages and details from known errors", () => {
    const result = workspaceToolError(new WorkspaceCommandError("conflict", "secret-provider-message", { revision: 8, token: "secret-token" }));
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "conflict", details: { revision: 8 } } } });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("returns a correlation ID for unexpected failures and logs only approved metadata", () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    const metadata = { action: "list_spaces", targetType: "space" as const, targetId: null, userId: USER, clientId: "https://client.example/oauth.json" };
    const result = workspaceToolError(new Error("provider-secret"), metadata);
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "internal_error", correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/) } } });
    expect(JSON.stringify(result)).not.toContain("provider-secret");
    expect(logger).toHaveBeenCalledWith({ ...metadata, outcome: "internal_error", correlationId: Reflect.get(result.structuredContent.error, "correlationId") });
  });

  it.each(["rejected client", "database failure"])("correlates a %s through the actual MCP callback without exposing provider data", async (failure) => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    const { context } = requestContext();
    const secret = "private SQL select * from links; authorization: Bearer token-secret";
    context.supabase = { rpc: async () => {
      if (failure === "rejected client") throw new Error(secret);
      return { data: null, error: { code: "XX000", message: secret, details: "header-secret" } };
    } } as unknown as SupabaseClient;
    const response = await send(false, "tools/call", { name: "list_collections", arguments: { spaceId: SPACE } }, context);
    expect(response.result).toMatchObject({ isError: true, structuredContent: { error: {
      code: "internal_error", correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    } } });
    expect(logger).toHaveBeenCalledExactlyOnceWith({ action: "list_collections", targetType: "space", targetId: SPACE,
      userId: USER, clientId: context.clientId, outcome: "internal_error", correlationId: response.result.structuredContent.error.correlationId });
    expect(JSON.stringify([response, logger.mock.calls])).not.toMatch(/private SQL|authorization|Bearer|token-secret|header-secret|outer-secret/);
  });
});
