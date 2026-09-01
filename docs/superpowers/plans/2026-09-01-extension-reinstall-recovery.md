# Tabloom Extension Reinstall Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Tabloom state through extension updates and automatically restore a signed-in user's Supabase workspace after a true reinstall whenever silent browser authentication succeeds.

**Architecture:** Add a side-effect-controlled bootstrap coordinator that probes local storage before creating defaults, supports non-interactive PKCE OAuth, and writes a recovered remote snapshot into the existing account-scoped local-first cache. `ExtensionApp` renders existing local state immediately, holds the boot boundary while a clean install is being recovered, and falls back to a usable local workspace with explicit reconnection when recovery is unavailable.

**Tech Stack:** TypeScript 5.9, React 19, Vitest 4, Supabase JS 2, Chrome/Firefox WebExtensions Manifest V3, Safari Web Extension packaging.

**Spec:** `docs/superpowers/specs/2026-09-01-extension-reinstall-recovery-design.md`

## Global Constraints

- Never automatically open an interactive OAuth window during extension startup.
- Never store Supabase access tokens, refresh tokens, or complete workspace snapshots in browser synchronization storage.
- Preserve optimistic local mutations and the existing failed-sync Retry behavior.
- Preserve existing entity IDs, positions, and relationships when restoring from Supabase.
- Keep Chromium, Firefox, and Safari behavior behind shared browser and authentication interfaces.
- Preserve all unrelated uncommitted favicon and saved-link metadata work; stage only the intended hunks for each commit.
- A true uninstall cannot preserve unsynced local-only data; do not claim otherwise in UI or documentation.

---

## File Structure

- Create `extension/auth/recovery-preference.ts`: stores only `pending` or `suppressed` automatic-recovery intent in extension-local storage.
- Create `extension/workspace-bootstrap.ts`: coordinates local probing, stored-session lookup, silent recovery, remote restoration, and local fallback through injected dependencies.
- Create `tests/auth-recovery-preference.test.ts`: verifies persistence and logout suppression.
- Create `tests/workspace-bootstrap.test.ts`: verifies every bootstrap outcome without React or real browser APIs.
- Modify `extension/storage.ts`: expose non-mutating local repository probing separately from default creation.
- Modify `extension/auth/oauth.ts`: add silent OAuth mode and safe interaction-required classification.
- Modify `extension/supabase.ts`: expose interactive and silent sign-in entry points.
- Modify `extension/src.tsx`: consume the coordinator and prevent empty-default flashes.
- Modify `extension/WorkspaceBootBoundary.tsx`: expose the current restoration label accessibly.
- Modify `extension/SyncLoginPrompt.tsx`: show reconnect copy while keeping sign-in user initiated.
- Modify `extension/scripts/build-extension.mjs` and `extension/scripts/extension-identity.mjs`: centralize Safari identity values used by packaging and reports.
- Extend focused tests in `tests/extension-oauth.test.ts`, `tests/workspace-boot-boundary.test.tsx`, `tests/sync-login-prompt.test.tsx`, and `tests/extension-identity.test.ts`.

---

### Task 1: Split local workspace probing from default creation

**Files:**
- Modify: `extension/storage.ts`
- Create: `tests/local-workspace-bootstrap.test.ts`

**Interfaces:**
- Produces: `openLocalWorkspaceRepository(area?: StorageArea): Promise<WorkspaceRepository | null>`
- Preserves: `createLocalWorkspaceRepository(area?: StorageArea): Promise<WorkspaceRepository>`
- Guarantees: probing an empty storage area performs legacy migration reads but does not write `My Space` or `My Collection`.

- [ ] **Step 1: Write the failing empty-storage probe test**

