import { z } from "zod";
import { isSaveableUrl } from "../../../../shared/domain";

const id = z.string().uuid().transform((value) => value.toLowerCase());
const timestamp = z.string().datetime({ offset: true });
const name = z.string().trim().min(1).max(80);
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const title = z.string().trim().min(1).max(300);
const description = z.string().trim().max(1000);
const url = z.string().url().refine(isSaveableUrl, "Only http and https links can be saved.");
const mutation = { idempotencyKey: id };
const expected = { ...mutation, expectedUpdatedAt: timestamp };

export const getWorkspaceSchema = z.strictObject({});
export const listSpacesSchema = getWorkspaceSchema;
export const listCollectionsSchema = z.strictObject({ spaceId: id });
export const listCollectionItemsSchema = z.strictObject({ collectionId: id });
export const searchWorkspaceSchema = z.strictObject({ query: z.string().trim().min(1).max(300) });
export const createSpaceSchema = z.strictObject({ ...mutation, name, color });
export const updateSpaceSchema = z.strictObject({ ...expected, spaceId: id, name: name.optional(), color: color.optional() })
  .refine((value) => value.name !== undefined || value.color !== undefined, "At least one editable field is required.");
export const createCollectionSchema = z.strictObject({ ...mutation, spaceId: id, name });
export const updateCollectionSchema = z.strictObject({ ...expected, collectionId: id, name });
export const createCollectionItemSchema = z.strictObject({ ...mutation, collectionId: id, title, url, description: description.default("") });
export const updateCollectionItemSchema = z.strictObject({ ...expected, itemId: id, title: title.optional(), description: description.optional(), url: url.optional() })
  .refine((value) => value.title !== undefined || value.description !== undefined || value.url !== undefined, "At least one editable field is required.");
export const moveCollectionItemSchema = z.strictObject({ ...expected, itemId: id, destinationCollectionId: id });
export const reorderCollectionItemsSchema = z.strictObject({
  ...mutation, collectionId: id, orderedIds: z.array(id).max(5000), expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).refine((value) => new Set(value.orderedIds).size === value.orderedIds.length, "IDs must be unique.");

// The sync RPC returns saved table rows without browser metadata today. Preserve
// explicit metadata if that boundary is extended; never turn read-only rows writable.
const row = {
  id, user_id: id, position: z.number().int().nonnegative(), created_at: timestamp, updated_at: timestamp,
  origin: z.enum(["saved", "browser-bookmark"]).default("saved"), read_only: z.boolean().default(false),
};
export const workspaceSnapshotSchema = z.object({
  spaces: z.array(z.object({ ...row, name: z.string(), color: z.string() })),
  collections: z.array(z.object({ ...row, space_id: id, name: z.string() })),
  links: z.array(z.object({ ...row, collection_id: id, title: z.string(), description: z.string(), url: z.string(), favicon_url: z.string().nullable(), device_label: z.string().nullable().default(null) })),
});
export const versionedWorkspaceSchema = z.object({ revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), snapshot: workspaceSnapshotSchema });

export function parseCommand<T>(schema: z.ZodType<T>, input: unknown): T {
  return schema.parse(input);
}
