import type { Metadata } from "next";
import { cache } from "react";
import { isCollectionShareToken, loadSharedCollection } from "../../lib/shared-collection";
import { buildSharedCollectionMetadata } from "../../lib/shared-collection-metadata";
import { SharedCollectionUnavailable, SharedCollectionView } from "./SharedCollectionView";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const resolveSharedCollection = cache(async (token: string) => {
  if (!isCollectionShareToken(token)) return { snapshot: null, temporary: false };
  try {
    return { snapshot: await loadSharedCollection(token), temporary: false };
  } catch {
    return { snapshot: null, temporary: true };
  }
});

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const token = (await params).token;
  const { snapshot } = await resolveSharedCollection(token);
  return buildSharedCollectionMetadata(token, snapshot);
}

export default async function SharedCollectionPage({ params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token;
  const { snapshot, temporary } = await resolveSharedCollection(token);

  if (snapshot) return <SharedCollectionView snapshot={snapshot} />;
  return <SharedCollectionUnavailable temporary={temporary} />;
}
