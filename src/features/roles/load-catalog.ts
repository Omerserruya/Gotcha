import 'server-only';

import { catalogSchema, type PermissionDef, type Scope } from '@/api/contracts/permission-catalog';
import { permissionEndpoints } from '@/api/endpoints/registry';
import { serverApi } from '@/api/client/server-api';
import { logger } from '@/observability/logger';

/**
 * The permission catalogue — screen 12c.
 *
 * `raw` because the transform reads `permissions` and `scopes` out of the
 * `{ data }` envelope together.
 */
export interface CatalogData {
  readonly permissions: readonly PermissionDef[];
  readonly scopes: readonly Scope[];
}

export async function loadCatalog(): Promise<CatalogData | null> {
  try {
    return await serverApi().get({
      endpoint: permissionEndpoints.catalog(),
      payload: catalogSchema,
      raw: true,
    });
  } catch (cause) {
    logger.warn('catalog.load_failed', { cause });
    return null;
  }
}
