'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { integrationsSchema } from '@/api/contracts/integrations';
import { integrationEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import { credentialsFor } from './connect-form';

export type ConnectResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * `missing` — a required field is empty or a choice is not one offered;
       * `not_here` — this system connects at its provider (OAuth) or not by a
       * form at all; `entitlement` · `forbidden` · `failed`.
       */
      readonly reason: 'missing' | 'not_here' | 'entitlement' | 'forbidden' | 'failed';
    };

/**
 * 10's Connect — live (Omer, 2026-10-04): `POST /api/integrations/:slug/connect`.
 *
 * The form's fields are read again HERE, from the catalogue, rather than
 * taken from the browser: what is sent is what the catalogue asks for and
 * nothing else a request could add.
 */
export async function connectIntegration(
  slug: string,
  values: Readonly<Record<string, string>>,
): Promise<ConnectResult> {
  const api = serverApi();
  try {
    const catalogue = await api.get({
      endpoint: integrationEndpoints.list(),
      payload: integrationsSchema,
    });
    const entry = catalogue.find((e) => e.slug === slug);
    if (!entry) return { ok: false, reason: 'failed' };
    if (entry.authSchema.oauth || entry.authSchema.fields.length === 0) {
      return { ok: false, reason: 'not_here' };
    }
    const credentials = credentialsFor(entry.authSchema.fields, values);
    if (credentials === null) return { ok: false, reason: 'missing' };

    await api.post({
      endpoint: integrationEndpoints.connect(slug),
      payload: z.object({ id: z.string() }),
      body: { credentials },
    });
    revalidatePath('/[locale]/(app)/studio/capabilities', 'page');
    revalidatePath('/[locale]/(app)/settings/systems', 'page');
    return { ok: true };
  } catch (cause) {
    logger.warn('capabilities.connect_failed', { slug, cause });
    if (isApiError(cause)) {
      if (cause.status === 400) return { ok: false, reason: 'missing' };
      if (cause.status === 402) return { ok: false, reason: 'entitlement' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    return { ok: false, reason: 'failed' };
  }
}
