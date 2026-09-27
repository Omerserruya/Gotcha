import 'server-only';

import * as oidc from 'openid-client';

import { serverEnv } from '@/config/env.server';
import { appUrl } from '@/lib/base-path';

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

/**
 * The `redirect_uri` handed to the identity provider, and registered with it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THIS USED TO DROP THE MOUNT POINT SILENTLY
 * ════════════════════════════════════════════════════════════════════════════
 * It was `new URL('/api/auth/callback', APP_ORIGIN)`. An **absolute path
 * discards the base's path** — with or without a trailing slash — so an
 * `APP_ORIGIN` of `https://host/v2` produced `https://host/api/auth/callback`.
 *
 * Beside the legacy product that is not a 404: it is the other application's
 * route, and the provider would be sent a redirect target this app does not
 * own. Either the flow fails on a mismatch, or it succeeds against something
 * else — and the first is much the better outcome.
 *
 * `appUrl` rebuilds the path from `BASE_PATH`, so the result no longer depends
 * on whether whoever set `APP_ORIGIN` happened to include the prefix.
 */
export function redirectUri(): string {
  return appUrl('/api/auth/callback', serverEnv().APP_ORIGIN);
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
