import type { Metadata } from "next";
import { isCollectionShareToken, loadSharedCollection } from "../../lib/shared-collection";
import { SharedCollectionUnavailable, SharedCollectionView } from "./SharedCollectionView";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Shared collection | Tabloom",
  description: "A read-only collection shared with Tabloom.",
  robots: { index: false, follow: false },
};

export default async function SharedCollectionPage({ params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token;
  if (!isCollectionShareToken(token)) return <SharedCollectionUnavailable />;
  let snapshot = null;
  let temporary = false;
  try {
    snapshot = await loadSharedCollection(token);
  } catch {
    temporary = true;
  }

  if (snapshot) return <SharedCollectionView snapshot={snapshot} />;
  return <SharedCollectionUnavailable temporary={temporary} />;
}
