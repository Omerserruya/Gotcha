import 'server-only';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { crmContextSchema, type CrmContext } from '@/api/contracts/customer-detail';
import { noteListSchema, type Note } from '@/api/contracts/customer-notes';
import {
  commerceContextSchema,
  type CommerceContextResponse,
} from '@/api/contracts/customer-orders';
import { conversationRowSchema, type ConversationRow } from '@/api/contracts/inbox';
import { customerEndpoints, inboxEndpoints } from '@/api/endpoints/registry';
import { loadWallPerson, type WallPerson } from '@/features/inbox/wall/load-wall';
import { logger } from '@/observability/logger';

/**
 * Everything the phone's customer screen shows (`/m/inbox/<id>/customer`):
 * what the desktop's Copilot wall knows about the person, read the wall's
 * own way, plus the notes and the CRM's notes - read only, and no new route.
 *
 * ★ EACH READ FAILS ON ITS OWN. `null` is "could not read" for that section
 *   and nothing else; a section that read and found nothing is an empty list.
 *
 * ★ NO AI CALL. The desktop's customer page also asks for an AI brief
 *   (`POST /api/customer-summary`), which runs a model; this screen does not.
 */
export interface CustomerInfo {
  readonly conversation: ConversationRow;
  /** The wall's person: memory, history, orders by contact. */
  readonly person: WallPerson;
  /**
   * The open conversation's own commerce context - read only when the
   * contact's orders were not (no contact, or that read failed), the wall's
   * own fallback (`ordersView`).
   */
  readonly conversationOrders: CommerceContextResponse | null;
  /** `null`: no contact to read for, or the read failed - see `contactId`. */
  readonly notes: readonly Note[] | null;
  readonly crm: CrmContext | null;
}

export type CustomerInfoRead =
  | { readonly ok: true; readonly info: CustomerInfo }
  | { readonly ok: false; readonly missing: 'unavailable' | 'failed' };

export async function loadCustomerInfo(conversationId: string): Promise<CustomerInfoRead> {
  const api = serverApi();
  let conversation: ConversationRow;
  try {
    conversation = await api.get({
      endpoint: inboxEndpoints.conversation(conversationId),
      payload: conversationRowSchema,
    });
  } catch (cause) {
    if (isApiError(cause) && (cause.status === 404 || cause.status === 403)) {
      return { ok: false, missing: 'unavailable' };
    }
    logger.warn('mobile.customer_info.conversation_failed', { cause });
    return { ok: false, missing: 'failed' };
  }

  const contactId = conversation.contactId;
  const [person, notes, crm] = await Promise.all([
    loadWallPerson(contactId, conversation.id),
    contactId === null
      ? Promise.resolve(null)
      : api
          .get({ endpoint: customerEndpoints.notes(contactId), payload: noteListSchema })
          .then((page) => page.notes)
          .catch((cause: unknown) => {
            logger.warn('mobile.customer_info.notes_failed', { cause });
            return null;
          }),
    api
      .get({ endpoint: customerEndpoints.crmContext(conversation.id), payload: crmContextSchema })
      .catch((cause: unknown) => {
        logger.warn('mobile.customer_info.crm_failed', { cause });
        return null;
      }),
  ]);

  // The wall's fallback, and only when it is needed: never two answers about money.
  const conversationOrders =
    person.orders !== null
      ? null
      : await api
          .get({
            endpoint: customerEndpoints.orders(conversation.id),
            payload: commerceContextSchema,
            raw: true,
          })
          .catch((cause: unknown) => {
            logger.warn('mobile.customer_info.orders_failed', { cause });
            return null;
          });

  return { ok: true, info: { conversation, person, conversationOrders, notes, crm } };
}
