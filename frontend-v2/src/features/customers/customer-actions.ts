'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { customerListSchema } from '@/api/contracts/customers';
import { customerEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import { emailProblem, whatsappIdOf } from './add-customer';

export type AddCustomerResult =
  | { readonly ok: true; readonly id: string; readonly existed: boolean }
  | {
      readonly ok: false;
      readonly reason: 'name' | 'phone' | 'email' | 'forbidden' | 'failed';
    };

/**
 * Creates the person - unless they are already here. `POST /api/contacts` is
 * an UPSERT that would overwrite an existing contact's name and email, so a
 * match on the phone is looked up first and opened instead (Omer: never a
 * duplicate, never an overwrite).
 */
export async function addCustomer(input: {
  readonly name: string;
  readonly phone: string;
  readonly email: string;
}): Promise<AddCustomerResult> {
  const name = input.name.trim();
  if (!name) return { ok: false, reason: 'name' };
  const waId = whatsappIdOf(input.phone);
  if (!waId) return { ok: false, reason: 'phone' };
  if (emailProblem(input.email)) return { ok: false, reason: 'email' };
  const api = serverApi();
  try {
    // The national number's last nine digits: matches "+972…", "972…" and "05…" alike.
    const existing = await api.post({
      endpoint: customerEndpoints.list(),
      payload: customerListSchema,
      body: { rules: [{ field: 'phone', operator: 'contains', value: waId.slice(-9) }] },
      raw: true,
    });
    const same = existing.data.find((row) =>
      (row.phone ?? row.externalId).replace(/\D/g, '').endsWith(waId.slice(-9)),
    );
    if (same) return { ok: true, id: same.mergedIntoId ?? same.id, existed: true };

    const created = await api.post({
      endpoint: customerEndpoints.create(),
      payload: z.object({ id: z.string().min(1) }),
      body: {
        externalId: waId,
        channel: 'WHATSAPP',
        displayName: name,
        phone: waId,
        ...(input.email.trim() ? { email: input.email.trim() } : {}),
      },
    });
    revalidatePath('/[locale]/(app)/customers', 'page');
    return { ok: true, id: created.id, existed: false };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('customers.add_failed', { cause });
    if (isApiError(cause) && cause.status === 403) return { ok: false, reason: 'forbidden' };
    return { ok: false, reason: 'failed' };
  }
}
