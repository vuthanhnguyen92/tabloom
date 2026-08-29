import { OAuthConsent } from "./OAuthConsent";

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ authorization_id?: string }>;
}) {
  const { authorization_id: authorizationId = "" } = await searchParams;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  const supabaseConfig = url && anonKey ? { url, anonKey } : undefined;

  return (
    <OAuthConsent
      authorizationId={authorizationId}
      supabaseConfig={supabaseConfig}
    />
  );
}
