# Tabloom Live Collection Sharing Design

## Summary

Tabloom will let a signed-in owner publish one collection through a revocable, read-only URL such as `https://tabloom.nickvu.dev/s/<token>`. Anyone with the exact URL can view the collection without signing in. The page reflects the collection's current saved cards whenever it is opened or refreshed.

Sharing is opt-in and available from both the extension and `/app`. Existing collections remain private. The recipient never receives owner identity, space metadata, device information, sync state, or access to other collections.

## Goals

- Let an owner enable, copy, regenerate, and disable one active share URL per collection.
- Show the current collection name and ordered saved cards to unauthenticated recipients.
- Preserve the existing owner-only RLS policies for spaces, collections, and links.
- Revoke access immediately when sharing is disabled, the token is regenerated, or the collection is deleted.
- Support responsive automatic light/dark theming and an Open all action on the public page.

## Non-goals

- Recipient editing, comments, collaboration, invitations, or email allow-lists.
- Public discovery, search indexing, profiles, analytics, or access counts.
- Multiple active links, passwords, expiration dates, or frozen snapshots.
- Realtime subscriptions or polling while a recipient keeps the page open.
- Sharing browser-bookmark collections or collections that exist only in local storage.

## Data Model and Database Contract

Add `public.collection_shares` with:

- `id uuid primary key default gen_random_uuid()`
- `user_id uuid not null`
- `collection_id uuid not null`
- `token text not null unique`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`
- a unique constraint on `(collection_id, user_id)`
- a composite foreign key from `(collection_id, user_id)` to `collections(id, user_id)` with `on delete cascade`
- a token format constraint for a 32-byte base64url value without padding

Enable RLS on `collection_shares`. Authenticated owners may read their own share record; anonymous users receive no direct table privileges. Mutations go through narrowly scoped functions so ownership validation and token generation are consistent.

Authenticated RPCs:

- `enable_collection_share(target_collection_id uuid)` verifies `auth.uid()` owns the collection, returns the existing share if present, otherwise generates and stores a cryptographically random token.
- `regenerate_collection_share(target_collection_id uuid)` verifies ownership, replaces the token, updates `updated_at`, and returns the replacement share.
- `disable_collection_share(target_collection_id uuid)` verifies ownership and deletes the share record. Repeating the operation is safe.

Anonymous RPC:

- `load_shared_collection(share_token text)` validates the token shape before lookup and returns either `null` or a JSON snapshot containing only `name` and ordered `links`.
- Each returned link contains `id`, `title`, `description`, `url`, `favicon_url`, and `position`.
- The function runs with a fixed `search_path`, reads only the matched collection and its saved links, and is the only anonymous path around owner RLS.
- Invalid, malformed, regenerated, disabled, and deleted shares all return the same unavailable result.

Function execution is revoked from default roles and granted explicitly: owner-management functions to `authenticated`, public loading to `anon` and `authenticated`. No service-role credential is added to the web app or extension.

## Shared Application Interfaces

Add shared types:

```ts
type CollectionShare = {
  collectionId: string;
  token: string;
  createdAt: string;
  updatedAt: string;
};

