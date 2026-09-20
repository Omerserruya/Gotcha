import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { templateListSchema, type Template } from '@/api/contracts/templates';
import { templateEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * The tenant's message templates.
 *
 * `{ data, total, page, limit }` with a genuine count, so `raw` is needed to
 * keep the total beside the rows.
 *
 * `null` is a failed read and never an empty list: on this screen the two mean
 * opposite things, because having no templates is what stops you sending to
 * anyone who has not written first.
 */
export interface TemplatesData {
  readonly templates: readonly Template[] | null;
  readonly total: number;
}

export async function loadTemplates(): Promise<TemplatesData> {
  try {
    const result = await serverApi().get({
      endpoint: templateEndpoints.list(),
      payload: templateListSchema,
      raw: true,
    });
    return { templates: result.data, total: result.total };
  } catch (cause) {
    logger.warn('templates.list_failed', { cause });
    return { templates: null, total: 0 };
  }
}
