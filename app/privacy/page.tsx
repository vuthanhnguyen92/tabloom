import { ArrowLeft, Database, LockKeyhole, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { Brand } from "../components/Brand";

export const metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return <main className="legal-page"><header><Link href="/"><Brand /></Link><Link href="/"><ArrowLeft size={15} /> Back home</Link></header><article><span className="eyebrow">PLAIN-LANGUAGE PRIVACY</span><h1>Privacy at Tabloom</h1><p className="legal-lead">Your saved links are yours. Tabloom uses the minimum browser access needed to capture tabs and does not sell personal data or use it for advertising.</p><section><ShieldCheck /><div><h2>What we store</h2><p>Your Google account identifier, spaces, collections, saved-link titles, URLs, notes, favicon addresses, and ordering. Authentication and database records are handled by Supabase.</p></div></section><section><LockKeyhole /><div><h2>Chrome permissions</h2><p>The extension requests tabs access to read the title, URL, and favicon of tabs you deliberately capture; storage for cached workspace data and sign-in state; and identity for Google OAuth. Unsupported internal browser pages are never saved.</p></div></section><section><Database /><div><h2>Control and retention</h2><p>You can edit or delete saved links and collections at any time. Deleting a collection also deletes its links. The first release does not include analytics, ads, team sharing, or data brokerage.</p></div></section><p className="legal-note">This project ships as a self-hostable v1. Before public commercial operation, the operator should add contact details, jurisdiction-specific disclosures, and a formal account-deletion request channel.</p></article></main>;
}
