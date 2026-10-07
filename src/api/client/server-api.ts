import 'server-only';

import { cookies } from 'next/headers';

import { activeSession } from '@/auth/session-store';
import { serverEnv } from '@/config/env.server';
import { logger } from '@/observability/logger';
import { TENANT_HEADER } from '@/tenant/tenant-header';

import { HttpClient } from './http-client';
import { markSessionRejected } from './session-rejected';

/**
 * The API client for Server Components, server actions and route handlers.
 *
 * It talks to the platform directly - no proxy hop - and reads the bearer
 * token straight from the session cookie. Because it runs on the server, CORS
 * does not apply and the token never travels to the browser.
 */
export function serverApi(): HttpClient {
  const env = serverEnv();
  return new HttpClient({
    baseUrl: env.API_BASE_URL,
    defaultTimeoutMs: env.API_TIMEOUT_MS,
    fetchOptions: { cache: 'no-store' },
    /*
     * The platform's own session cookie if this app can see it, otherwise this
     * app's session. Same precedence as the BFF - the two must agree, or a
     * Server Component and a browser fetch would authenticate as different
     * principals on the same page.
     */
    async prepareHeaders(): Promise<Record<string, string>> {
      if (env.PLATFORM_SESSION_COOKIE) {
        const platform = (await cookies()).get(env.PLATFORM_SESSION_COOKIE);
        if (platform) {
          return { cookie: `${platform.name}=${platform.value}` };
        }
      }

      const session = await activeSession();
      if (!session) return {};
      return {
        authorization: `Bearer ${session.at}`,
        ...(session.tid ? { [TENANT_HEADER]: session.tid } : {}),
      };
    },
    // A streamed section asks after its reads: it cannot redirect from a loader.
    onUnauthenticated() {
      markSessionRejected();
    },
    onError(error) {
      const level = error.kind === 'server' || error.kind === 'contract' ? 'error' : 'warn';
      logger[level]('api.request_failed', error.toDiagnostics());
    },
  });
}
