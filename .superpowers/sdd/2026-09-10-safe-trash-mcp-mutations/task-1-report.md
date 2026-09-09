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

## Round 1 review fixes

Added a focused valid entry/snapshot fixture and regression coverage for malformed nested space records and inconsistent entry root metadata. The implementation now validates nested Space, Collection, and SavedLink records (including exact keys, metadata, positions, timestamps, and saveable URLs) before delegating to `decodeWorkspaceSnapshot`. Entry decoding also requires the entry root type to equal the snapshot root type and the root ID to exist in the corresponding snapshot array. Removed the redundant `TrashSnapshotDestination` alias.

RED evidence:

```text
$ rtk npx vitest run tests/trash.test.ts
Test Files  1 failed (1)
Tests       1 failed | 6 passed (7)
Failure: expected [Function] to throw an error
```

GREEN evidence:

```text
$ rtk npx vitest run tests/trash.test.ts tests/domain.test.ts
Test Files  2 passed (2)
Tests       20 passed (20)

$ rtk npx tsc --noEmit
TypeScript: No errors found
```
