import { useState } from "react";

const failedFaviconSources = new Set<string>();

function failureKey(src: string): string {
  try {
    const source = new URL(src);
    const pageUrl = source.searchParams.get("pageUrl");
    const hostname = new URL(pageUrl ?? src).hostname;
    return hostname || src;
  } catch {
    return src;
  }
}

export function FaviconTile({ className = "favicon-tile", src, title }: { className?: string; src?: string | null; title?: string | null }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const sourceFailureKey = src ? failureKey(src) : null;
  const showImage = Boolean(src && src !== failedSrc && sourceFailureKey && !failedFaviconSources.has(sourceFailureKey));
  const fallback = title?.trim().charAt(0).toUpperCase() || "?";

  return (
    <i className={className} aria-hidden="true">
      <span className="favicon-tile-fallback">{fallback}</span>
      {showImage && (
        // Favicons are browser-provided URLs and must remain native images in the extension bundle.
        // eslint-disable-next-line @next/next/no-img-element
        <img alt="" draggable={false} src={src!} onError={() => {
          failedFaviconSources.add(sourceFailureKey!);
          setFailedSrc(src!);
        }} />
      )}
    </i>
  );
}
