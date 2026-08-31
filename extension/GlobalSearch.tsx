import { Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import type { BrowserTab } from "../shared/capture";
import { hostnameFor, searchWorkspace, type SavedLink, type WorkspaceSearchResult, type WorkspaceSnapshot } from "../shared/domain";
import { searchCurrentTabs, type CurrentTabSearchResult } from "./current-tab-search";

export type GlobalSearchProps = {
  snapshot: WorkspaceSnapshot;
  listCurrentTabs: () => Promise<BrowserTab[]>;
  onActivateCurrentTab: (tabId: number) => Promise<void>;
  onError?: (message: string) => void;
  onOpen?: (link: SavedLink) => void;
};

type SavedLinkSearchResult = WorkspaceSearchResult & { kind: "saved-link" };
type CombinedSearchResult = CurrentTabSearchResult | SavedLinkSearchResult;

function sourceLabel(result: WorkspaceSearchResult): string {
  if (result.link.origin === "browser-bookmark") {
    return `Browser bookmark${result.link.device_label ? ` · ${result.link.device_label}` : ""}`;
  }
  if (result.link.device_label) return `Device only · ${result.link.device_label}`;
  return "Tabloom";
}

function ResultFavicon({ faviconUrl, title }: { faviconUrl?: string | null; title: string }) {
  const [failed, setFailed] = useState(false);
  const fallback = title.trim().charAt(0).toUpperCase() || "•";
  return <span className="global-search-favicon">{faviconUrl && !failed ? (
    // Favicons are browser-provided URLs and do not use the hosted site's image pipeline.
    // eslint-disable-next-line @next/next/no-img-element
    <img alt="" onError={() => setFailed(true)} src={faviconUrl} />
  ) : fallback}</span>;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function GlobalSearch({ snapshot, listCurrentTabs, onActivateCurrentTab, onError, onOpen }: GlobalSearchProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [currentTabs, setCurrentTabs] = useState<BrowserTab[]>([]);
  const [currentTabsLoading, setCurrentTabsLoading] = useState(false);
  const [currentTabsError, setCurrentTabsError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const currentTabResults = useMemo(() => searchCurrentTabs(currentTabs, query), [currentTabs, query]);
  const savedLinkResults = useMemo<SavedLinkSearchResult[]>(
    () => searchWorkspace(snapshot, query).map((result) => ({ kind: "saved-link", ...result })),
    [snapshot, query],
  );
  const results = useMemo<CombinedSearchResult[]>(
    () => [...currentTabResults, ...savedLinkResults],
    [currentTabResults, savedLinkResults],
  );

  const loadCurrentTabs = useCallback(async () => {
    setCurrentTabsLoading(true);
    setCurrentTabsError(false);
    try {
      setCurrentTabs(await listCurrentTabs());
    } catch {
      setCurrentTabs([]);
      setCurrentTabsError(true);
    } finally {
      setCurrentTabsLoading(false);
    }
  }, [listCurrentTabs]);

  const showSearch = useCallback(() => {
    setQuery("");
    setActiveIndex(0);
    setOpen(true);
    void loadCurrentTabs();
  }, [loadCurrentTabs]);

  const closeSearch = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
  }, []);

  async function openResult(result: CombinedSearchResult, event?: MouseEvent<HTMLElement>) {
    if (result.kind === "current-tab") {
      try {
        await onActivateCurrentTab(result.tab.id);
        closeSearch();
      } catch (error) {
        onError?.(errorMessage(error, "Tabloom could not switch to that tab."));
      }
      return;
    }

    if (onOpen) {
      event?.preventDefault();
      onOpen(result.link);
    } else if (!event) {
      window.open(result.link.url, "_blank", "noopener,noreferrer");
    }
    closeSearch();
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
      return;
    }
    if (event.key === "ArrowDown" && results.length) {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, results.length - 1));
      return;
    }
    if (event.key === "ArrowUp" && results.length) {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Enter" && results[activeIndex]) {
      event.preventDefault();
      void openResult(results[activeIndex]);
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
    if (open) inputRef.current?.focus();
  }, [open]);

  return <>
    <button aria-label="Search all links" className="global-search-trigger" onClick={showSearch}>
      <Search aria-hidden="true" size={18} />
      <span>Search</span>
      <kbd>⌘ F</kbd>
    </button>
    {open && createPortal(<section aria-label="Search Tabloom" aria-modal="true" className="global-search-overlay" role="dialog">
      <button aria-label="Close search backdrop" className="global-search-backdrop" onClick={closeSearch} />
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
            ref={inputRef}
            spellCheck={false}
            type="search"
            value={query}
          />
          <button aria-label="Close search" onClick={closeSearch}><X size={20} /></button>
        </header>
        <div className="global-search-content">
          {currentTabsLoading && <div className="global-search-tabs-status">Loading current tabs…</div>}
          {currentTabsError && <div className="global-search-tabs-status is-error"><span>Current tabs are unavailable.</span><button onClick={() => void loadCurrentTabs()}>Retry current tabs</button></div>}
          {!query.trim() && <div className="global-search-state"><Search aria-hidden="true" size={24} /><p>Search current tabs, saved links, spaces, collections, and bookmarks</p><small>Type a title, URL, description, space, or collection name</small></div>}
          {query.trim() && !results.length && !currentTabsLoading && <div className="global-search-state"><p>No results found</p><small>Try another title, collection, space, or URL</small></div>}
          {results.length > 0 && <div aria-label="Search results" className="global-search-results" role="listbox">
            {currentTabResults.length > 0 && <section className="global-search-section">
              <h2>Current tabs</h2>
              {currentTabResults.map((result, index) => <div aria-selected={index === activeIndex} className="global-search-result" key={`tab:${result.tab.id}`} role="option">
                <button
                  aria-label={`${result.tab.title || hostnameFor(result.tab.url)}, Current window`}
                  onClick={(event) => void openResult(result, event)}
                  onMouseEnter={() => setActiveIndex(index)}
                  type="button"
                >
                  <ResultFavicon faviconUrl={result.tab.favIconUrl} title={result.tab.title || hostnameFor(result.tab.url)} />
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
                return <div aria-selected={index === activeIndex} className="global-search-result" key={`saved:${result.link.id}`} role="option">
                  <a
                    aria-label={`${result.link.title}, ${result.space.name}, ${result.collection.name}`}
                    href={result.link.url}
                    onClick={(event) => void openResult(result, event)}
                    onMouseEnter={() => setActiveIndex(index)}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <ResultFavicon faviconUrl={result.link.favicon_url} title={result.link.title} />
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
    </section>, document.body)}
  </>;
}