```ts
import { describe, expect, it, vi } from "vitest";
import {
  createLocalWorkspaceRepository,
  openLocalWorkspaceRepository,
} from "../extension/storage";

function memoryArea(initial: Record<string, unknown> = {}) {
  const state = { ...initial };
  return {
    state,
    area: {
      get: vi.fn(async (key: string) => ({ [key]: state[key] })),
      set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(state, value); }),
      remove: vi.fn(async (key: string) => { delete state[key]; }),
    },
  };
}

describe("local workspace bootstrap", () => {
  it("does not create defaults while probing empty storage", async () => {
    const storage = memoryArea();

    await expect(openLocalWorkspaceRepository(storage.area)).resolves.toBeNull();
    expect(storage.area.set).not.toHaveBeenCalled();
  });

  it("creates My Space and My Collection only when explicitly requested", async () => {
    const storage = memoryArea();

    const repository = await createLocalWorkspaceRepository(storage.area);
    const snapshot = await repository.load();

    expect(snapshot.spaces.map((space) => space.name)).toEqual(["My Space"]);
    expect(snapshot.collections.map((collection) => collection.name)).toEqual(["My Collection"]);
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the missing export failure**

Run: `npm run test:unit -- tests/local-workspace-bootstrap.test.ts`

Expected: FAIL because `openLocalWorkspaceRepository` is not exported.

- [ ] **Step 3: Add a non-mutating repository opener**

Add to `LocalWorkspaceRepository` in `extension/storage.ts`:

```ts
static async openExisting(area: StorageArea): Promise<LocalWorkspaceRepository | null> {
  const cache = new ChromeSnapshotCache(area);
  return withLocalWorkspaceLock(async () => {
    await cache.migrateLegacyOnce();
    const existing = await cache.read();
    return existing
      ? new LocalWorkspaceRepository(
          new MemoryWorkspaceRepository("local-user", existing),
          cache,
        )
      : null;
  });
}
```

Export the wrapper beside `createLocalWorkspaceRepository`:

```ts
export function openLocalWorkspaceRepository(
  area: StorageArea = browserAdapter.storage,
): Promise<WorkspaceRepository | null> {
  return LocalWorkspaceRepository.openExisting(area);
}
```

Keep `LocalWorkspaceRepository.create` as the only path that creates or repairs the editable default collection.

- [ ] **Step 4: Run storage tests**

Run: `npm run test:unit -- tests/local-workspace-bootstrap.test.ts tests/extension.test.ts tests/workspace-cache.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the storage boundary**

```bash
git add extension/storage.ts tests/local-workspace-bootstrap.test.ts
git commit -m "refactor: separate workspace probing from initialization"
```

---

### Task 2: Persist automatic-recovery intent without storing credentials

**Files:**
- Create: `extension/auth/recovery-preference.ts`
- Create: `tests/auth-recovery-preference.test.ts`

**Interfaces:**
- Produces: `AuthRecoveryPreference` with `read()`, `markPending()`, `suppress()`, and `clear()`.
- Produces: `AuthRecoveryState = "pending" | "suppressed" | null`.
- Consumes: the same local `StorageArea` abstraction used by the browser adapter.

- [ ] **Step 1: Write failing preference tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { AuthRecoveryPreference } from "../extension/auth/recovery-preference";

function area() {
  const state: Record<string, unknown> = {};
  return {
    state,
    get: vi.fn(async (key: string) => ({ [key]: state[key] })),
    set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(state, value); }),
    remove: vi.fn(async (key: string) => { delete state[key]; }),
  };
}

