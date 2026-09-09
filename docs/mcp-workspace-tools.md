# Tabloom workspace MCP tools

Connect an MCP client to `https://tabloom.nickvu.dev/mcp` to read and, when
enabled, safely change your synchronized Tabloom workspace. The service uses
the `tabloom:workspace` OAuth scope and applies the authenticated user's
row-level security policy to every request.

MCP sees synchronized saved spaces, collections, and links only. Device-local
data that has not synchronized is unavailable. Browser-bookmark and other
read-only records are also excluded from mutation tools. If a recent local
change is missing, let Tabloom synchronize it before asking an MCP client to
act on it.

## Availability

`get_service_status` returns `mutationsEnabled`. Workspace mutations are
disabled by default because `TABLOOM_MCP_MUTATIONS_ENABLED` defaults to
`false`; only the literal value `true` enables them. While disabled, clients
can discover and call the read tools, but mutation tools are not registered and
cannot be called by name.

Read tools are always available when the OAuth service is available:

| Tool | Purpose |
| --- | --- |
| `get_workspace` | Read the complete saved workspace and current revision. |
| `list_spaces` | List saved spaces. |
| `list_collections` | List collections in one saved space. |
| `list_collection_items` | List saved links in one collection. |
| `search_workspace` | Search saved links. |
| `list_trash` | List the caller's unexpired, unrestored Trash entries. |

When mutations are enabled, clients can create and update spaces,
collections, and links; move and reorder links; delete to Trash; and restore
Trash entries. All IDs and idempotency keys in tool arguments are UUIDs.

## Retry and concurrency contract

Supply a new `idempotencyKey` for each logical create, update, move, reorder,
or immediate link-deletion request. Never reuse a key across commands. If
delivery is uncertain, retry the same tool with the same key and exactly the
same arguments.

Create, update, move, and reorder commands fingerprint the command and its
arguments. An exact retry returns the original committed result instead of
applying the operation twice; different arguments or another fingerprinted
command with that key return `conflict`.

Immediate link deletion uses a separate Trash receipt scoped to the
authenticated user and bound to the original `itemId`, `rootType: "link"`, and
`source: "mcp"`. A replay for that item may return the original receipt even if
the retry supplies a different `expectedUpdatedAt`; using the key for another
item conflicts. This recovery behavior does not make the key reusable, so
always retry the exact original arguments.

Update, move, and link-deletion tools also require `expectedUpdatedAt`. Copy
this value exactly from the target's latest `updated_at` field. If another
client changed the record, Tabloom returns `conflict` without overwriting the
newer value. Read the record again, decide whether the requested change still
applies, and retry with a new idempotency key and the new timestamp.

## Create a collection

First use `list_spaces` to obtain the destination `spaceId`. Then call
`create_collection` with a unique retry key:

```json
{
  "spaceId": "20000000-0000-4000-8000-000000000001",
  "name": "Research",
  "idempotencyKey": "50000000-0000-4000-8000-000000000001"
}
```

The result contains the created collection, including its stable `id` and
server timestamps.

## Update without overwriting newer data

This `update_collection` example uses the exact `updated_at` returned by the
latest read:

```json
{
  "collectionId": "30000000-0000-4000-8000-000000000001",
  "name": "Architecture research",
  "expectedUpdatedAt": "2026-09-10T08:15:30.123456Z",
  "idempotencyKey": "50000000-0000-4000-8000-000000000002"
}
```

Never guess or round `expectedUpdatedAt`; PostgreSQL timestamps may contain
submillisecond precision.

## Delete a space or collection

Space and collection deletion requires a prepare-and-confirm exchange. A
prepare call does not delete anything. It returns the target name, descendant
counts, an `intentId`, and an expiry time so the MCP host can show the exact
impact to you.

Call `prepare_delete_collection`:

```json
{
  "collectionId": "30000000-0000-4000-8000-000000000001"
}
```

A representative result is:

```json
{
  "data": {
    "intentId": "60000000-0000-4000-8000-000000000001",
    "targetType": "collection",
    "targetId": "30000000-0000-4000-8000-000000000001",
    "targetName": "Architecture research",
    "collectionCount": 1,
    "linkCount": 4,
    "expiresAt": "2026-09-10T08:25:30.123456Z"
  }
}
```

The host must ask you to confirm after presenting these details. Only after you
confirm may it call `confirm_delete_collection`:

```json
{
  "intentId": "60000000-0000-4000-8000-000000000001"
}
```

Delete intents expire after 10 minutes and are single-use. If the target or
its descendants change, the confirmation fails with `conflict`; prepare again
and review the new impact. An expired, fabricated, cross-user, or already
consumed intent cannot authorize a new deletion. Retrying the same confirmation
after an uncertain response safely returns its original deletion receipt.

The confirmation result includes `trashId` and `restoreUntil`. The collection
and its saved links remain recoverable in Trash for 30 days.

## Delete a link immediately

A saved link does not require the prepare-and-confirm exchange. Calling
`delete_collection_item` moves it to Trash immediately, so the host should
treat the call itself as destructive:

```json
{
  "itemId": "40000000-0000-4000-8000-000000000001",
  "expectedUpdatedAt": "2026-09-10T08:20:00.654321Z",
  "idempotencyKey": "50000000-0000-4000-8000-000000000003"
}
```

A successful deletion returns recovery metadata:

```json
{
  "data": {
    "operationId": "50000000-0000-4000-8000-000000000003",
    "trashId": "70000000-0000-4000-8000-000000000001",
    "rootType": "link",
    "rootId": "40000000-0000-4000-8000-000000000001",
    "restoreUntil": "2026-10-10T08:20:01.000000Z"
  }
}
```

## List Trash

Call `list_trash` with an empty argument object:

```json
{}
```

Each returned entry includes its `id` (the `trashId` used for restore), root
type and name, deletion source and time, expiry time, and saved snapshot.
Entries disappear from this list after restoration or after the 30-day
recovery window expires.

## Restore to the original parent

To restore a space, or to restore a collection or link whose original parent
still exists, call `restore_trash_item` with only `trashId`:

```json
{
  "trashId": "70000000-0000-4000-8000-000000000001"
}
```

A successful restore returns `status: "restored"` with the affected workspace
snapshot and current revision. Retrying an already successful restore is safe.

## Restore to an alternate destination

If a collection's original space or a link's original collection no longer
exists, the first restore returns `status: "destination_required"` and a
`destinationType` of `space` or `collection`. Choose an existing writable
destination owned by the same user and retry with `destinationId`.

For example, restore a collection to another space:

```json
{
  "trashId": "70000000-0000-4000-8000-000000000002",
  "destinationId": "20000000-0000-4000-8000-000000000002"
}
```

For a deleted link, `destinationId` must instead identify an existing writable
collection. Spaces always restore at the workspace root and reject a
destination. An invalid or cross-user destination does not mutate the Trash
entry, which remains recoverable until its original expiry.

## Recovery limits

Trash is a 30-day recovery path, not permanent storage. Restore before the
entry's `expiresAt` or deletion receipt's `restoreUntil`. A restore never
overwrites a live row with the same ID, and failed deletion or restoration
transactions leave the previous live or Trash state intact.

For deployment, enablement, acceptance, and rollback procedures, see the
[MCP operator guide](mcp-setup.md).
