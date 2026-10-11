import 'server-only';

import { languageShareSchema, type LanguageShare } from '@/api/contracts/language-share';
import { analyticsEndpoints, securityEndpoints } from '@/api/endpoints/registry';
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
  /** The mix of languages customers actually wrote in. Null if unreadable. */
  readonly share: LanguageShare | null;
  /** The language GOTCHA writes its own output in, for the whole workspace. */
  readonly systemLocale: string | null;
}

export async function loadLanguages(): Promise<LanguageData> {
  const api = serverApi();

  const [share, account] = await Promise.all([
    api
      .get({ endpoint: analyticsEndpoints.languageShare(), payload: languageShareSchema })
      .catch((cause: unknown) => {
        // Null, not an empty mix. "No conversations in any language" is a
        // claim about the business; this is a claim about us.
        logger.warn('languages.share_failed', { cause });
        return null;
      }),
    api
      .get({ endpoint: securityEndpoints.me(), payload: accountSchema, raw: true })
      .catch((cause: unknown) => {
        logger.warn('languages.account_failed', { cause });
        return null;
      }),
  ]);

  return {
    share,
    systemLocale: account?.tenantDefaultLocale ?? null,
  };
}
