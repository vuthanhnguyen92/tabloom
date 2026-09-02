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
});