type SharedCollectionSnapshot = {
  name: string;
  links: Array<Pick<SavedLink,
    "id" | "title" | "description" | "url" | "favicon_url" | "position"
  >>;
};
```

Add a `CollectionShareRepository` interface with `get`, `enable`, `regenerate`, and `disable`. The authenticated Supabase implementation is shared by the extension and `/app`. Public snapshot loading is server-only and uses the anonymous Supabase client.

Share URLs are derived from the canonical site origin and token; they are not stored separately. This keeps domain changes out of database rows.

## Owner Experience

Editable saved collections gain a Share icon in their header in both the extension and `/app`. Browser-bookmark and read-only collections do not expose it.

- For a local-only user, Share opens the existing sign-in flow and explains that live sharing requires synchronization.
- For a signed-in owner whose collection is not yet present remotely or has failed synchronization, Share reports that synchronization must complete and exposes the existing Retry path.
- For an unshared collection, the dialog offers Enable sharing. On success it shows the URL and Copy link.
- For a shared collection, the dialog shows Copy link, Regenerate link, and Disable sharing.
- Regenerate requires confirmation and warns that the previous URL will stop working.
- Disable requires confirmation and warns that the public page will become unavailable.
- Copy and successful mutations use the existing three-second mini toast. Failed requests remain in the dialog with a retryable error and never display success feedback.

Enabling a share does not alter collection contents or workspace revision. Collection and link mutations continue through the existing local-first synchronization flow; the public loader reads the resulting canonical rows.

## Recipient Experience

Add a server-rendered route at `/s/[token]` with Tabloom branding and automatic light/dark styling. It shows only:

- collection name
- saved-link count
- ordered cards with favicon, title, and description-or-hostname subtitle
- an Open all action

Individual cards use normal browser link behavior. Open all creates tabs in the current browser window and uses the existing unusually-large-collection warning. It does not request extension permissions or create a browser tab group.

Empty collections show a read-only empty state. Invalid or revoked URLs show a generic “This shared collection is unavailable” state with no collection or owner details.

The page loads a fresh snapshot on navigation or manual refresh. It does not poll or subscribe to Supabase Realtime, so content does not move while a recipient is reading.

## Privacy and Web Security

- Set page metadata and response headers to `noindex, nofollow`; omit shared routes from the sitemap.
- Set `Cache-Control: private, no-store` so edits and revocations are not served from a shared cache.
- Set `Referrer-Policy: no-referrer` and use `rel="noreferrer noopener"` for external links so the bearer token is not sent to destination websites.
- Never include the token in logs, analytics events, error messages, page titles, or Open Graph metadata.
- Render no owner name, email, avatar, space name, device label, sync state, or identifiers beyond card IDs needed by the view.
- Treat possession of the URL as authorization. Token entropy prevents practical enumeration; regeneration and disabling are the recovery controls after accidental disclosure.

Update the privacy page to state that a collection becomes publicly accessible only after its owner explicitly enables a share URL, and remains accessible to anyone possessing that URL until revoked.

## Failure Behavior

- Offline or unauthenticated owners cannot create, rotate, or disable shares; the current share state is not guessed locally.
- A failed owner mutation keeps the dialog open, preserves the previous working link, and offers Retry.
- Public database or network failures render a generic temporarily unavailable state without leaking whether a token exists.
- Deleting a collection cascades to its share record. No separate cleanup job is required.
- Concurrent Enable requests converge on the single `(collection_id, user_id)` row and return the same active share.
- Concurrent regeneration uses the last committed token; all older URLs become unavailable.

## Testing

Database tests with two owners and the anonymous role will prove:

- owners cannot inspect or mutate another owner's shares
- anonymous users cannot query workspace or share tables directly
- only a correctly shaped active token loads one collection's approved fields
- card ordering and description fallback inputs are preserved
- malformed, unknown, regenerated, disabled, and cascade-deleted tokens are indistinguishable
- enabling is idempotent and one active share per collection is enforced

Application tests will cover owner modal states, sign-in routing, synchronization-required errors, copy feedback, confirmation flows, failure retries, and hiding Share for bookmark/read-only collections.

Public page tests will cover populated and empty collections, unavailable and transient-error states, responsive light/dark rendering, normal card navigation, the large Open all warning, metadata, cache/referrer headers, and absence of private fields.

End-to-end acceptance will verify that an owner enables sharing in the extension, opens the URL signed out, edits/reorders/adds/deletes cards, refreshes the public page to see the current state, regenerates the URL to invalidate the old one, and disables sharing to invalidate the replacement. Production web and Chromium, Firefox, and Safari extension builds must pass.

## Rollout

1. Apply the additive Supabase migration and database tests. All existing collections remain private.
2. Deploy the public route, repository support, `/app` controls, security headers, and privacy disclosure.
3. Publish rebuilt Chromium, Firefox, and Safari packages with extension sharing controls.
4. Run the production acceptance flow before advertising sharing.

If the database migration is unavailable, owner surfaces hide no existing functionality: Share reports that the feature is temporarily unavailable, and all workspace operations continue normally.

## Saving an independent copy

Visitors can save a shared collection as a private, editable copy in their own account. Changes to the original, including revocation and deletion, do not update or remove that copy. See the [save implementation plan](../plans/2026-09-09-save-shared-collection.md) and [behavior, acceptance setup, and rollout notes](../../shared-collection-saving.md).
