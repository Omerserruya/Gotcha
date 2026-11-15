import 'server-only';

import { serverApi } from '@/api/client/server-api';
import {
  platformSenderSchema,
  platformTemplateListSchema,
  type PlatformSender,
  type PlatformTemplate,
} from '@/api/contracts/platform-whatsapp';
import { platformWhatsAppEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * `/system/whatsapp`: GOTCHA's alerts number. `undefined` when the read
 * failed - never a made-up "not connected": an operator told "nothing is
 * connected" would connect a second number over a working one.
 */
export async function loadPlatformSender(): Promise<PlatformSender | undefined> {
  try {
    return await serverApi().get({
      endpoint: platformWhatsAppEndpoints.status(),
      payload: platformSenderSchema,
    });
  } catch (cause) {
    logger.warn('console.platform_whatsapp_status_failed', { cause });
    return undefined;
  }
}

/** Every alert's template, both languages. `undefined` when the read failed. */
export async function loadPlatformTemplates(): Promise<readonly PlatformTemplate[] | undefined> {
  try {
    return await serverApi().get({
      endpoint: platformWhatsAppEndpoints.templates(),
      payload: platformTemplateListSchema,
    });
  } catch (cause) {
    logger.warn('console.platform_whatsapp_templates_failed', { cause });
    return undefined;
  }
}
