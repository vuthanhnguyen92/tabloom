import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { BrowserTarget } from "./browser";

export type AuthCallbackDetailsProps = {
  callbackUrl: string;
  target: BrowserTarget;
};

function publicCallback(callbackUrl: string) {
  const url = new URL(callbackUrl);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function targetLabel(target: BrowserTarget) {
  if (target === "firefox") return "Firefox";
  if (target === "safari") return "Safari";
  return "Chromium";
}

export function AuthCallbackDetails({ callbackUrl, target }: AuthCallbackDetailsProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const callback = publicCallback(callbackUrl);

  async function copyCallback() {
    await navigator.clipboard.writeText(callback);
    setCopied(true);
  }

  if (!open) {
    return <button className="oauth-callback-toggle" type="button" onClick={() => setOpen(true)}>Show OAuth callback</button>;
  }

  return <section className="oauth-callback-details" aria-label="OAuth callback details">
    <strong>{targetLabel(target)} OAuth callback</strong>
    <code>{callback}</code>
    <button type="button" onClick={() => void copyCallback()}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? "Copied" : "Copy callback"}
    </button>
  </section>;
}
