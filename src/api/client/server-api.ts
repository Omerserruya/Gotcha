import 'server-only';

import { cookies } from 'next/headers';
import { getLocale } from 'next-intl/server';

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
      /*
       * ★ THE INTERFACE LANGUAGE, ON EVERY CALL. Routes that answer in words
       *   (analytics topics, the assistant) choose the language by `?locale=`
       *   or Accept-Language, and a server-to-server call carried neither -
       *   /he/analytics read its topic names in English (Backend 3343c75f).
       *   Unknown here (outside a request): no header, never a guess.
       */
      const language = await interfaceLanguage();
      const lang: Record<string, string> = language ? { 'accept-language': language } : {};
      if (env.PLATFORM_SESSION_COOKIE) {
        const platform = (await cookies()).get(env.PLATFORM_SESSION_COOKIE);
        if (platform) {
          return { cookie: `${platform.name}=${platform.value}`, ...lang };
        }
      }

      const session = await activeSession();
      if (!session) return lang;
      return {
        authorization: `Bearer ${session.at}`,
        ...(session.tid ? { [TENANT_HEADER]: session.tid } : {}),
        ...lang,
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

/** The interface locale of this request, or `null` where there is none to read. */
async function interfaceLanguage(): Promise<string | null> {
  try {
    return (await getLocale()) || null;
  } catch {
    return null;
  }
}
