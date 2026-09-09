# Task 1 report: Trash and mutation result contracts

## Implementation

Added `shared/trash.ts` with the requested trash root/source unions, versioned snapshot and trash-entry records, deletion receipt and single-use deletion intent contracts, restore destination type, and machine-readable `WorkspaceCommandError`.

Added strict decoders for trash snapshots, trash entries, delete receipts, and delete intents. Decoders enforce exact keys, UUIDs, supported enums, finite timestamps, non-negative integer intent counts, future intent expiry, and recursive snapshot decoding through the existing `decodeWorkspaceSnapshot` repository decoder.

## Files

- `shared/trash.ts`
- `tests/trash.test.ts`

## Test commands and results

RED evidence:

```text
$ rtk npx vitest run tests/trash.test.ts
Error: Failed to resolve import "../shared/trash" from "tests/trash.test.ts"
```

GREEN evidence:

```text
$ rtk npx vitest run tests/trash.test.ts tests/domain.test.ts
Test Files  2 passed (2)
Tests       19 passed (19)

$ rtk npx tsc --noEmit
TypeScript: No errors found

$ rtk git diff --check
# no output; passed
```

## Self-review

The public contract fields match the task brief. Runtime decoders return newly shaped values after validation, avoid trusting arbitrary input as typed records, and preserve the stable IDs represented by the input snapshots and receipts. The test suite covers valid receipt decoding, malformed and expired intents, missing versioned snapshots, exact-key rejection, and machine-readable command errors.

## Concerns

The brief did not specify the fields of `RestoreDestination`; it is represented as an object with optional `spaceId` and `collectionId` fields so future restore flows can require the relevant destination without constraining link/collection restoration prematurely. The existing domain snapshot decoder is intentionally reused as required, though its own record-level validation remains permissive.
