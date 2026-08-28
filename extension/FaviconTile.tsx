import { useState } from "react";

export function FaviconTile({ src, title }: { src?: string | null; title?: string | null }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = Boolean(src && src !== failedSrc);

  return (
    <i className="favicon-tile" aria-hidden="true">
      {showImage ? (
        // Favicons are browser-provided URLs and must remain native images in the extension bundle.
        // eslint-disable-next-line @next/next/no-img-element
        <img alt="" draggable={false} src={src!} onError={() => setFailedSrc(src!)} />
      ) : (
        title?.[0]?.toUpperCase() || "?"
      )}
    </i>
  );
}
