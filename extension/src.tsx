import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Archive, ExternalLink, LogIn, Search, Sprout, X } from "lucide-react";
import { captureTabs } from "../shared/capture";
import { createDemoSnapshot, filterWorkspace, hostnameFor, type WorkspaceSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository, SupabaseWorkspaceRepository, type WorkspaceRepository } from "../shared/repository";
import { listCurrentWindowTabs, type CaptureTab } from "./chrome-api";
import { ChromeSnapshotCache } from "./storage";
import { extensionSupabase, signInExtensionWithGoogle } from "./supabase";
import "./style.css";

const cache = new ChromeSnapshotCache();

function Mark() { return <span className="ext-brand"><i>✦</i>tabloom</span>; }

function ExtensionApp() {
  const [repository, setRepository] = useState<WorkspaceRepository | null>(null);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [selectedSpace, setSelectedSpace] = useState("");
  const [query, setQuery] = useState("");
  const [tabs, setTabs] = useState<CaptureTab[]>([]);
  const [trayOpen, setTrayOpen] = useState(false);
  const [targetCollection, setTargetCollection] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [signedIn, setSignedIn] = useState(false);

  async function load(repo: WorkspaceRepository) {
    try {
      const next = await repo.load();
      setSnapshot(next); setSelectedSpace((current) => current || next.spaces[0]?.id || "");
      await cache.write(next); setError("");
    } catch {
      const cached = await cache.read();
      if (cached) { setSnapshot(cached); setMessage("Offline · showing your last synced workspace"); }
      else setError("Connect to the internet to load your workspace.");
    }
  }

  useEffect(() => {
    void (async () => {
      if (!extensionSupabase) {
        const repo = new MemoryWorkspaceRepository("demo-user", createDemoSnapshot());
        setRepository(repo); await load(repo); return;
      }
      const { data } = await extensionSupabase.auth.getSession();
      if (data.session) {
        const repo = new SupabaseWorkspaceRepository(extensionSupabase, data.session.user.id);
        setSignedIn(true); setRepository(repo); await load(repo);
      } else {
        const cached = await cache.read(); if (cached) setSnapshot(cached);
      }
    })();
  }, []);

  const visible = useMemo(() => snapshot ? filterWorkspace(snapshot, query) : null, [snapshot, query]);
  const activeSpace = snapshot?.spaces.find((space) => space.id === selectedSpace) ?? snapshot?.spaces[0];
  const collections = visible?.collections.filter((collection) => query || collection.space_id === activeSpace?.id) ?? [];

  async function openTray() {
    const next = await listCurrentWindowTabs();
    setTabs(next); setTargetCollection(collections[0]?.id ?? snapshot?.collections[0]?.id ?? ""); setTrayOpen(true); setMessage("");
  }

  async function save(closeAfterSave: boolean) {
    if (!repository || !targetCollection) return;
    try {
      const selected = tabs.filter((tab) => tab.selected);
      const result = await captureTabs({
        tabs: selected,
        collectionId: targetCollection,
        closeAfterSave,
        save: (items) => repository.createLinks(items.map((item) => ({ collection_id: item.collection_id, url: item.url, title: item.title, description: item.description, favicon_url: item.favicon_url }))),
        close: (ids) => chrome.tabs.remove(ids),
      });
      await load(repository); setTrayOpen(false);
      setMessage(`${result.saved} saved${result.skipped ? ` · ${result.skipped} skipped` : ""}${result.closed ? ` · ${result.closed} closed` : ""}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save these tabs."); }
  }

  async function signIn() {
    try {
      const session = await signInExtensionWithGoogle();
      if (!extensionSupabase) return;
      const repo = new SupabaseWorkspaceRepository(extensionSupabase, session.user.id);
      setSignedIn(true); setRepository(repo); await load(repo);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not sign in."); }
  }

  return <main className="ext-shell">
    <aside className="ext-sidebar"><Mark /><span>MY SPACES</span>{snapshot?.spaces.map((space) => <button key={space.id} className={space.id === activeSpace?.id ? "active" : ""} onClick={() => { setSelectedSpace(space.id); setQuery(""); }}><i style={{ background: space.color }} />{space.name}</button>)}<a href={`${import.meta.env.VITE_TABLOOM_WEB_URL || "http://localhost:4173"}/app`} target="_blank" rel="noreferrer">Manage workspace <ExternalLink size={13} /></a></aside>
    <section className="ext-main"><header><div><small>{signedIn ? "SYNCED WORKSPACE" : "DEMO WORKSPACE"}</small><h1>{activeSpace?.name || "Your workspace"}</h1></div><label><Search size={17} /><input aria-label="Search your links" placeholder="Search your links" value={query} onChange={(event) => setQuery(event.target.value)} /></label><button className="capture" onClick={() => void openTray()}><Archive size={16} /> Capture tabs</button></header>
      {message && <p className="ext-message">{message}</p>}{error && <p className="ext-message error">{error}<button onClick={() => setError("")}><X size={14} /></button></p>}
      {!extensionSupabase && <p className="demo-note">Demo mode · add Supabase settings to synchronize this new-tab page.</p>}
      {extensionSupabase && !signedIn && <div className="ext-signin"><Sprout size={32} /><h2>Your workspace is ready to bloom.</h2><p>Sign in to capture tabs and sync them with Tabloom on the web.</p><button onClick={() => void signIn()}><LogIn size={16} /> Sign in with Google</button></div>}
      {(!extensionSupabase || signedIn) && <div className="ext-columns">{collections.map((collection) => { const links = visible?.links.filter((link) => link.collection_id === collection.id) ?? []; return <article key={collection.id}><div className="ext-col-head"><b>{collection.name}</b><span>{links.length} links</span></div>{links.map((link) => <a href={link.url} key={link.id}><i>{link.title[0]?.toUpperCase()}</i><span><b>{link.title}</b><small>{hostnameFor(link.url)}</small></span></a>)}<button className="open-links" onClick={() => links.forEach((link) => chrome.tabs.create({ url: link.url }))}>Open all</button></article>; })}</div>}
    </section>
    {trayOpen && <section className="capture-tray" role="dialog" aria-modal="true" aria-label="Capture current tabs"><header><div><h2>Capture this window</h2><p>Select the context you want to keep.</p></div><button aria-label="Close capture tray" onClick={() => setTrayOpen(false)}><X /></button></header><div className="tab-list">{tabs.map((tab, index) => <div className={!tab.saveable ? "disabled" : ""} key={tab.id ?? index}><input aria-label={`Capture ${tab.title || "Untitled tab"}`} type="checkbox" disabled={!tab.saveable} checked={tab.selected} onChange={(event) => setTabs((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, selected: event.target.checked } : item))} /><span><b>{tab.title || "Untitled"}</b><small>{tab.saveable ? hostnameFor(tab.url || "") : "This browser page cannot be saved"}</small></span></div>)}</div><div className="destination"><label htmlFor="capture-destination">Save to</label><select id="capture-destination" value={targetCollection} onChange={(event) => setTargetCollection(event.target.value)}>{snapshot?.collections.map((collection) => <option value={collection.id} key={collection.id}>{collection.name}</option>)}</select></div><footer><button onClick={() => void save(false)}>Save selected</button><button className="close-tabs" onClick={() => void save(true)}>Save & close</button></footer></section>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><ExtensionApp /></React.StrictMode>);
