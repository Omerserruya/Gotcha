import 'server-only';

import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { humaniseCode } from '@/api/contracts/capabilities';
import { funnelEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import type { HireFunnel, HireFunnels, HireFunnelTemplate, HireTemplates } from './hire-plan';

/**
 * A `GET /api/funnels` row, only what the hire needs. `TenantFunnel` has no
 * name column (`schema.prisma`): a row is named by its `funnelId` slug made
 * readable, or by a `name` if a later row carries one.
 */
const funnelRowSchema = z.object({
  id: z.string().min(1),
  funnelId: z.string().catch(''),
  name: z.string().nullable().optional().catch(null),
  isActive: z.boolean().catch(false),
});

/** Rows as they come; a malformed one is left out, never the whole list. */
const listOf = <T extends z.ZodType>(row: T) =>
  z.array(z.unknown()).transform((rows) =>
    rows.flatMap((item): z.infer<T>[] => {
      const parsed = row.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
  );
const funnelListSchema = listOf(funnelRowSchema);

/** A ready-made funnel, as `GET /api/funnels/templates` answers it. */
const templateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().catch(''),
  stages: z.array(z.object({ id: z.string(), label: z.string() })).catch([]),
});
const templateListSchema = listOf(templateSchema);

/** The active rows, named. */
export function activeFunnels(rows: z.infer<typeof funnelListSchema>): readonly HireFunnel[] {
  return rows
    .filter((row) => row.isActive)
    .map((row) => ({
      id: row.id,
      name: row.name?.trim() || (row.funnelId ? humaniseCode(row.funnelId) : row.id),
    }));
}

const refusal = (cause: unknown, event: string): 'forbidden' | 'failed' => {
  if (isApiError(cause) && cause.status === 403) return 'forbidden';
  logger.warn(event, { cause });
  return 'failed';
};

/**
 * What a Sales hire may follow (H8c): the workspace's active funnels, and
 * the ready-made ones to start from. Both ADMIN only: a 403 is `forbidden`,
 * any other failure `failed` - each said apart from "none", and each read on
 * its own, so one failing leaves the other.
 */
export async function loadHireFunnels(): Promise<{
  readonly funnels: HireFunnels;
  readonly templates: HireTemplates;
}> {
  const api = serverApi();
  const [funnels, templates] = await Promise.all([
    api
      .get({ endpoint: funnelEndpoints.list(), payload: funnelListSchema })
      .then((rows): HireFunnels => activeFunnels(rows))
      .catch((cause: unknown) => refusal(cause, 'employees.hire_funnels_failed')),
    api
      .get({ endpoint: funnelEndpoints.templates(), payload: templateListSchema })
      .then((rows): readonly HireFunnelTemplate[] => rows)
      .catch((cause: unknown) => refusal(cause, 'employees.hire_templates_failed')),
  ]);
  return { funnels, templates };
}
