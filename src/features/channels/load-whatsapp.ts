import 'server-only';

import { importListSchema, type ImportStatus } from '@/api/contracts/historical-import';
import {
  candidateEvidenceSchema,
  candidateListSchema,
  importedThreadSchema,
  type Candidate,
  type CandidateEvidence,
  type ImportedThread,
} from '@/api/contracts/knowledge-candidates';
import {
  exclusionListSchema,
  numberEventListSchema,
  numbersResponseSchema,
  type Exclusion,
  type NumberEvent,
  type NumbersResponse,
} from '@/api/contracts/whatsapp-numbers';
import { channelsConfigSchema, type EmbeddedSignupLaunch } from '@/api/contracts/whatsapp-connect';
import { channelEndpoints, knowledgeEndpoints } from '@/api/endpoints/registry';
import { serverApi } from '@/api/client/server-api';
import { logger } from '@/observability/logger';

/**
 * WhatsApp numbers - screen 13.
 *
 * One read, and the failure is NOT degraded into an empty list. An empty list
 * on this screen means "you have no WhatsApp numbers", which is a statement
 * about the workspace; a failed read is a statement about us. Conflating them
 * would tell somebody whose numbers are working that they have none.
 */
/** 13c's launch parameters per choice (backend 294adc0c); each `null` when unread. */
export interface SignupLaunches {
  readonly coexistence: EmbeddedSignupLaunch | null;
  readonly newNumber: EmbeddedSignupLaunch | null;
}

export interface ChannelsConfig {
  readonly launches: SignupLaunches;
  /** Provider → its credentials exist; `null` when unread (then every Connect stays live). */
  readonly providers: Readonly<Record<string, boolean>> | null;
}

/**
 * One read of `/api/channels/config`: both of 13c's launches - up front,
 * since FB.login must run inside the click - and which OAuth providers are
 * set up at all.
 */
export async function loadChannelsConfig(): Promise<ChannelsConfig> {
  const config = await serverApi()
    .get({ endpoint: channelEndpoints.config(), payload: channelsConfigSchema })
    .catch((cause: unknown) => {
      logger.warn('channels.config_failed', { cause });
      return null;
    });
  return {
    launches: {
      coexistence: config?.embeddedSignupByMode?.coexistence ?? null,
      newNumber: config?.embeddedSignupByMode?.new_number ?? null,
    },
    providers: config?.providers ?? null,
  };
}

export async function loadWhatsAppNumbers(): Promise<NumbersResponse | null> {
  return serverApi()
    .get({
      endpoint: channelEndpoints.whatsappNumbers(),
      payload: numbersResponseSchema,
      // `{ data, unprofiled }` - the second array has no envelope of its own,
      // so the response is needed whole.
      raw: true,
    })
    .catch((cause: unknown) => {
      logger.warn('whatsapp.numbers_failed', { cause });
      return null;
    });
}

/**
 * Screens 13e and 13f - the history import, and the suggestions it produced.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ "NO IMPORT" AND "UNAVAILABLE" ARE DIFFERENT FACTS
 * ════════════════════════════════════════════════════════════════════════════
 * `stage: 'unavailable'` comes from a real row whose status is `NOT_AVAILABLE`
 * - **an import exists and the platform reported it cannot be done.** An empty
 * `imports: []` is nobody ever starting one.
 *
 * So `status` is `null` for "there is no import", and 13e (`ImportPanel`) is not
 * rendered at all in that case. Synthesising an `unavailable` status would put
 * *"we can't import your history"* on the screen of a workspace that never
 * asked - a confident refusal invented out of an empty list.
 *
 * ── AND THE CANDIDATES BELONG TO AN IMPORT, NOT TO THE TENANT ──
 * `knowledge-clustering.stage.ts` queries `where: { importId, tenantId }`, so
 * there is no tenant-wide read of suggestions. Without an import there is
 * nothing to review, and 13f is absent for the same reason as 13e rather than
 * for a reason of its own.
 */
