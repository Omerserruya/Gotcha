import 'server-only';

import { serverApi } from '@/api/client/server-api';
import {
  prohibitedClaimsSchema,
  workspaceSchema,
  workspaceVoiceSchema,
  type ProhibitedClaims,
  type Workspace,
  type WorkspaceVoice,
} from '@/api/contracts/workspace';
import { z } from 'zod';

import { knowledgeIngestSchema } from '@/api/contracts/setup';
import { setupEndpoints, workspaceEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * Everything screen 11 shows.
 *
 * Three independent reads. One failing must not blank the others: the facts,
 * the voice and the prohibited claims are separate concerns that happen to
 * share a page, and an owner who can still fix their opening hours is better
 * served than one shown a single error for all three.
 *
 * Null means the call failed. It is never conflated with empty - a workspace
 * with no prohibited claims and one whose claims would not load look the same
 * on screen otherwise, and only one of them is safe to leave alone.
 */
export interface WorkspaceData {
  readonly workspace: Workspace | null;
  readonly voice: WorkspaceVoice | null;
  readonly claims: ProhibitedClaims | null;
}

export async function loadWorkspace(): Promise<WorkspaceData> {
  const api = serverApi();

  const degrade =
    <T>(event: string, value: T) =>
    (cause: unknown): T => {
      logger.warn(event, { cause });
      return value;
    };

  const [workspace, voice, claims] = await Promise.all([
    api
      .get({ endpoint: workspaceEndpoints.read(), payload: workspaceSchema })
      .catch(degrade('workspace.read_failed', null)),
    api
      .get({ endpoint: workspaceEndpoints.voice(), payload: workspaceVoiceSchema })
      .catch(degrade('workspace.voice_failed', null)),
    api
      .get({ endpoint: workspaceEndpoints.prohibitedClaims(), payload: prohibitedClaimsSchema })
      .catch(degrade('workspace.claims_failed', null)),
  ]);

  return { workspace, voice, claims };
}

/** 11b's website line: what the scan read, and what else it found. */
export interface WebsiteScan {
  readonly pagesRead: number;
  /** Whole days since it finished, counted on the server; `null` while it runs. */
  readonly daysAgo: number | null;
  /** The categories it found answers in - "products, shipping". */
  readonly topics: readonly string[];
  /** "Shopify store", "Instagram", "WhatsApp" - the platform and the channels found. */
  readonly alsoFound: readonly { readonly kind: 'store' | 'channel'; readonly name: string }[];
}

const discoverySchema = z.object({
  data: z
    .object({
      discovery: z
        .object({
          technology: z
            .object({
              platform: z
                .object({ name: z.string().min(1) })
                .nullable()
                .catch(null)
                .default(null),
            })
            .catch({ platform: null })
            .default({ platform: null }),
          communication: z
            .object({ channels: z.array(z.object({ type: z.string().min(1) })).catch([]) })
            .catch({ channels: [] })
            .default({ channels: [] }),
        })
        .nullable()
        .catch(null),
    })
    .catch({ discovery: null }),
});

const CHANNEL_NAMES: Readonly<Record<string, string>> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  facebook: 'Facebook',
  messenger: 'Messenger',
  email: 'Email',
  phone: 'Phone',
  tiktok: 'TikTok',
};

/** `null` when neither read answered - the line is then not drawn at all. */
export async function loadWebsiteScan(): Promise<WebsiteScan | null> {
  const api = serverApi();
  const [ingest, found] = await Promise.all([
    api
      .get({ endpoint: setupEndpoints.knowledgeIngest(), payload: knowledgeIngestSchema })
      .catch((cause: unknown) => {
        logger.warn('workspace.ingest_failed', { cause });
        return undefined;
      }),
    api
      .get({ endpoint: setupEndpoints.discovery(), payload: discoverySchema, raw: true })
      .then((r) => r.data.discovery)
      .catch((cause: unknown) => {
        logger.warn('workspace.discovery_failed', { cause });
        return undefined;
      }),
  ]);
  if (ingest === undefined && found === undefined) return null;
  const seen = new Set<string>();
  const channels = (found?.communication.channels ?? [])
    .map((c) => c.type.toLowerCase())
    .filter((type) => (seen.has(type) ? false : (seen.add(type), true)))
    .map((type) => ({
      kind: 'channel' as const,
      name: CHANNEL_NAMES[type] ?? type.charAt(0).toUpperCase() + type.slice(1),
    }));
  const platform = found?.technology.platform?.name;
  return {
    pagesRead: ingest?.pagesRead ?? 0,
    daysAgo: ingest?.finishedAt
      ? Math.max(0, Math.round((Date.now() - new Date(ingest.finishedAt).getTime()) / 86_400_000))
      : null,
    topics: [
      ...new Set(
        (ingest?.pendingTopics ?? [])
          .map((p) => p.category?.trim().toLowerCase())
          .filter((c): c is string => !!c),
      ),
    ].slice(0, 3),
    alsoFound: [...(platform ? [{ kind: 'store' as const, name: platform }] : []), ...channels],
  };
}
