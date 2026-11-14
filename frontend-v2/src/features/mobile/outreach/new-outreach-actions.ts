'use server';

import { getTranslations } from 'next-intl/server';

import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { newestConversationId, timelineSchema } from '@/api/contracts/customer-detail';
import { personLabel } from '@/api/contracts/customers';
import { customerEndpoints } from '@/api/endpoints/registry';
import { loadCustomers } from '@/features/customers/load-customers';
import { logger } from '@/observability/logger';

import { callableNumber, PICK_SHOWN, pickQuery } from './mobile-outreach';

/**
 * The reads behind the phone's "New outreach" sheet - READS ONLY. Nothing
 * here sends or dials: a message is written in the conversation's own
 * composer, and a call is placed by `startCall` after its own confirmation.
 */

/** One person the picker lists: what to call them, and how to reach them by phone. */
export interface PickPerson {
  readonly id: string;
  readonly name: string;
  /** E.164, as the line dials it; `null` when we hold no number. */
  readonly phone: string | null;
  readonly channel: string;
}

export type FindPeopleResult =
  { readonly ok: true; readonly people: readonly PickPerson[] } | { readonly ok: false };

/**
 * The customers' own search (`loadCustomers`: the field the query is shaped
 * like), without the anonymous website visitors - nobody a message or a call
 * from the phone could reach.
 */
export async function findPeople(raw: string): Promise<FindPeopleResult> {
  const query = pickQuery(raw);
  if (query === '') return { ok: true, people: [] };
  const [{ rows }, t] = await Promise.all([
    loadCustomers(query, { identified: true }),
    getTranslations('customers'),
  ]);
  if (rows === null) return { ok: false };
  return {
    ok: true,
    people: rows.slice(0, PICK_SHOWN).map((row) => {
      const label = personLabel(row);
      return {
        id: row.id,
        name:
          label && 'name' in label
            ? label.name
            : label
              ? t(`list.generic.${label.generic}` as 'list.generic.other')
              : t('list.unnamed'),
        phone: callableNumber(row),
        channel: row.channel,
      };
    }),
  };
}

export type NewestConversationResult =
  { readonly ok: true; readonly conversationId: string | null } | { readonly ok: false };

/**
 * The person's newest conversation, as their profile's Message tile finds
 * it (the timeline's newest event). `null` is a fact - they have none yet -
 * and a failed read is not: the two are never one answer.
 */
export async function newestConversationOf(contactId: string): Promise<NewestConversationResult> {
  try {
    const timeline = await serverApi().get({
      endpoint: customerEndpoints.timeline(contactId),
      payload: timelineSchema,
    });
    return { ok: true, conversationId: newestConversationId(timeline.events) };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('mobile.outreach_conversation_failed', { cause });
    return { ok: false };
  }
}
