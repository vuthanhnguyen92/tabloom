import type { Metadata } from "next";
import type { SharedCollectionSnapshot } from "../../shared/collection-sharing";

const GENERIC_TITLE = "Shared collection | Tabloom";
const GENERIC_DESCRIPTION = "A read-only collection shared with Tabloom.";

export function sharedCollectionDescription(snapshot: SharedCollectionSnapshot): string {
  const count = snapshot.links.length;
  return `${snapshot.name} — ${count} ${count === 1 ? "link" : "links"} shared with Tabloom.`;
}

export function buildSharedCollectionMetadata(
  token: string,
  snapshot: SharedCollectionSnapshot | null,
): Metadata {
  if (!snapshot) {
    return {
      title: { absolute: GENERIC_TITLE },
      description: GENERIC_DESCRIPTION,
      robots: { index: false, follow: false },
    };
  }

  const title = `${snapshot.name} | Tabloom`;
  const description = sharedCollectionDescription(snapshot);
  const url = `/s/${encodeURIComponent(token)}`;

  return {
    title: { absolute: title },
    description,
    alternates: { canonical: url },
    robots: { index: false, follow: false },
    openGraph: { title, description, type: "website", url },
    twitter: { card: "summary", title, description },
  };
}

export function buildSharedCollectionJsonLd(snapshot: SharedCollectionSnapshot) {
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: snapshot.name,
    description: sharedCollectionDescription(snapshot),
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: snapshot.links.length,
      itemListElement: snapshot.links.map((link, index) => ({
        "@type": "ListItem",
        position: index + 1,
        item: {
          "@type": "WebPage",
          name: link.title,
          ...(link.description ? { description: link.description } : {}),
          url: link.url,
        },
      })),
    },
  };
}

export function serializeSharedCollectionJsonLd(snapshot: SharedCollectionSnapshot): string {
  return JSON.stringify(buildSharedCollectionJsonLd(snapshot)).replace(/</g, "\\u003c");
}
