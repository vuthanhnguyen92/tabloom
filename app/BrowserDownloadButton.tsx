"use client";

import { ChevronDown, Download } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

type DownloadTarget = {
  browser: "Chromium" | "Firefox" | "Safari";
  href: string;
};

const downloads: DownloadTarget[] = [
  { browser: "Chromium", href: "/downloads/tabloom-chromium.zip" },
  { browser: "Firefox", href: "/downloads/tabloom-firefox.zip" },
  { browser: "Safari", href: "/downloads/tabloom-safari.zip" },
];
const subscribeToBrowserIdentity = () => () => undefined;

export function detectBrowserDownload(userAgent: string, platform: string): DownloadTarget | null {
  if (/Android|iPhone|iPad|iPod/i.test(userAgent)) return null;
  if (/Firefox\//i.test(userAgent)) return downloads[1];
  if (/Safari\//i.test(userAgent) && !/Chrome|Chromium|CriOS|Edg|OPR/i.test(userAgent) && /Mac/i.test(platform)) return downloads[2];
  if (/Chrome|Chromium|Edg|OPR|Arc|Dia/i.test(userAgent)) return downloads[0];
  return null;
}

export function BrowserDownloadButton({ className, iconSize = 18 }: { className: string; iconSize?: number }) {
  const target = useSyncExternalStore(
    subscribeToBrowserIdentity,
    () => detectBrowserDownload(navigator.userAgent, navigator.platform),
    () => undefined,
  );
  const [chooserOpen, setChooserOpen] = useState(false);

  if (target === null) {
    return <span className="browser-download-chooser">
      <button aria-expanded={chooserOpen} aria-label="Choose browser download" className={className} onClick={() => setChooserOpen((open) => !open)} type="button">
        Choose browser <ChevronDown aria-hidden="true" size={iconSize} />
      </button>
      {chooserOpen && <span className="browser-download-menu">
        {downloads.map((download) => <a download href={download.href} key={download.browser}>{download.browser} package</a>)}
      </span>}
    </span>;
  }

  const resolved = target ?? downloads[0];
  return <a className={className} download href={resolved.href}>
    {target ? `Download for ${target.browser}` : "Download Tabloom"} <Download aria-hidden="true" size={iconSize} />
  </a>;
}