describe("AuthRecoveryPreference", () => {
  it("records pending recovery without credentials", async () => {
    const storage = area();
    const preference = new AuthRecoveryPreference(storage);

    await preference.markPending();

    expect(await preference.read()).toBe("pending");
    expect(JSON.stringify(storage.state)).not.toMatch(/access_token|refresh_token/i);
  });

  it("suppresses automatic recovery after logout until manual sign-in", async () => {
    const storage = area();
    const preference = new AuthRecoveryPreference(storage);

    await preference.suppress();
    expect(await preference.read()).toBe("suppressed");

    await preference.clear();
    expect(await preference.read()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the missing module failure**

Run: `npm run test:unit -- tests/auth-recovery-preference.test.ts`

Expected: FAIL because `extension/auth/recovery-preference.ts` does not exist.

- [ ] **Step 3: Implement the preference**

```ts
import type { BrowserAdapter } from "../browser/types";

const AUTH_RECOVERY_KEY = "tabloom-auth-recovery-v1";

type StorageArea = BrowserAdapter["storage"];
export type AuthRecoveryState = "pending" | "suppressed" | null;

export class AuthRecoveryPreference {
  constructor(private readonly area: StorageArea) {}

  async read(): Promise<AuthRecoveryState> {
    const value = (await this.area.get(AUTH_RECOVERY_KEY))[AUTH_RECOVERY_KEY];
    return value === "pending" || value === "suppressed" ? value : null;
  }

  async markPending(): Promise<void> {
    await this.area.set({ [AUTH_RECOVERY_KEY]: "pending" });
  }

  async suppress(): Promise<void> {
    await this.area.set({ [AUTH_RECOVERY_KEY]: "suppressed" });
  }

  async clear(): Promise<void> {
    await this.area.remove(AUTH_RECOVERY_KEY);
  }
}
```

- [ ] **Step 4: Run the preference tests**

Run: `npm run test:unit -- tests/auth-recovery-preference.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the preference module**

```bash
git add extension/auth/recovery-preference.ts tests/auth-recovery-preference.test.ts
git commit -m "feat: track extension recovery intent"
```

---

### Task 3: Add non-interactive Supabase Google OAuth

**Files:**
- Modify: `extension/auth/oauth.ts`
- Modify: `extension/supabase.ts`
- Modify: `tests/extension-oauth.test.ts`

**Interfaces:**
- Produces: `ExtensionOAuthOptions = { interactive?: boolean; selectAccount?: boolean }`.
- Produces: `isSilentOAuthMiss(reason: unknown): boolean`.
- Preserves: `signInExtensionWithGoogle({ selectAccount?: boolean })` as an interactive user action.
- Produces: `recoverExtensionSessionSilently()` for bootstrap use.

- [ ] **Step 1: Add failing silent-flow tests**

Append to `tests/extension-oauth.test.ts`:

```ts
it("uses prompt none and a hidden browser flow for silent recovery", async () => {
  const expected = "https://stable-id.chromiumapp.org/auth-callback";
  const supabase = client();
  const identity = {
    getRedirectURL: () => expected,
    launchWebAuthFlow: vi.fn(async () => `${expected}?code=silent-code`),
  };

  await runExtensionGoogleOAuth(supabase, identity, "chromium", {
    interactive: false,
  });

  expect(supabase.auth.signInWithOAuth).toHaveBeenCalledWith({
    provider: "google",
    options: {
      queryParams: { prompt: "none" },
      redirectTo: expected,
      skipBrowserRedirect: true,
    },
  });
  expect(identity.launchWebAuthFlow).toHaveBeenCalledWith({
    url: "https://accounts.example/authorize",
    interactive: false,
  });
});

it("classifies a provider login requirement as a silent recovery miss", () => {
  const expected = "https://stable-id.chromiumapp.org/auth-callback";
  try {
    parseOAuthCallback(`${expected}?error=login_required`, expected);
  } catch (reason) {
    expect(isSilentOAuthMiss(reason)).toBe(true);
  }
});
```

Update the test import to include `isSilentOAuthMiss`.

- [ ] **Step 2: Run the OAuth tests and verify failure**

Run: `npm run test:unit -- tests/extension-oauth.test.ts`

Expected: FAIL because OAuth always passes `interactive: true`, omits `prompt=none`, and does not export `isSilentOAuthMiss`.

- [ ] **Step 3: Implement explicit OAuth modes**

In `extension/auth/oauth.ts`, add `"interaction_required"` to `ExtensionOAuthErrorCode` and define:

```ts
export interface ExtensionOAuthOptions {
  interactive?: boolean;
  selectAccount?: boolean;
}

export function isSilentOAuthMiss(reason: unknown): boolean {
  return reason instanceof ExtensionOAuthError && [
    "interaction_required",
    "cancelled",
    "platform_unavailable",
    "timeout",
  ].includes(reason.code);
}
```

Change `runExtensionGoogleOAuth` to default to interactive mode and select one prompt value:

```ts
const interactive = options.interactive ?? true;
const prompt = options.selectAccount ? "select_account" : interactive ? undefined : "none";
```

Pass `...(prompt ? { queryParams: { prompt } } : {})` to Supabase and pass the computed `interactive` value to `launchWebAuthFlow`.

In `parseOAuthCallback`, map `error=login_required`, `interaction_required`, and `consent_required` to an `ExtensionOAuthError("interaction_required", "Reconnect to restore your workspace.")`; continue redacting provider descriptions.

- [ ] **Step 4: Expose the silent Supabase entry point**

In `extension/supabase.ts`:

```ts
export async function recoverExtensionSessionSilently() {
  if (!extensionSupabase) throw new Error("Supabase is not configured.");
  return runExtensionGoogleOAuth(
    extensionSupabase,
    browserAdapter.identity,
    browserTarget,
    { interactive: false },
  );
}
```

Keep `signInExtensionWithGoogle` interactive by explicitly passing `{ ...options, interactive: true }`.

- [ ] **Step 5: Run OAuth and browser-adapter tests**

Run: `npm run test:unit -- tests/extension-oauth.test.ts tests/browser-adapter.test.ts`

Expected: PASS, including the existing interactive account-switch test.

- [ ] **Step 6: Commit silent OAuth support**

```bash
git add extension/auth/oauth.ts extension/supabase.ts tests/extension-oauth.test.ts
git commit -m "feat: support silent extension session recovery"
```

---

### Task 4: Build the deterministic bootstrap coordinator

**Files:**
- Create: `extension/workspace-bootstrap.ts`
- Create: `tests/workspace-bootstrap.test.ts`

**Interfaces:**
- Consumes: `openLocalWorkspaceRepository`, `createLocalWorkspaceRepository`, `recoverExtensionSessionSilently`, `SupabaseWorkspaceSyncRepository.loadVersioned`, and `ChromeSnapshotCache.saveCloud` through injected callbacks.
- Produces: `WorkspaceBootstrapResult` with exact modes `local-session`, `local-only`, `recovered`, `reconnect-required`, and `offline`.
- Produces: `bootstrapWorkspace(dependencies): Promise<WorkspaceBootstrapResult>`.

- [ ] **Step 1: Write failing coordinator tests with dependency factories**

Create `tests/workspace-bootstrap.test.ts` with a repository fixture and these cases:

```ts
import { describe, expect, it, vi } from "vitest";
import { ExtensionOAuthError } from "../extension/auth/oauth";
import {
  bootstrapWorkspace,
  type WorkspaceBootstrapDependencies,
} from "../extension/workspace-bootstrap";
import { createDemoSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository } from "../shared/repository";

const session = { user: { id: "user-1" } };
const localRepository = new MemoryWorkspaceRepository("local-user", createDemoSnapshot());
const remote = {
  revision: 42,
  snapshot: { spaces: [], collections: [], links: [] },
};

function dependencies(
  overrides: Partial<WorkspaceBootstrapDependencies<typeof session>> = {},
): WorkspaceBootstrapDependencies<typeof session> {
  return {
    openLocal: vi.fn(async () => null),
    createLocal: vi.fn(async () => localRepository),
    getStoredSession: vi.fn(async () => null),
    recoverSession: vi.fn(async () => session),
    loadRemote: vi.fn(async () => remote),
    saveRemote: vi.fn(async () => undefined),
    recoveryState: vi.fn(async () => null),
    markRecoveryPending: vi.fn(async () => undefined),
    clearRecoveryState: vi.fn(async () => undefined),
    canRecover: () => true,
    isOnline: () => true,
    ...overrides,
  };
}

describe("bootstrapWorkspace", () => {
  it("returns existing local data without running silent OAuth", async () => {
    const deps = dependencies({ openLocal: vi.fn(async () => localRepository) });
    const result = await bootstrapWorkspace(deps);
    expect(result).toMatchObject({ mode: "local-only", localRepository });
    expect(deps.recoverSession).not.toHaveBeenCalled();
  });

  it("restores remote data before creating defaults on an empty install", async () => {
    const deps = dependencies();
    const result = await bootstrapWorkspace(deps);
    expect(result).toMatchObject({ mode: "recovered", session });
    expect(deps.saveRemote).toHaveBeenCalledWith("user-1", remote);
    expect(deps.createLocal).not.toHaveBeenCalled();
  });

  it("creates local defaults after an expected silent recovery miss", async () => {
    const miss = new ExtensionOAuthError("interaction_required", "interaction required");
    const deps = dependencies({ recoverSession: vi.fn(async () => { throw miss; }) });
    const result = await bootstrapWorkspace(deps);
    expect(result).toMatchObject({ mode: "reconnect-required", localRepository });
    expect(deps.markRecoveryPending).toHaveBeenCalled();
  });

  it("does not silently recover after logout suppression", async () => {
    const deps = dependencies({ recoveryState: vi.fn(async () => "suppressed") });
    const result = await bootstrapWorkspace(deps);
    expect(result.mode).toBe("local-only");
    expect(deps.recoverSession).not.toHaveBeenCalled();
  });

  it("keeps a pending recovery eligible on a later focused launch", async () => {
    const deps = dependencies({
      openLocal: vi.fn(async () => localRepository),
      recoveryState: vi.fn(async () => "pending"),
    });
    const result = await bootstrapWorkspace(deps);
    expect(result).toMatchObject({ mode: "local-only", recoverySuggested: true });
  });

  it("uses normal local mode when Supabase is not configured", async () => {
    const deps = dependencies({ canRecover: () => false });
    const result = await bootstrapWorkspace(deps);
    expect(result).toMatchObject({ mode: "local-only", recoverySuggested: false });
    expect(deps.recoverSession).not.toHaveBeenCalled();
  });

  it("falls back locally while offline", async () => {
    const deps = dependencies({ isOnline: () => false });
    const result = await bootstrapWorkspace(deps);
    expect(result).toMatchObject({ mode: "offline", localRepository });
    expect(deps.recoverSession).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the coordinator tests and confirm the missing module failure**

Run: `npm run test:unit -- tests/workspace-bootstrap.test.ts`

Expected: FAIL because `extension/workspace-bootstrap.ts` does not exist.

- [ ] **Step 3: Define the result and dependency contracts**

In `extension/workspace-bootstrap.ts`:

```ts
import type { WorkspaceRepository } from "../shared/repository";
import type { VersionedWorkspaceSnapshot } from "../shared/workspace-merge";
import { isSilentOAuthMiss } from "./auth/oauth";

export interface BootstrapSession {
  user: { id: string };
}

export type WorkspaceBootstrapResult<TSession extends BootstrapSession = BootstrapSession> =
  | { mode: "local-session"; localRepository: WorkspaceRepository; session: TSession; recoverySuggested: false }
  | { mode: "local-only"; localRepository: WorkspaceRepository; session: null; recoverySuggested: boolean }
  | { mode: "recovered"; localRepository: null; session: TSession; recoverySuggested: false }
  | { mode: "reconnect-required"; localRepository: WorkspaceRepository; session: null; recoverySuggested: true }
  | { mode: "offline"; localRepository: WorkspaceRepository; session: TSession | null; recoverySuggested: true };

export interface WorkspaceBootstrapDependencies<TSession extends BootstrapSession = BootstrapSession> {
  openLocal(): Promise<WorkspaceRepository | null>;
  createLocal(): Promise<WorkspaceRepository>;
  getStoredSession(): Promise<TSession | null>;
  recoverSession(): Promise<TSession>;
  loadRemote(): Promise<VersionedWorkspaceSnapshot>;
  saveRemote(userId: string, value: VersionedWorkspaceSnapshot): Promise<void>;
  recoveryState(): Promise<"pending" | "suppressed" | null>;
  markRecoveryPending(): Promise<void>;
  clearRecoveryState(): Promise<void>;
  canRecover(): boolean;
  isOnline(): boolean;
}
```

- [ ] **Step 4: Implement the minimal decision tree**

Implement `bootstrapWorkspace` in this order:

```ts
export async function bootstrapWorkspace<TSession extends BootstrapSession>(
  dependencies: WorkspaceBootstrapDependencies<TSession>,
): Promise<WorkspaceBootstrapResult<TSession>> {
  const [localRepository, storedSession, recoveryState] = await Promise.all([
    dependencies.openLocal(),
    dependencies.getStoredSession(),
    dependencies.recoveryState(),
  ]);

  if (localRepository) {
    return storedSession
      ? { mode: "local-session", localRepository, session: storedSession, recoverySuggested: false }
      : { mode: "local-only", localRepository, session: null, recoverySuggested: recoveryState === "pending" };
  }

  if (!dependencies.canRecover()) {
    return {
      mode: "local-only",
      localRepository: await dependencies.createLocal(),
      session: null,
      recoverySuggested: false,
    };
  }

  if (!dependencies.isOnline()) {
    await dependencies.markRecoveryPending();
    return {
      mode: "offline",
      localRepository: await dependencies.createLocal(),
      session: storedSession,
      recoverySuggested: true,
    };
  }

  if (recoveryState === "suppressed") {
    return {
      mode: "local-only",
      localRepository: await dependencies.createLocal(),
      session: null,
      recoverySuggested: false,
    };
  }

  try {
    const recoveredSession = storedSession ?? await dependencies.recoverSession();
    const versioned = await dependencies.loadRemote();
    await dependencies.saveRemote(recoveredSession.user.id, versioned);
    await dependencies.clearRecoveryState();
    return { mode: "recovered", localRepository: null, session: recoveredSession, recoverySuggested: false };
  } catch (reason) {
    await dependencies.markRecoveryPending();
    const fallback = await dependencies.createLocal();
    if (isSilentOAuthMiss(reason)) {
      return { mode: "reconnect-required", localRepository: fallback, session: null, recoverySuggested: true };
    }
    return { mode: "offline", localRepository: fallback, session: storedSession, recoverySuggested: true };
  }
}
```

Make `loadRemote` close over the recovered client session; Supabase JS stores the exchanged session before `loadVersioned` runs.

- [ ] **Step 5: Run coordinator and storage tests**

Run: `npm run test:unit -- tests/workspace-bootstrap.test.ts tests/local-workspace-bootstrap.test.ts tests/extension-oauth.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the bootstrap domain module**

```bash
git add extension/workspace-bootstrap.ts tests/workspace-bootstrap.test.ts
git commit -m "feat: coordinate extension workspace recovery"
```

---

### Task 5: Integrate recovery into the React startup and account UI

**Files:**
- Modify: `extension/src.tsx`
- Modify: `extension/WorkspaceBootBoundary.tsx`
- Modify: `extension/SyncLoginPrompt.tsx`
- Modify: `tests/workspace-boot-boundary.test.tsx`
- Modify: `tests/sync-login-prompt.test.tsx`
- Create: `tests/extension-bootstrap-integration.test.tsx`

**Interfaces:**
- Consumes: `bootstrapWorkspace`, `AuthRecoveryPreference`, `openLocalWorkspaceRepository`, and `recoverExtensionSessionSilently`.
- Produces: `WorkspaceBootBoundary({ children, ready, label })`.
- Extends: `SyncLoginPromptProps` with `recoverySuggested?: boolean`.
- Preserves: existing interactive sign-in, first-sync merge confirmation, logout-local-copy behavior, and event-driven mutation sync.

- [ ] **Step 1: Add failing boot-label and reconnect-copy tests**

In `tests/workspace-boot-boundary.test.tsx`, assert:

```tsx
render(<WorkspaceBootBoundary ready={false} label="Restoring workspace"><div>ready</div></WorkspaceBootBoundary>);
expect(screen.getByRole("main", { name: "Restoring workspace" })).toHaveAttribute("aria-busy", "true");
```

In `tests/sync-login-prompt.test.tsx`, render a signed-out configured prompt with `recoverySuggested` and assert:

```ts
expect(screen.getByRole("button", { name: /Reconnect to restore workspace/i })).toBeVisible();
expect(onSignIn).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run the component tests and verify prop/type failures**

Run: `npm run test:unit -- tests/workspace-boot-boundary.test.tsx tests/sync-login-prompt.test.tsx`

Expected: FAIL because the new props and copy do not exist.

- [ ] **Step 3: Implement the focused UI props**

Change `WorkspaceBootBoundary` to accept `label = "Loading Tabloom workspace"` and apply it to the boot shell's `aria-label`.

Extend `SyncLoginPromptProps` with:

```ts
recoverySuggested?: boolean;
```

For the signed-out trigger, render:

```tsx
<button className="sync-login-trigger" onClick={() => setOpen(true)}>
  <Cloud size={15} />
  {recoverySuggested ? "Reconnect to restore workspace" : "Sign in to sync"}
</button>
```

Keep modal opening and `onSignIn` entirely click-driven.

- [ ] **Step 4: Write a failing startup integration test**

Mock the bootstrap coordinator in `tests/extension-bootstrap-integration.test.tsx` and assert these observable behaviors:

```ts
it("keeps the boot boundary mounted until clean-install recovery resolves", async () => {
  const deferred = Promise.withResolvers<WorkspaceBootstrapResult>();
  mockBootstrap.mockReturnValue(deferred.promise);

  render(<ExtensionApp />);
  expect(screen.getByRole("main", { name: "Restoring workspace" })).toBeVisible();
  expect(screen.queryByText("My Collection")).not.toBeInTheDocument();

  deferred.resolve({
    mode: "recovered",
    localRepository: null,
    session,
    recoverySuggested: false,
  });
  await waitFor(() => expect(screen.queryByRole("main", { name: "Restoring workspace" })).not.toBeInTheDocument());
});
```

Export `ExtensionApp` for the test. Mock account activation at module boundaries so the test does not call Supabase.

- [ ] **Step 5: Replace the mount bootstrap sequence in `ExtensionApp`**

Create one `AuthRecoveryPreference(browserAdapter.storage)` instance and call `bootstrapWorkspace` from the mount effect with these production dependencies:

```ts
const result = await bootstrapWorkspace({
  openLocal: () => openLocalWorkspaceRepository(),
  createLocal: () => createLocalWorkspaceRepository(),
  getStoredSession: async () => {
    if (!extensionSupabase) return null;
    return (await extensionSupabase.auth.getSession()).data.session;
  },
  recoverSession: recoverExtensionSessionSilently,
  loadRemote: () => {
    if (!extensionSupabase) throw new Error("Supabase is not configured.");
    return new SupabaseWorkspaceSyncRepository(extensionSupabase).loadVersioned();
  },
  saveRemote: (userId, value) => cache.saveCloud(userId, value),
  recoveryState: () => authRecoveryPreference.read(),
  markRecoveryPending: () => authRecoveryPreference.markPending(),
  clearRecoveryState: () => authRecoveryPreference.clear(),
  canRecover: () => Boolean(extensionSupabase) && browserAdapter.capabilities.identity,
  isOnline: () => navigator.onLine,
});
```

Handle results without rendering a default snapshot first:

- `recovered`: set the user and call `activateCanonical(userId, generation)`.
- `local-session`: store the local repository, render it, then call `beginWorkspaceSync`.
- `local-only`: store and render the local repository.
- `reconnect-required`: store and render the local repository, set `recoverySuggested`.
- `offline`: store and render the local repository, set the existing offline message and preserve any recovered session for Retry.

Pass `label="Restoring workspace"` while bootstrap is pending. Clear the recovery preference after manual sign-in succeeds. Call `authRecoveryPreference.suppress()` only after Supabase logout succeeds.

When logout occurs after a recovered install with no local anonymous repository, create the local repository inside `logout()` before merging the account snapshot into it.

- [ ] **Step 6: Add one-shot focused retry for a pending reinstall recovery**

When bootstrap returns `reconnect-required` or `offline`, retain `recoverySuggested = true` and add a guarded helper in `ExtensionApp`:

```ts
async function retrySilentRecovery(local: WorkspaceRepository) {
  if (!extensionSupabase || !recoverySuggested || silentRecoveryBusyRef.current) return;
  silentRecoveryBusyRef.current = true;
  const generation = ++activationGenerationRef.current;
  try {
    const session = await recoverExtensionSessionSilently();
    if (activationGenerationRef.current !== generation) return;
    await authRecoveryPreference.clear();
    setRecoverySuggested(false);
    setUser(session.user);
    await beginWorkspaceSync(session.user.id, local, generation);
  } catch (reason) {
    if (!isSilentOAuthMiss(reason) && activationGenerationRef.current === generation) {
      setError(reason instanceof Error ? reason.message : "Could not restore your workspace.");
    }
  } finally {
    silentRecoveryBusyRef.current = false;
  }
}
```

Register focus and visibility listeners in an effect that makes at most one attempt per focused new-tab lifetime:

```ts
useEffect(() => {
  const local = localRepositoryRef.current;
  if (!recoverySuggested || !local) return;
  let attempted = false;
  const attempt = () => {
    if (attempted || document.visibilityState !== "visible") return;
    attempted = true;
    void retrySilentRecovery(local);
  };
  window.addEventListener("focus", attempt);
  document.addEventListener("visibilitychange", attempt);
  return () => {
    window.removeEventListener("focus", attempt);
    document.removeEventListener("visibilitychange", attempt);
  };
}, [recoverySuggested]);
```

Reuse `activationGenerationRef` to discard stale results. On success, `beginWorkspaceSync` ensures tabs created after reinstall go through the established merge confirmation. Do not add intervals, alarms, or recursive timeouts.

- [ ] **Step 7: Run component and integration tests**

Run: `npm run test:unit -- tests/extension-bootstrap-integration.test.tsx tests/workspace-boot-boundary.test.tsx tests/sync-login-prompt.test.tsx tests/first-sync.test.ts tests/logout-workspace.test.ts`

Expected: PASS with no unsolicited call to interactive `onSignIn`.

- [ ] **Step 8: Commit the React integration using selective staging**

Because `extension/src.tsx` already contains unrelated saved-link metadata changes, inspect and stage only bootstrap hunks with `git add -p extension/src.tsx`. Then stage the complete focused files:

```bash
git add extension/WorkspaceBootBoundary.tsx extension/SyncLoginPrompt.tsx \
  tests/workspace-boot-boundary.test.tsx tests/sync-login-prompt.test.tsx \
  tests/extension-bootstrap-integration.test.tsx
git commit -m "feat: restore workspace during extension startup"
```

---

### Task 6: Lock browser identities and run full acceptance verification

**Files:**
- Modify: `extension/scripts/build-extension.mjs`
- Modify: `extension/scripts/extension-identity.mjs`
- Modify: `tests/extension-identity.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: exported `SAFARI_APP_BUNDLE_ID` and `SAFARI_EXTENSION_ID` constants shared by packaging reports.
- Verifies: the checked-in Chromium public key, Firefox Gecko ID, and Safari bundle values remain deterministic.
- Documents: update/reload persistence, reinstall cloud restoration, silent-recovery limits, and JSON export for local-only users.

- [ ] **Step 1: Add failing identity consistency tests**

In `tests/extension-identity.test.ts`, import the Safari constants and assert:

```ts
expect(SAFARI_APP_BUNDLE_ID).toBe("app.tabloom.extension");
expect(SAFARI_EXTENSION_ID).toBe("app.tabloom.mac.extension");
expect(createAuthReport("safari", {}).extensionId).toBe(SAFARI_EXTENSION_ID);
```

Also retain the existing deterministic Chromium key and Firefox ID assertions.

- [ ] **Step 2: Run the identity test and verify missing exports**

Run: `npm run test:unit -- tests/extension-identity.test.ts`

Expected: FAIL because the Safari constants are not exported.

- [ ] **Step 3: Centralize Safari identity constants**

Export from `extension/scripts/extension-identity.mjs`:

```js
export const SAFARI_APP_BUNDLE_ID = "app.tabloom.extension";
export const SAFARI_EXTENSION_ID = "app.tabloom.mac.extension";
```

Use `SAFARI_EXTENSION_ID` in `createAuthReport`. Import `SAFARI_APP_BUNDLE_ID` in `build-extension.mjs` and pass it as the `--bundle-identifier` value. Do not alter the checked-in Chromium key or Firefox Gecko ID.

- [ ] **Step 4: Document persistence behavior**

Add a concise `Workspace recovery` subsection to `README.md` stating:

```md
### Workspace recovery

Extension updates and reloads preserve Tabloom's local cache and signed-in session when the browser extension ID is unchanged. After a true uninstall, browser-owned extension storage is removed. Tabloom attempts a non-interactive account recovery and restores the Supabase workspace; if the provider session has expired, the user must reconnect manually. Local-only workspaces should be exported as JSON before uninstalling.
```

- [ ] **Step 5: Run focused identity and manifest tests**

Run: `npm run test:unit -- tests/extension-identity.test.ts tests/browser-manifests.test.ts`

Expected: PASS.

- [ ] **Step 6: Run static analysis and the complete unit suite**

Run: `npm run lint`

Expected: exit 0 with no ESLint errors.

Run: `npx tsc --noEmit`

Expected: exit 0 with no TypeScript errors.

Run: `npm run test:unit`

Expected: all Vitest files pass.

- [ ] **Step 7: Build every extension target**

Run: `npm run build:extension`

Expected: Chromium, Firefox, and Safari builds complete; `dist-extension/reports/*-auth.json` contain the stable target identities and callbacks.

- [ ] **Step 8: Inspect the final diff for secret and storage regressions**

Run:

```bash
git diff --check
git diff -- extension tests README.md
git grep -n -E 'storage\.sync|access_token|refresh_token' -- extension
```

Expected: no whitespace errors; no new token persistence or `storage.sync` use; OAuth callback parsing may reference token-related test strings only where already required.

- [ ] **Step 9: Commit identity checks and documentation**

```bash
git add extension/scripts/build-extension.mjs extension/scripts/extension-identity.mjs \
  tests/extension-identity.test.ts README.md
git commit -m "docs: define extension recovery guarantees"
```

- [ ] **Step 10: Verify repository state without discarding prior work**

Run: `git status --short`

Expected: only the previously existing saved-link/favicon changes remain if they were not separately committed; no generated `dist-extension` output or credentials are staged.
