import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { hostnameFor, searchWorkspace, type SavedLink, type WorkspaceSearchResult, type WorkspaceSnapshot } from "../shared/domain";

export type GlobalSearchProps = {
  snapshot: WorkspaceSnapshot;
  onOpen?: (link: SavedLink) => void;
};

function sourceLabel(result: WorkspaceSearchResult): string {
  if (result.link.origin === "browser-bookmark") {
    return `Browser bookmark${result.link.device_label ? ` · ${result.link.device_label}` : ""}`;
  }
  if (result.link.device_label) return `Device only · ${result.link.device_label}`;
  return "Tabloom";
}

function ResultFavicon({ link }: { link: SavedLink }) {
  const [failed, setFailed] = useState(false);
  const fallback = link.title.trim().charAt(0).toUpperCase() || "•";
  return <span className="global-search-favicon">{link.favicon_url && !failed ? (
    // Favicons are browser-provided URLs and do not use the hosted site's image pipeline.
    // eslint-disable-next-line @next/next/no-img-element
    <img alt="" onError={() => setFailed(true)} src={link.favicon_url} />
  ) : fallback}</span>;
}

export function GlobalSearch({ snapshot, onOpen }: GlobalSearchProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => searchWorkspace(snapshot, query), [snapshot, query]);

  function showSearch() {
    setQuery("");
    setActiveIndex(0);
    setOpen(true);
  }

  function closeSearch() {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
  }

  function openResult(result: WorkspaceSearchResult, event?: MouseEvent<HTMLAnchorElement>) {
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
      openResult(results[activeIndex]);
    }
  }

  useEffect(() => {
    function handleShortcut(event: globalThis.KeyboardEvent) {
      if (event.key.toLocaleLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      if (open) closeSearch();
      else showSearch();
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  return <>
    <button aria-label="Search all links" className="global-search-trigger" onClick={showSearch}>
      <Search aria-hidden="true" size={18} />
      <span>Search</span>
      <kbd>⌘ K</kbd>
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
          {!query.trim() && <div className="global-search-state"><Search aria-hidden="true" size={24} /><p>Search links, spaces, collections, and bookmarks</p><small>Type a title, URL, description, space, or collection name</small></div>}
          {query.trim() && !results.length && <div className="global-search-state"><p>No links found</p><small>Try another title, collection, space, or URL</small></div>}
          {results.length > 0 && <div aria-label="Search results" className="global-search-results" role="listbox">
            {results.map((result, index) => <div aria-selected={index === activeIndex} className="global-search-result" key={result.link.id} role="option">
              <a
                aria-label={`${result.link.title}, ${result.space.name}, ${result.collection.name}`}
                href={result.link.url}
                onClick={(event) => openResult(result, event)}
                onMouseEnter={() => setActiveIndex(index)}
                rel="noreferrer"
                target="_blank"
              >
                <ResultFavicon link={result.link} />
                <span className="global-search-copy">
                  <strong>{result.link.title || hostnameFor(result.link.url)}</strong>
                  <span>{result.space.name} › {result.collection.name}</span>
                  <small>{sourceLabel(result)}</small>
                </span>
                <span className="global-search-url">{hostnameFor(result.link.url)}</span>
              </a>
            </div>)}
          </div>}
        </div>
        <footer><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Open</span><span><kbd>esc</kbd> Close</span></footer>
      </div>
    </section>, document.body)}
  </>;
}
