import 'server-only';

import { z } from 'zod';

import { serverApi } from '@/api/client/server-api';
import type { CommerceSummary, Mood } from '@/api/contracts/customer-facts';
import { customerEndpoints, inboxEndpoints } from '@/api/endpoints/registry';
import { loadCommerce, loadInsights } from '@/features/customers/load-customer-facts';
import { logger } from '@/observability/logger';

/**
 * The Copilot wall's reads about the PERSON (02 Inbox, Omer 2026-10-06):
 * worth and mood, what GOTCHA remembers, and every conversation they have
 * had. Each read fails on its own — a failed read is "—" in its own block,
 * never a zero and never the whole wall.
 */
export interface WallPerson {
  /** `undefined`: no store to read (a reason); `null`: the read failed. */
  readonly commerce: CommerceSummary | 'no_store' | null;
  readonly mood: Mood | null;
  /** What GOTCHA learned — exactly what the AI is given; `null` when unread. */
  readonly memory: WallMemory | null;
  readonly history: WallHistory | null;
}

/** Where a fact came from, said quietly beside it. `null`: a source we do not name. */
export type FactSource = 'conversation' | 'person' | 'crm' | 'worked_out';

export interface WallFact {
  /** The field key, e.g. `business_type` — drawn as a readable label. */
  readonly key: string;
  readonly value: string;
  readonly source: FactSource | null;
}

export interface WallMemory {
  /** "Known — do NOT re-ask", in the prompt's words. */
  readonly facts: readonly WallFact[];
  /** From a history import: background, not confirmed. */
  readonly historical: {
    readonly summary: string | null;
    readonly facts: readonly string[];
  } | null;
}

const SOURCES: Readonly<Record<string, FactSource>> = {
  llm_live: 'conversation',
  llm_close: 'conversation',
  manual: 'person',
  crm_inbound: 'crm',
  rule: 'worked_out',
  derived: 'worked_out',
};

/* Strict on the envelope: an older service answering 404/HTML is "unread", not "knows nothing". */
const memorySchema = z.object({
  data: z.object({
    facts: z.array(
      z.object({
        key: z.string().catch(''),
        value: z.unknown().transform((v) => (v == null ? '' : String(v))),
        source: z.string().nullable().catch(null).default(null),
      }),
    ),
    historical: z
      .object({
        summary: z.string().nullable().catch(null).default(null),
        facts: z.array(z.string()).catch([]).default([]),
      })
      .nullable(),
  }),
});

export interface WallConversation {
  readonly id: string;
  readonly channel: string;
  readonly status: string | null;
  readonly startedAt: string | null;
  readonly lastAt: string | null;
  readonly messages: number;
  /** One line, stored. `null` is "No summary yet" — not an empty one. */
  readonly summary: string | null;
  /** The conversation open beside the wall. */
  readonly isCurrent: boolean;
}

export interface WallHistory {
  /** Every conversation THIS VIEWER may see (a department-restricted agent sees fewer). */
  readonly total: number;
  readonly hasMore: boolean;
  readonly conversations: readonly WallConversation[];
}

/** How many the wall lists; `total` says how many more there are. */
export const HISTORY_LIMIT = 20;

/*
 * Backend ed8f3e1f. STRICT on the envelope: until it is deployed the path
 * answers 404 or HTML, and that must read as "couldn't read the history" —
 * never as a person with no conversations.
 */
const historySchema = z.object({
  data: z.array(
    z.object({
      conversationId: z.string().min(1),
      channel: z.string().catch('OTHER'),
      status: z.string().nullable().catch(null).default(null),
      startedAt: z.string().nullable().catch(null).default(null),
      lastMessageAt: z.string().nullable().catch(null).default(null),
      messageCount: z.number().int().nonnegative().catch(0).default(0),
      summary: z.string().nullable().catch(null).default(null),
      isCurrent: z.boolean().catch(false).default(false),
    }),
  ),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

export async function loadWallPerson(
  contactId: string | null,
  conversationId: string,
): Promise<WallPerson> {
  const api = serverApi();
  /*
   * ⚠ `contactId` IS NULL UNTIL BACKEND SENDS IT on the conversation row
   *   (asked 2026-10-06). The only (channel, handle) → contact route, `POST
   *   /identity/resolve`, CREATES one on a miss — a write on a read, never
   *   made from here. Until then the contact-keyed reads are not made and
   *   each block says "—" with why. Memory is keyed on the conversation: read now.
   */
  const [commerce, insights, memory, history] = await Promise.all([
    contactId ? loadCommerce([contactId]) : Promise.resolve(null),
    contactId ? loadInsights([contactId]) : Promise.resolve(null),
    api
      .get({
        endpoint: inboxEndpoints.customerMemory(conversationId),
        payload: memorySchema,
        // The whole envelope, so its absence fails the parse.
        raw: true,
      })
      .then(({ data }): WallMemory => ({
        facts: data.facts
          .filter((f) => f.key.trim() && f.value.trim())
          .map((f) => ({
            key: f.key,
            value: f.value.trim(),
            source: (f.source ? SOURCES[f.source] : undefined) ?? null,
          })),
        historical:
          data.historical && (data.historical.summary?.trim() || data.historical.facts.length > 0)
            ? {
                summary: data.historical.summary?.trim() || null,
                facts: data.historical.facts.filter((f) => f.trim()),
              }
            : null,
      }))
      .catch((cause: unknown) => {
        logger.warn('inbox.wall_memory_failed', { cause });
        return null;
      }),
    !contactId
      ? Promise.resolve(null)
      : api
          .get({
            endpoint: customerEndpoints.conversations(contactId),
            query: { limit: HISTORY_LIMIT, current: conversationId },
            payload: historySchema,
            // `data` beside `total` and `hasMore`.
            raw: true,
          })
          .then((r): WallHistory => ({
            total: Math.max(r.total, r.data.length),
            hasMore: r.hasMore,
            conversations: r.data.map((c) => ({
              id: c.conversationId,
              channel: c.channel,
              status: c.status,
              startedAt: c.startedAt,
              lastAt: c.lastMessageAt,
              messages: c.messageCount,
              summary: c.summary?.trim() || null,
              isCurrent: c.isCurrent,
            })),
          }))
          .catch((cause: unknown) => {
            logger.warn('inbox.wall_history_failed', { cause });
            return null;
          }),
  ]);
  return {
    commerce:
      commerce === null || !contactId
        ? null
        : commerce.state === 'none'
          ? 'no_store'
          : (commerce.byId.get(contactId) ?? null),
    mood: contactId ? (insights?.get(contactId)?.mood ?? null) : null,
    memory,
    history,
  };
}
