import 'server-only';

import * as oidc from 'openid-client';

import { serverEnv } from '@/config/env.server';

/**
 * The OIDC relying-party setup.
 *
 * GOTCHA's platform API implements no authentication of its own - Authentik
 * issues the token, the API verifies it against Authentik's JWKS. The platform
 * documents a server-side login flow of its own at `/api/auth/login` and
 * `/api/auth/callback`, but those routes are not currently reachable through
 * the gateway (see the API gap notes in `docs/`). This app therefore acts as
 * the relying party itself, runs Authorization Code + PKCE server-side, and
 * keeps the resulting tokens out of the browser entirely.
 *
 * Switching to the platform's own session flow later means replacing this
 * module and the three route handlers under `app/api/auth`; nothing above the
 * `getSession()` boundary changes.
 */

let configPromise: Promise<oidc.Configuration> | undefined;

export function oidcConfiguration(): Promise<oidc.Configuration> {
  configPromise ??= (async () => {
    const env = serverEnv();
    return oidc.discovery(
      new URL(env.OIDC_ISSUER),
      env.OIDC_CLIENT_ID,
      env.OIDC_CLIENT_SECRET ? { client_secret: env.OIDC_CLIENT_SECRET } : undefined,
      // A public client authenticates purely by PKCE; a confidential one posts
      // its secret. Which we are is a deployment decision, not a code one.
      env.OIDC_CLIENT_SECRET ? oidc.ClientSecretPost(env.OIDC_CLIENT_SECRET) : oidc.None(),
    );
  })();
  return configPromise;
}

export function redirectUri(): string {
  return new URL('/api/auth/callback', serverEnv().APP_ORIGIN).toString();
}

export {
  buildAuthorizationUrl,
  buildEndSessionUrl,
  authorizationCodeGrant,
  refreshTokenGrant,
  randomPKCECodeVerifier,
  randomState,
  calculatePKCECodeChallenge,
} from 'openid-client';
