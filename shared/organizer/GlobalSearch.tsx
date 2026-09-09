import { Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { hostnameFor, isSaveableUrl, searchWorkspace, type SavedLink, type WorkspaceSearchResult, type WorkspaceSnapshot } from "../domain";
import type { BrowserTabSummary, OrganizerCapabilities } from "./capabilities";
import { ModalBoundary } from "./ModalBoundary";
import { FaviconTile } from "./FaviconTile";
import type { OrganizerFaviconResolver as FaviconResolver } from "./SavedLinkCard";

export type GlobalSearchProps = {
  snapshot: WorkspaceSnapshot;
  capabilities: OrganizerCapabilities;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Extension adapter opts into opening saved links in a new tab. */
  savedLinkNewTab?: boolean;
  onError?: (message: string) => void;
  onOpen?: (link: SavedLink) => void;
  resolveFavicon?: FaviconResolver;
};

type CurrentTabSearchResult = { kind: "current-tab"; tab: BrowserTabSummary & { id: number; url: string } };

type SavedLinkSearchResult = WorkspaceSearchResult & { kind: "saved-link" };
type CombinedSearchResult = CurrentTabSearchResult | SavedLinkSearchResult;

function sourceLabel(result: WorkspaceSearchResult): string {
  if (result.link.origin === "browser-bookmark") {
    return `Browser bookmark${result.link.device_label ? ` · ${result.link.device_label}` : ""}`;
  }
  if (result.link.device_label) return `Device only · ${result.link.device_label}`;
  return "Tabloom";
}

function ResultFavicon({ capturedUrl, pageUrl, resolveFavicon, capabilities, title }: { capturedUrl?: string | null; pageUrl: string; resolveFavicon?: FaviconResolver; capabilities: OrganizerCapabilities; title: string }) {
  const [resolved, setResolved] = useState<{ pageUrl: string; capturedUrl?: string | null; value: string | null } | null>(null);
  useEffect(() => {
    if (resolveFavicon) return;
    let active = true;
    void capabilities.resolveFavicon(pageUrl, capturedUrl).then(
      (value) => { if (active) setResolved({ pageUrl, capturedUrl, value }); },
      () => { if (active) setResolved({ pageUrl, capturedUrl, value: capturedUrl ?? null }); },
    );
    return () => { active = false; };
  }, [capabilities, capturedUrl, pageUrl, resolveFavicon]);
  const src = resolveFavicon ? resolveFavicon({ pageUrl, capturedUrl, size: 32 }) : resolved?.pageUrl === pageUrl && resolved.capturedUrl === capturedUrl ? resolved.value : capturedUrl ?? null;
  return <FaviconTile className="global-search-favicon" src={src} title={title} />;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function GlobalSearch({ snapshot, capabilities, open: controlledOpen, onOpenChange, savedLinkNewTab = false, onError, onOpen, resolveFavicon }: GlobalSearchProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = useCallback((value: boolean) => { setInternalOpen(value); onOpenChange?.(value); }, [onOpenChange]);
  const currentTabsCapability = capabilities.currentTabs;
  const resultId = useId();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [currentTabs, setCurrentTabs] = useState<BrowserTabSummary[]>([]);
  const [currentTabsLoading, setCurrentTabsLoading] = useState(false);
  const [currentTabsError, setCurrentTabsError] = useState(false);
  const tabsRequest = useRef(0);
  const currentTabResults = useMemo<CurrentTabSearchResult[]>(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term || !currentTabsCapability) return [];
    return currentTabs.flatMap((tab) => typeof tab.id === "number" && tab.url && isSaveableUrl(tab.url) && `${tab.title ?? ""} ${tab.url}`.toLocaleLowerCase().includes(term)
      ? [{ kind: "current-tab", tab: { ...tab, id: tab.id, url: tab.url } }] : []);
  }, [currentTabs, currentTabsCapability, query]);
  const savedLinkResults = useMemo<SavedLinkSearchResult[]>(
    () => searchWorkspace(snapshot, query).map((result) => ({ kind: "saved-link", ...result })),
    [snapshot, query],
  );
  const results = useMemo<CombinedSearchResult[]>(
    () => [...currentTabResults, ...savedLinkResults],
    [currentTabResults, savedLinkResults],
  );
  const highlightedIndex = Math.min(activeIndex, results.length - 1);

  const loadCurrentTabs = useCallback(async () => {
    if (!currentTabsCapability) return;
    const request = ++tabsRequest.current;
    setCurrentTabsLoading(true);
    setCurrentTabsError(false);
    setCurrentTabs([]);
    try {
      const tabs = await currentTabsCapability.list();
      if (request === tabsRequest.current) setCurrentTabs(tabs);
    } catch {
      if (request === tabsRequest.current) {
        setCurrentTabs([]);
        setCurrentTabsError(true);
      }
    } finally {
      if (request === tabsRequest.current) setCurrentTabsLoading(false);
    }
  }, [currentTabsCapability]);

  const showSearch = useCallback(() => {
    setQuery("");
    setActiveIndex(0);
    setOpen(true);
  }, [setOpen]);

  const closeSearch = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
  }, [setOpen]);

  async function openResult(result: CombinedSearchResult, event?: MouseEvent<HTMLElement>) {
    if (result.kind === "current-tab") {
      try {
        await currentTabsCapability?.activate(result.tab.id);
        closeSearch();
      } catch (error) {
        onError?.(errorMessage(error, "Tabloom could not switch to that tab."));
      }
      return;
    }

    // Modified anchor clicks retain browser navigation behavior.
    if (event && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
    try {
      if (onOpen) { event?.preventDefault(); onOpen(result.link); }
      else if (!event) await capabilities.openLink({ url: result.link.url, newTab: savedLinkNewTab });
      closeSearch();
    } catch (error) {
      onError?.(errorMessage(error, "Tabloom could not open that link."));
    }
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
      return;
    }
    if (event.key === "ArrowDown" && results.length) {
      event.preventDefault();
      setActiveIndex(Math.min(highlightedIndex + 1, results.length - 1));
      return;
    }
    if (event.key === "ArrowUp" && results.length) {
      event.preventDefault();
      setActiveIndex(Math.max(highlightedIndex - 1, 0));
      return;
    }
    if (event.key === "Enter" && results[highlightedIndex]) {
      event.preventDefault();
      void openResult(results[highlightedIndex]);
    }
  }

  useEffect(() => {
    function handleShortcut(event: globalThis.KeyboardEvent) {
      if (event.key.toLocaleLowerCase() !== "f" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      event.stopPropagation();
      if (open) closeSearch();
      else showSearch();
    }
    window.addEventListener("keydown", handleShortcut, { capture: true });
    return () => window.removeEventListener("keydown", handleShortcut, { capture: true });
  }, [closeSearch, open, showSearch]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    queueMicrotask(() => { if (active) void loadCurrentTabs(); });
    return () => { active = false; tabsRequest.current += 1; };
  }, [loadCurrentTabs, open]);

  return <>
    <button aria-label="Search all links" className="global-search-trigger" onClick={showSearch}>
      <Search aria-hidden="true" size={18} />
      <span>Search</span>
      <kbd>⌘ F</kbd>
    </button>
    {open && <ModalBoundary label="Search Tabloom" className="global-search-overlay" onClose={closeSearch} initialFocus='input[type="search"]'>
      <button aria-label="Close search backdrop" className="global-search-backdrop" tabIndex={-1} onClick={closeSearch} />
      <div className="global-search-shell">
        <header>
          <Search aria-hidden="true" size={26} />
          <input
            aria-label="Search all spaces and collections"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            name="tabloom-global-search"
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search all spaces and collections"
            aria-controls={`${resultId}-results`}
            aria-activedescendant={results.length ? `${resultId}-${highlightedIndex}` : undefined}
            spellCheck={false}
            type="search"
            value={query}
          />
          <button aria-label="Close search" onClick={closeSearch}><X size={20} /></button>
        </header>
        <div className="global-search-content">
          {currentTabsCapability && currentTabsLoading && <div className="global-search-tabs-status">Loading current tabs…</div>}
          {currentTabsCapability && currentTabsError && <div className="global-search-tabs-status is-error"><span>Current tabs are unavailable.</span><button onClick={() => void loadCurrentTabs()}>Retry current tabs</button></div>}
          {!query.trim() && <div className="global-search-state"><Search aria-hidden="true" size={24} /><p>{currentTabsCapability ? "Search current tabs, saved links, spaces, collections, and bookmarks" : "Search saved links, spaces, and collections"}</p><small>Type a title, URL, description, space, or collection name</small></div>}
          {query.trim() && !results.length && !(currentTabsCapability && currentTabsLoading) && <div className="global-search-state"><p>No results found</p><small>Try another title, collection, space, or URL</small></div>}
          {results.length > 0 && <div id={`${resultId}-results`} aria-label="Search results" className="global-search-results" role="listbox">
            {currentTabResults.length > 0 && <section className="global-search-section">
              <h2>Current tabs</h2>
              {currentTabResults.map((result, index) => <div id={`${resultId}-${index}`} aria-selected={index === highlightedIndex} className="global-search-result" key={`tab:${result.tab.id}`} role="option">
                <button
                  aria-label={`${result.tab.title || hostnameFor(result.tab.url)}, Current window`}
                  onClick={(event) => void openResult(result, event)}
                  onMouseEnter={() => setActiveIndex(index)}
                  type="button"
                >
                  <ResultFavicon capabilities={capabilities} capturedUrl={result.tab.favIconUrl} pageUrl={result.tab.url} resolveFavicon={resolveFavicon} title={result.tab.title || hostnameFor(result.tab.url)} />
                  <span className="global-search-copy">
                    <strong>{result.tab.title || hostnameFor(result.tab.url)}</strong>
                    <span>{hostnameFor(result.tab.url)}</span>
                    <small>Current window</small>
                  </span>
                  <span className="global-search-url">{hostnameFor(result.tab.url)}</span>
                </button>
              </div>)}
            </section>}
            {savedLinkResults.length > 0 && <section className="global-search-section">
              <h2>Saved links</h2>
              {savedLinkResults.map((result, savedIndex) => {
                const index = currentTabResults.length + savedIndex;
                return <div id={`${resultId}-${index}`} aria-selected={index === highlightedIndex} className="global-search-result" key={`saved:${result.link.id}`} role="option">
                  <a
                    aria-label={`${result.link.title}, ${result.space.name}, ${result.collection.name}`}
                    href={result.link.url}
                    onClick={(event) => void openResult(result, event)}
                    onMouseEnter={() => setActiveIndex(index)}
                    rel="noreferrer"
                    target={savedLinkNewTab ? "_blank" : undefined}
                  >
                    <ResultFavicon capabilities={capabilities} capturedUrl={result.link.favicon_url} pageUrl={result.link.url} resolveFavicon={resolveFavicon} title={result.link.title} />
                    <span className="global-search-copy">
                      <strong>{result.link.title || hostnameFor(result.link.url)}</strong>
                      <span>{result.space.name} › {result.collection.name}</span>
                      <small>{sourceLabel(result)}</small>
                    </span>
                    <span className="global-search-url">{hostnameFor(result.link.url)}</span>
                  </a>
                </div>;
              })}
            </section>}
          </div>}
        </div>
        <footer><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Open</span><span><kbd>esc</kbd> Close</span></footer>
      </div>
    </ModalBoundary>}
  </>;
}
