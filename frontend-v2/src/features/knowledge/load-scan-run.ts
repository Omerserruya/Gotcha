import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { scanStateSchema, type ScanRun } from '@/api/contracts/workspace';
import { workspaceEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * The last website rescan, read with the page (2026-10-14): one still running
 * is picked up and followed, so leaving the page and coming back never loses
 * it. `null` when none ever ran, or the read failed - then the panel waits for
 * a press, as it always did.
 */
export async function loadScanRun(): Promise<ScanRun | null> {
  try {
    const state = await serverApi().get({
      endpoint: workspaceEndpoints.scan(),
      payload: scanStateSchema,
    });
    return state.run;
  } catch (cause) {
    logger.warn('knowledge.scan_run_unread', { cause });
    return null;
  }
}
