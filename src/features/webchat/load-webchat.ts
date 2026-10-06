import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { isApiError } from '@/api/client/api-error';
import { webchatSettingsSchema, type WebchatConfig } from '@/api/contracts/webchat';
import { currentUserSchema } from '@/api/contracts/identity';
import { authEndpoints, channelEndpoints } from '@/api/endpoints/registry';
import { loadChannels } from '@/features/channels/load-channels';
import { loadEmployees } from '@/features/employees/load-employees';
import { responsibilityOf } from '@/api/contracts/employees';
import { logger } from '@/observability/logger';

export interface WebchatRead {
  /** `null` with `missing`: no such widget here; without it, the read failed. */
  readonly config: WebchatConfig | null;
  readonly missing: boolean;
  /** The channel row: the snippet's widget id, and Not live yet (PENDING) / Live. */
  readonly widget: {
    readonly widgetId: string | null;
    readonly live: boolean;
    readonly name: string | null;
  } | null;
  /** The business's name - the preview's logo and launcher, as the design draws them. */
  readonly business: string | null;
  /** For 13h's list - who could answer it. `null`: unread. */
  readonly employees:
    | readonly {
        readonly id: string;
        readonly name: string;
        readonly line: string | null;
        readonly paused: boolean;
      }[]
    | null;
}

export async function loadWebchat(id: string): Promise<WebchatRead> {
  const [settings, channels, employees, business] = await Promise.all([
    serverApi()
      .get({
        endpoint: channelEndpoints.webchatSettings(id),
        payload: webchatSettingsSchema,
        raw: true,
      })
      .then((r) => ({ config: r.data, missing: false }))
      .catch((cause: unknown) => {
        if (isApiError(cause) && cause.status === 404) return { config: null, missing: true };
        logger.warn('webchat.settings_failed', { cause });
        return { config: null, missing: false };
      }),
    loadChannels(),
    loadEmployees(),
    serverApi()
      .get({ endpoint: authEndpoints.me(), payload: currentUserSchema })
      .then((me) => me.tenantName?.trim() || null)
      .catch(() => null),
  ]);
  const row = channels.channels?.find((c) => c.id === id && c.channel === 'WEBCHAT') ?? null;
  return {
    ...settings,
    business,
    widget: row
      ? {
          widgetId: row.externalId ?? null,
          // PENDING until its first real page load (the old app's WIDGET_PENDING).
          live: row.connectionStatus === 'CONNECTED',
          name: row.displayName ?? null,
        }
      : null,
    employees:
      employees
        ?.filter((e) => e.status !== 'DRAFT')
        .map((e) => ({
          id: e.id,
          name: e.name,
          line: responsibilityOf(e),
          paused: e.status === 'PAUSED',
        })) ?? null,
  };
}
