import type { BrowserTab } from "../../shared/capture";
import type { BookmarkNode } from "../bookmarks-api";
import type { StorageArea } from "../storage";

export type BrowserTarget = "chromium" | "firefox" | "safari";
export type OpenCollectionResult = { opened: number; grouped: boolean };
export type ActivateExistingTabResult = { tabloomClosed: boolean; cleanupError?: string };
export type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>;
export type ResolveFaviconInput = { pageUrl?: string | null; capturedUrl?: string | null; size?: number };
export type FaviconResolver = (input: ResolveFaviconInput) => string | null;

export type SafariNativeAuthRequest = {
  type: "tabloom.oauth.start";
  authorizationUrl: string;
  callbackScheme: "tabloom";
};

export type SafariNativeAuthResponse =
  | { type: "tabloom.oauth.result"; callbackUrl: string }
  | { type: "tabloom.oauth.cancelled" }
  | { type: "tabloom.oauth.error"; code: string; message: string };

export type WebExtensionNamespace = {
  tabs: {
    query(queryInfo: { currentWindow: boolean; active?: boolean }): Promise<BrowserTab[]>;
    create(createProperties: { url: string; active: boolean }): Promise<{ id?: number }>;
    update(tabId: number, updateProperties: { active: boolean }): Promise<BrowserTab>;
    remove(tabIds: number | number[]): Promise<void>;
    group?: (options: { tabIds: number[] }) => Promise<number>;
    ungroup?: (tabIds: number[]) => Promise<void>;
    onUpdated?: {
      addListener(listener: (tabId: number, changeInfo: { url?: string }) => void): void;
      removeListener(listener: (tabId: number, changeInfo: { url?: string }) => void): void;
    };
    onRemoved?: {
      addListener(listener: (tabId: number) => void): void;
      removeListener(listener: (tabId: number) => void): void;
    };
  };
  tabGroups?: { update(groupId: number, updateProperties: { title: string; collapsed: boolean }): Promise<unknown> };
  permissions: { request(permission: { permissions: string[] }): Promise<boolean> };
  bookmarks?: { getTree(): Promise<BookmarkNode[]> };
  storage: {
    local: StorageArea & { remove(key: string): Promise<void> };
    onChanged?: {
      addListener(listener: (changes: StorageChanges, areaName: string) => void): void;
      removeListener(listener: (changes: StorageChanges, areaName: string) => void): void;
    };
  };
  identity?: {
    getRedirectURL(path?: string): string;
    launchWebAuthFlow(details: { url: string; interactive: boolean }): Promise<string | undefined>;
  };
  runtime?: {
    getURL(path?: string): string;
    sendNativeMessage?(
      applicationId: string,
      message: SafariNativeAuthRequest,
    ): Promise<SafariNativeAuthResponse>;
  };
};

export interface BrowserAdapter {
  readonly target: BrowserTarget;
  readonly capabilities: { bookmarks: boolean; identity: boolean; tabGroups: boolean };
  readonly storage: WebExtensionNamespace["storage"]["local"];
  readonly storageChanges: {
    subscribe(listener: (changedKeys: string[]) => void): () => void;
  };
  readonly identity: {
    getRedirectURL(path?: string): string;
    launchWebAuthFlow(details: { url: string; interactive: boolean }): Promise<string | undefined>;
  };
  readonly bookmarks: { getTree(): Promise<BookmarkNode[]> };
  readonly favicons: { resolve: FaviconResolver };
  readonly permissions: { request(permission: "bookmarks" | "tabGroups"): Promise<boolean> };
  readonly tabs: {
    listCurrentWindow(): Promise<BrowserTab[]>;
    activateExisting(tabId: number): Promise<ActivateExistingTabResult>;
    close(tabIds: number[]): Promise<void>;
    openCollection(name: string, urls: string[]): Promise<OpenCollectionResult>;
  };
}
