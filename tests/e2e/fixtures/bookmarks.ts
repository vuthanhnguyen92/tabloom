export type BookmarkFixtureEntry = {
  title: string;
  url: string;
  folderPath: string[];
};

export const twoDeviceFixture = {
  mac: {
    name: "Work Mac",
    entries: [
      { title: "Chrome docs", url: "https://developer.chrome.com/docs/extensions/", folderPath: ["Work", "Design"] },
      { title: "Linear", url: "https://linear.app/", folderPath: ["Work", "Design"] },
      { title: "Direct reference", url: "https://example.com/unfiled", folderPath: [] },
    ],
  },
  home: {
    name: "Home Mac",
    entries: [
      { title: "Chrome docs", url: "https://developer.chrome.com/docs/extensions/", folderPath: ["Work", "Design"] },
      { title: "Personal reference", url: "https://example.com/personal", folderPath: ["Personal"] },
    ],
  },
} as const;
