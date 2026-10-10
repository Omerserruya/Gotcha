import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { browserApi } from '@/api/client/browser-api';
import { knowledgeEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * 08b after connecting (backend's knowledge integrations): what a connected
 * Drive or Confluence holds, and learning the parts chosen. 02 draws no
 * picker - "A Drive folder · new files learned automatically" - so this is a
 * list in the sheet's own shape, and nothing is learned before a press.
 */
export const FOLDER = 'application/vnd.google-apps.folder';

const integrationSchema = z.object({
  id: z.string().min(1),
  provider: z.string(),
  displayName: z.string().nullable().catch(null).default(null),
  isActive: z.boolean().catch(true).default(true),
});
export type KnowledgeIntegration = z.infer<typeof integrationSchema>;

const fileSchema = z.object({
  id: z.string().min(1),
  name: z.string().catch('-'),
  mimeType: z.string().catch('').default(''),
});
export type DriveFile = z.infer<typeof fileSchema>;

const sourceSchema = z.object({
  key: z.string(),
  kind: z.enum(['folder', 'file']).catch('file'),
  name: z.string(),
  paused: z.boolean().optional(),
  syncState: z.string().optional(),
  fileCount: z.number().optional(),
});
export type DriveSource = z.infer<typeof sourceSchema>;

const spaceSchema = z.object({ key: z.string().min(1), name: z.string() });
export type ConfluenceSpace = z.infer<typeof spaceSchema>;

const quiet =
  (what: string) =>
  (cause: unknown): null => {
    logger.warn(`knowledge.${what}_failed`, {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return null;
  };

export function readIntegrations(kbId: string): Promise<readonly KnowledgeIntegration[] | null> {
  return browserApi
    .get({ endpoint: knowledgeEndpoints.integrations(kbId), payload: z.array(integrationSchema) })
    .catch(quiet('integrations'));
}

export function readDriveFiles(
  intId: string,
  folderId?: string,
): Promise<readonly DriveFile[] | null> {
  return browserApi
    .get({ endpoint: knowledgeEndpoints.driveFiles(intId, folderId), payload: z.array(fileSchema) })
    .catch(quiet('drive_files'));
}

export function readDriveSources(intId: string): Promise<readonly DriveSource[] | null> {
  return browserApi
    .get({ endpoint: knowledgeEndpoints.driveSources(intId), payload: z.array(sourceSchema) })
    .catch(quiet('drive_sources'));
}

export function readSpaces(intId: string): Promise<readonly ConfluenceSpace[] | null> {
  return browserApi
    .get({ endpoint: knowledgeEndpoints.confluenceSpaces(intId), payload: z.array(spaceSchema) })
    .catch(quiet('confluence_spaces'));
}

export type LearnResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'busy' | 'mixed' | 'failed' };

/** Learns the chosen Drive items - all folders, or all files: the route takes one kind a time. */
export async function learnDrive(
  intId: string,
  picked: readonly DriveFile[],
): Promise<LearnResult> {
  if (picked.length === 0) return { ok: false, reason: 'failed' };
  const folders = picked.filter((f) => f.mimeType === FOLDER).length;
  if (folders !== 0 && folders !== picked.length) return { ok: false, reason: 'mixed' };
  try {
    await browserApi.post({
      endpoint: knowledgeEndpoints.driveSync(intId),
      payload: z.unknown(),
      raw: true,
      body: {
        sources: picked.map((f) => ({
          id: f.id,
          kind: f.mimeType === FOLDER ? 'folder' : 'file',
          name: f.name,
          mimeType: f.mimeType,
        })),
      },
    });
    return { ok: true };
  } catch (cause) {
    logger.warn('knowledge.drive_sync_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    if (isApiError(cause) && cause.status === 409) return { ok: false, reason: 'busy' };
    return { ok: false, reason: 'failed' };
  }
}

export type DisconnectSourceResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'forbidden' | 'failed' };

/**
 * Disconnects a Drive or Confluence: `DELETE /api/knowledge/integrations/:id`
 * WITHOUT `removeData` - its sync stops, and what it already taught stays.
 * The router needs ai:knowledge:write (403), as starting the connect does
 * (ai c6c6309a; it was ADMIN only).
 */
export async function disconnectSource(intId: string): Promise<DisconnectSourceResult> {
  try {
    await browserApi.delete({
      endpoint: knowledgeEndpoints.removeIntegration(intId),
      payload: z.unknown(),
      raw: true,
    });
    return { ok: true };
  } catch (cause) {
    logger.warn('knowledge.disconnect_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    if (isApiError(cause) && cause.status === 403) return { ok: false, reason: 'forbidden' };
    return { ok: false, reason: 'failed' };
  }
}

/** Learns the chosen Confluence spaces' pages. */
export async function learnSpaces(intId: string, keys: readonly string[]): Promise<LearnResult> {
  if (keys.length === 0) return { ok: false, reason: 'failed' };
  try {
    await browserApi.post({
      endpoint: knowledgeEndpoints.confluenceSync(intId),
      payload: z.unknown(),
      raw: true,
      body: { spaceKeys: [...keys] },
    });
    return { ok: true };
  } catch (cause) {
    logger.warn('knowledge.confluence_sync_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
}
