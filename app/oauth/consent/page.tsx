import { OAuthConsent } from "./OAuthConsent";

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ authorization_id?: string }>;
}) {
  const { authorization_id: authorizationId = "" } = await searchParams;
  return <OAuthConsent authorizationId={authorizationId} />;
}
