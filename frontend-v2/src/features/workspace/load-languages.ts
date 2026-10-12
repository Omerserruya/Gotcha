import 'server-only';

import { securityEndpoints } from '@/api/endpoints/registry';
import { serverApi } from '@/api/client/server-api';
import { logger } from '@/observability/logger';
import { z } from 'zod';

/**
 * What screen 11d needs: the languages customers wrote in, and the language
 * GOTCHA itself writes in. A person's own interface language is not here -
 * it is theirs alone, read and saved by the shell (`use-interface-language`,
 * `locale-actions`), never from this screen.
 */

/** `GET /api/account` - bare, not enveloped. */
const accountSchema = z.object({
  tenantDefaultLocale: z.string().nullable().default(null),
});

export interface LanguageData {
  /** The language GOTCHA writes its own output in, for the whole workspace. */
  readonly systemLocale: string | null;
}

export async function loadLanguages(): Promise<LanguageData> {
  const api = serverApi();

  const account = await api
    .get({ endpoint: securityEndpoints.me(), payload: accountSchema, raw: true })
    .catch((cause: unknown) => {
      logger.warn('languages.account_failed', { cause });
      return null;
    });

  return { systemLocale: account?.tenantDefaultLocale ?? null };
}
