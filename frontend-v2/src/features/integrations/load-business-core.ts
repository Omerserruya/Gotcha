import 'server-only';

import { businessCoreSchema, type BusinessCore } from '@/api/contracts/business-core';
import { integrationEndpoints } from '@/api/endpoints/registry';
import { serverApi } from '@/api/client/server-api';
import { logger } from '@/observability/logger';

/**
 * What screens 14b and 14c read.
 *
 * One call. The route composes the use case, the parts, who can serve each
 * and who currently does - and deliberately connects nothing:
 *
 *   "The election mechanism this builds on is already capability-honest and
 *    already SEPARATE FROM CONNECTING… Connecting stays in the marketplace,
 *    which is the duplication the design wanted removed."
 *
 * ── WHY THE CRM IS NOT RE-DERIVED HERE, AND MUST NOT BE ──
 * The route resolves the elected CRM through its existing resolver rather
 * than recomputing it, "so this screen cannot disagree with the system the
 * bot actually calls".
 *
 * That looks like an inconsistency to whoever refactors it next: four parts
 * read from `config.roles` and one reads from somewhere else, and the obvious
 * tidy-up is to make CRM like the rest. Doing so would create two sources for
 * one decision - this screen could then show one system while the AI called
 * another, which is the shape that cost this project a day on two Shopifys.
 */
export async function loadBusinessCore(): Promise<BusinessCore | null> {
  return serverApi()
    .get({ endpoint: integrationEndpoints.businessCore(), payload: businessCoreSchema })
    .catch((cause: unknown) => {
      // Null, not an empty set of parts. "Your business has no parts" is a
      // statement about the tenant; this is a statement about us.
      logger.warn('businessCore.load_failed', { cause });
      return null;
    });
}
