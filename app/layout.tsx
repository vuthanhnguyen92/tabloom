import type { Metadata } from "next";
import { Open_Sans } from "next/font/google";
import "./globals.css";

const openSans = Open_Sans({
  variable: "--font-open-sans",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://tabloom.nickvu.dev";
  const title = "Tabloom — Make every new tab your workspace";
  const description = "Turn every new tab into an organized browser workspace. Save locally, shape links into spaces and collections, and sync when you choose.";
  return {
    metadataBase: new URL(siteUrl),
    title: { default: title, template: "%s · Tabloom" },
    description,
    alternates: { canonical: "/" },
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: { title, description, url: "/", images: [{ url: "/og-workspace.png", width: 1200, height: 630, alt: "Tabloom browser workspace" }] },
    twitter: { card: "summary_large_image", title, description, images: ["/og-workspace.png"] },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${openSans.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
