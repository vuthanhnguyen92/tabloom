import { describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => ({
  Open_Sans: () => ({ variable: "--font-open-sans" }),
}));

describe("site metadata", () => {
  it("uses the canonical Tabloom production origin for links and social previews", async () => {
    const { generateMetadata } = await import("../app/layout");
    const metadata = await generateMetadata();

    expect(String(metadata.metadataBase)).toBe("https://tabloom.nickvu.dev/");
    expect(metadata.alternates?.canonical).toBe("/");
    expect(metadata.openGraph).toMatchObject({
      url: "/",
      images: [{ url: "/og.png" }],
    });
    expect(metadata.twitter).toMatchObject({ images: ["/og.png"] });
  });
});
