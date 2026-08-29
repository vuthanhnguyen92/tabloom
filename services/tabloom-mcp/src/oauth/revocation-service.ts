import { verifyRevocableAccessToken } from "../auth/access-token";
import type { FacadeAuthConfig } from "../auth/config";
import type { OAuthPersistence } from "./persistence";
import {
  openRefreshToken,
  REFRESH_TOKEN_LIFETIME_SECONDS,
} from "./token-service";

export async function revokeOAuthToken(
  token: string,
  config: FacadeAuthConfig,
  persistence: OAuthPersistence,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  let accessGrantId: string | undefined;
  try {
    const access = await verifyRevocableAccessToken(token, config, now);
    accessGrantId = access.payload.grant_id;
  } catch {
    // Token validity is intentionally non-disclosing at this endpoint.
  }

  if (accessGrantId !== undefined) {
    const persistenceNow = Math.max(now, Math.floor(Date.now() / 1000));
    await persistence.revokeGrant(
      accessGrantId,
      new Date((persistenceNow + REFRESH_TOKEN_LIFETIME_SECONDS) * 1000),
    );
    return;
  }

  let refresh;
  try {
    refresh = await openRefreshToken(token, config, now);
  } catch {
    return;
  }

  const persistenceNow = Math.max(now, Math.floor(Date.now() / 1000));
  const expiresAt = new Date((persistenceNow + REFRESH_TOKEN_LIFETIME_SECONDS) * 1000);
  await persistence.revokeGrant(refresh.grantId, expiresAt);
  await persistence.consume("refresh_token", refresh.jti, expiresAt);
}
