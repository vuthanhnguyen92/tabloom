"use client";
/* eslint-disable @next/next/no-img-element -- remote favicons are untrusted runtime URLs */

import { ExternalLink, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { SharedCollectionSnapshot } from "../../../shared/collection-sharing";
import { hostnameFor } from "../../../shared/domain";
import { Brand } from "../../components/Brand";

const LARGE_COLLECTION_THRESHOLD = 10;

export function SharedCollectionView({ snapshot }: { snapshot: SharedCollectionSnapshot }) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  function openAll() {
    snapshot.links.forEach((link) => window.open(link.url, "_blank", "noopener,noreferrer"));
    setConfirmOpen(false);
  }

  function requestOpenAll() {
    if (snapshot.links.length > LARGE_COLLECTION_THRESHOLD) setConfirmOpen(true);
    else openAll();
  }

  return <main className="shared-collection-page">
    <header><Link href="/"><Brand /></Link><span>Shared collection</span></header>
    <section className="shared-collection-shell">
      <div className="shared-collection-heading">
        <div><span className="eyebrow">LIVE COLLECTION</span><h1>{snapshot.name}</h1><p>{snapshot.links.length} {snapshot.links.length === 1 ? "link" : "links"}</p></div>
        {!!snapshot.links.length && <button className="button button-primary" onClick={requestOpenAll}><ExternalLink size={16} /> Open all</button>}
      </div>
      {snapshot.links.length ? <div className="shared-link-grid">
        {snapshot.links.map((link) => <a className="shared-link-card" href={link.url} key={link.id} rel="noreferrer noopener">
          <i>{link.favicon_url ? <img alt="" src={link.favicon_url} /> : link.title[0]?.toUpperCase()}</i>
          <span><b>{link.title}</b><small>{link.description || hostnameFor(link.url)}</small></span>
          <ExternalLink aria-hidden="true" size={15} />
        </a>)}
      </div> : <div className="shared-collection-empty"><span>✦</span><h2>Nothing saved here yet</h2><p>This live collection will update after its next synced edit.</p></div>}
    </section>
    {confirmOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmOpen(false); }}><section aria-label={`Open ${snapshot.links.length} tabs?`} aria-modal="true" className="dialog" role="dialog"><button aria-label="Close dialog" className="dialog-close" onClick={() => setConfirmOpen(false)}><X size={18} /></button><h2>Open {snapshot.links.length} tabs?</h2><p>Opening a large collection can make your browser feel busy.</p><div className="dialog-actions"><button onClick={() => setConfirmOpen(false)}>Cancel</button><button className="button-primary" onClick={openAll}>Open tabs</button></div></section></div>}
  </main>;
}
