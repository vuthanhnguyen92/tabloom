import type { BrowserTab } from "../../shared/capture";
import type { BookmarkNode } from "../bookmarks-api";
import type { StorageArea } from "../storage";

export type BrowserTarget = "chromium" | "firefox" | "safari";
export type OpenCollectionResult = { opened: number; grouped: boolean };

export type WebExtensionNamespace = {
  tabs: {
    query(queryInfo: { currentWindow: boolean }): Promise<BrowserTab[]>;
    create(createProperties: { url: string; active: boolean }): Promise<{ id?: number }>;
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
  storage: { local: StorageArea & { remove(key: string): Promise<void> } };
  identity?: {
    getRedirectURL(path?: string): string;
    launchWebAuthFlow(details: { url: string; interactive: boolean }): Promise<string | undefined>;
  };
  runtime?: { getURL(path?: string): string };
};

export interface BrowserAdapter {
  readonly target: BrowserTarget;
  readonly capabilities: { bookmarks: boolean; identity: boolean; tabGroups: boolean };
  readonly storage: WebExtensionNamespace["storage"]["local"];
  readonly identity: {
    getRedirectURL(path?: string): string;
    launchWebAuthFlow(details: { url: string; interactive: boolean }): Promise<string | undefined>;
  };
  readonly bookmarks: { getTree(): Promise<BookmarkNode[]> };
  readonly permissions: { request(permission: "bookmarks" | "tabGroups"): Promise<boolean> };
  readonly tabs: {
    listCurrentWindow(): Promise<BrowserTab[]>;
    close(tabIds: number[]): Promise<void>;
    openCollection(name: string, urls: string[]): Promise<OpenCollectionResult>;
  };
}
