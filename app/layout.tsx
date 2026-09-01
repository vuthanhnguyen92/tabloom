import type { Metadata } from "next";
import { Open_Sans } from "next/font/google";
import "./globals.css";

const openSans = Open_Sans({
  variable: "--font-open-sans",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://tabloom.nickvu.dev";
  const title = "Tabloom — Make room for focused work";
  const description = "Collect open tabs, shape them into calm workspaces, and find your way back to focused work.";
  return {
    metadataBase: new URL(siteUrl),
    title: { default: title, template: "%s · Tabloom" },
    description,
    alternates: { canonical: "/" },
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: { title, description, url: "/", images: [{ url: "/og.png", width: 1200, height: 630, alt: "Tabloom visual workspace" }] },
    twitter: { card: "summary_large_image", title, description, images: ["/og.png"] },
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
