"use client";

import { ExternalLink, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { SharedCollectionSnapshot } from "../../../shared/collection-sharing";
import { hostnameFor } from "../../../shared/domain";
import { FaviconTile } from "../../../shared/organizer/FaviconTile";
import { Brand } from "../../components/Brand";
import { serializeSharedCollectionJsonLd } from "../../lib/shared-collection-metadata";

import { SaveSharedCollectionButton, sharedSaveExplanation } from "./SaveSharedCollectionButton";

const LARGE_COLLECTION_THRESHOLD = 10;

export function SharedCollectionView({ snapshot, token }: { snapshot: SharedCollectionSnapshot; token: string }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [blockedCount, setBlockedCount] = useState(0);

  function openAll() {
    let blocked = 0;
    snapshot.links.forEach((link) => {
      if (!window.open(link.url, "_blank", "noopener,noreferrer")) blocked += 1;
    });
    setBlockedCount(blocked);
    setConfirmOpen(false);
  }

  function requestOpenAll() {
    if (snapshot.links.length > LARGE_COLLECTION_THRESHOLD) setConfirmOpen(true);
    else openAll();
  }

  return <main className="shared-collection-page">
    <script dangerouslySetInnerHTML={{ __html: serializeSharedCollectionJsonLd(snapshot) }} type="application/ld+json" />
    <header><Link className="shared-collection-brand" href="/"><Brand /></Link></header>
    <section aria-labelledby="shared-collection-title" className="shared-collection-shell">
      <div className="shared-collection-heading">
        <div><span className="eyebrow">LIVE COLLECTION</span><h1 className="shared-collection-title" id="shared-collection-title">{snapshot.name}</h1><p>{snapshot.links.length} {snapshot.links.length === 1 ? "link" : "links"}</p></div>
        <div className="shared-collection-action-block"><div className="shared-collection-actions"><SaveSharedCollectionButton key={token} token={token} showExplanation={false} />{!!snapshot.links.length && <button className="button shared-open-all-button" onClick={requestOpenAll}><ExternalLink size={16} /> Open all</button>}</div><p className="shared-save-explanation">{sharedSaveExplanation}</p></div>
      </div>
      {snapshot.links.length ? <ol aria-label={snapshot.name} className="shared-link-grid">
        {snapshot.links.map((link) => <li key={link.id}><a className="shared-link-card" href={link.url} rel="noreferrer noopener">
          <FaviconTile src={link.favicon_url} title={link.title} />
          <span><b>{link.title}</b><small>{link.description || hostnameFor(link.url)}</small></span>
          <ExternalLink aria-hidden="true" size={15} />
        </a></li>)}
      </ol> : <div className="shared-collection-empty"><span>✦</span><h2>Nothing saved here yet</h2><p>This live collection will update after its next synced edit.</p></div>}
      {blockedCount > 0 && <p className="shared-open-warning" role="status">Your browser blocked {blockedCount} {blockedCount === 1 ? "tab" : "tabs"}. Allow popups for Tabloom and try again.</p>}
    </section>
    {confirmOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmOpen(false); }}><section aria-label={`Open ${snapshot.links.length} tabs?`} aria-modal="true" className="dialog" role="dialog"><button aria-label="Close dialog" className="dialog-close" onClick={() => setConfirmOpen(false)}><X size={18} /></button><h2>Open {snapshot.links.length} tabs?</h2><p>Opening a large collection can make your browser feel busy.</p><div className="dialog-actions"><button onClick={() => setConfirmOpen(false)}>Cancel</button><button className="button-primary" onClick={openAll}>Open tabs</button></div></section></div>}
  </main>;
}

export function SharedCollectionUnavailable({ temporary = false }: { temporary?: boolean }) {
  return <main className="shared-collection-page shared-collection-unavailable"><header><Link href="/"><Brand /></Link></header><section><span>✦</span><h1>{temporary ? "This shared collection is temporarily unavailable" : "This shared collection is unavailable"}</h1><p>{temporary ? "Tabloom could not load this collection right now. Please try again shortly." : "The link may have expired, been replaced, or sharing may have been turned off."}</p><Link className="button button-primary" href="/">Visit Tabloom</Link></section></main>;
}
