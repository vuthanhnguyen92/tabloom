import { describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => ({
  Open_Sans: () => ({ variable: "--font-open-sans" }),
}));

describe("site metadata", () => {
  it("uses the canonical Tabloom production origin for links and social previews", async () => {
    const { generateMetadata } = await import("../app/layout");
    const metadata = await generateMetadata();

    expect(String(metadata.metadataBase)).toBe("https://tabloom.nickvu.dev/");
    expect(metadata.title).toMatchObject({
      default: "Tabloom — Make every new tab your workspace",
    });
    expect(metadata.description).toBe(
      "Turn every new tab into an organized browser workspace. Save locally, shape links into spaces and collections, and sync when you choose.",
    );
    expect(metadata.alternates?.canonical).toBe("/");
    expect(metadata.openGraph).toMatchObject({
      url: "/",
      images: [{ url: "/og-workspace.png" }],
    });
    expect(metadata.twitter).toMatchObject({ images: ["/og-workspace.png"] });
  });

  it("describes a valid shared collection without making it discoverable", async () => {
    const { buildSharedCollectionMetadata } = await import("../app/lib/shared-collection-metadata");
    const token = "a".repeat(43);
    const metadata = buildSharedCollectionMetadata(token, {
      name: "Launch plan",
      links: [
        { id: "one", title: "Roadmap", description: "Release plan", url: "https://linear.app/roadmap", favicon_url: null, position: 0 },
        { id: "two", title: "Reference", description: "", url: "https://example.com/reference", favicon_url: null, position: 1 },
      ],
    });

    expect(metadata).toMatchObject({
      title: { absolute: "Launch plan | Tabloom" },
      description: "Launch plan — 2 links shared with Tabloom.",
      alternates: { canonical: `/s/${token}` },
      robots: { index: false, follow: false },
      openGraph: {
        title: "Launch plan | Tabloom",
        description: "Launch plan — 2 links shared with Tabloom.",
        url: `/s/${token}`,
      },
      twitter: {
        title: "Launch plan | Tabloom",
        description: "Launch plan — 2 links shared with Tabloom.",
      },
    });
    expect(JSON.stringify(metadata)).not.toMatch(/owner|user|account|space|device/i);
  });

  it("uses generic metadata when a shared collection is unavailable", async () => {
    const { buildSharedCollectionMetadata } = await import("../app/lib/shared-collection-metadata");
    const metadata = buildSharedCollectionMetadata("a".repeat(43), null);

    expect(metadata).toMatchObject({
      title: { absolute: "Shared collection | Tabloom" },
      description: "A read-only collection shared with Tabloom.",
      robots: { index: false, follow: false },
    });
    expect(metadata.alternates).toBeUndefined();
    expect(metadata.openGraph).toBeUndefined();
  });

  it("adds no-store, no-referrer, and noindex headers only to shared routes", async () => {
    const { default: config } = await import("../next.config");
    expect(config.headers).toBeTypeOf("function");
    await expect(config.headers!()).resolves.toEqual(expect.arrayContaining([{
      source: "/s/:path*",
      headers: expect.arrayContaining([
        { key: "Cache-Control", value: "private, no-store" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
      ]),
    }]));
  });
});
