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
import { workspaceEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * Everything screen 11 shows.
 *
 * Three independent reads. One failing must not blank the others: the facts,
 * the voice and the prohibited claims are separate concerns that happen to
 * share a page, and an owner who can still fix their opening hours is better
 * served than one shown a single error for all three.
 *
 * Null means the call failed. It is never conflated with empty — a workspace
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
