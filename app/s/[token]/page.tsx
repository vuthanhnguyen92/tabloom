import type { Metadata } from "next";
import Link from "next/link";
import { Brand } from "../../components/Brand";
import { loadSharedCollection } from "../../lib/shared-collection";
import { SharedCollectionView } from "./SharedCollectionView";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Shared collection | Tabloom",
  description: "A read-only collection shared with Tabloom.",
  robots: { index: false, follow: false },
};

export default async function SharedCollectionPage({ params }: { params: Promise<{ token: string }> }) {
  let snapshot = null;
  try {
    snapshot = await loadSharedCollection((await params).token);
  } catch {
    snapshot = null;
  }

  if (snapshot) return <SharedCollectionView snapshot={snapshot} />;
  return <main className="shared-collection-page shared-collection-unavailable"><header><Link href="/"><Brand /></Link></header><section><span>✦</span><h1>This shared collection is unavailable</h1><p>The link may have expired, been replaced, or sharing may have been turned off.</p><Link className="button button-primary" href="/">Visit Tabloom</Link></section></main>;
}
