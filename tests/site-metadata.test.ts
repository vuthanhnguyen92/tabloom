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

  it("keeps shared collection metadata private and token-free", async () => {
    const { metadata } = await import("../app/s/[token]/page");
    expect(metadata).toMatchObject({
      title: "Shared collection | Tabloom",
      robots: { index: false, follow: false },
    });
    expect(JSON.stringify(metadata)).not.toMatch(/token|collection name/i);
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