export interface HistoryImportData {
  /** The newest import, or `null` - there is none, or the read failed. */
  readonly status: ImportStatus | null;
  /** Its suggestions. `null` when unread; `[]` when the import produced none. */
  readonly candidates: readonly Candidate[] | null;
  /**
   * The server's bulk-approve floor, `undefined` when it did not say.
   *
   * Never defaulted: a number invented here is a claim about what pressing
   * "approve all" would take, and the route sends this precisely so the client
   * does not guess. See `bulkWouldTake`.
   */
  readonly bulkMinConfidence: number | undefined;
}

/** `importId`: 13e/13f's `?import=`; the newest when absent or unknown. */
export async function loadHistoryImport(importId?: string): Promise<HistoryImportData> {
  const api = serverApi();

  const imports = await api
    .get({ endpoint: knowledgeEndpoints.imports(), payload: importListSchema })
    .then((page) => page.imports)
    .catch((cause: unknown) => {
      logger.warn('whatsapp.imports_failed', { cause });
      return null;
    });

  /*
   * Newest first per the route, so the first row is the current import. `null`
   * covers both a failed read and an empty list - and the difference does not
   * change what the screen can say, because neither gives it an import to
   * report on.
   */
  const status = imports?.find((i) => i.id === importId) ?? imports?.[0] ?? null;
  if (status === null) return { status: null, candidates: null, bulkMinConfidence: undefined };

  const page = await api
    .get({ endpoint: knowledgeEndpoints.candidates(status.id), payload: candidateListSchema })
    .catch((cause: unknown) => {
      logger.warn('whatsapp.candidates_failed', { cause });
      return null;
    });

  return {
    status,
    candidates: page?.candidates ?? null,
    bulkMinConfidence: page?.bulkApproveMinConfidence,
  };
}

/** 13f's "See the chats": the exchanges behind one suggestion. `null`: unread. */
export async function loadEvidence(
  candidateId: string,
): Promise<readonly CandidateEvidence[] | null> {
  return serverApi()
    .get({ endpoint: knowledgeEndpoints.evidence(candidateId), payload: candidateEvidenceSchema })
    .then((page) => page.evidence)
    .catch((cause: unknown) => {
      logger.warn('whatsapp.evidence_failed', { cause });
      return null;
    });
}

/** One imported chat, opened from "See the chats". `null`: unread or gone. */
export async function loadImportedThread(conversationId: string): Promise<ImportedThread | null> {
  return serverApi()
    .get({
      endpoint: knowledgeEndpoints.importedThread(conversationId),
      payload: importedThreadSchema,
    })
    .catch((cause: unknown) => {
      logger.warn('whatsapp.imported_thread_failed', { cause });
      return null;
    });
}

/** 13b's Private contacts. `null`: unread. */
export async function loadExclusions(): Promise<readonly Exclusion[] | null> {
  try {
    const read = await serverApi().get({
      endpoint: channelEndpoints.whatsappExclusions(),
      payload: exclusionListSchema,
      raw: true,
    });
    return read.data;
  } catch (cause) {
    logger.warn('whatsapp.exclusions_failed', { cause });
    return null;
  }
}

/**
 * 13b's Activity: each number's events, newest first across them. Numbers
 * GOTCHA has no record of yet (dev's unprofiled one) have none to read.
 * `null`: unread.
 */
export async function loadNumberEvents(
  numbers: readonly { readonly id: string; readonly phoneNumber: string | null }[],
): Promise<readonly (NumberEvent & { readonly number: string | null })[] | null> {
  try {
    const each = await Promise.all(
      numbers.map((n) =>
        serverApi()
          .get({
            endpoint: channelEndpoints.whatsappEvents(n.id),
            payload: numberEventListSchema,
            raw: true,
          })
          .then((read) => read.data.map((event) => ({ ...event, number: n.phoneNumber }))),
      ),
    );
    return each.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (cause) {
    logger.warn('whatsapp.events_failed', { cause });
    return null;
  }
}
