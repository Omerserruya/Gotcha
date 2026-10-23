import 'server-only';

import { isApiError } from '@/api/client/api-error';
import type { Channel } from '@/api/contracts/channels';
import type { WidgetInstall } from '@/api/contracts/website-widget';
import { loadChannels } from '@/features/channels/load-channels';
import { loadChannelsConfig, type ChannelsConfig } from '@/features/channels/load-whatsapp';
import { loadWidgetInstall } from '@/features/webchat/load-website-widget';
import { serverApi } from '@/api/client/server-api';
import { currentUserSchema } from '@/api/contracts/identity';
import { integrationsSchema, type Integration } from '@/api/contracts/integrations';
import { knowledgeListSchema } from '@/api/contracts/knowledge';
import {
  integrationSuggestionsSchema,
  savedStepSchema,
  type IntegrationSuggestion,
} from '@/api/contracts/onboarding-v2';
import type { ResumeFacts } from './resume-v2';
import { readScan } from './scan-actions';
import { workspaceVoiceSchema, type WorkspaceVoice } from '@/api/contracts/workspace';
import {
  discoveryReadSchema,
  scannedFacts,
  onboardingStatusSchema,
  previewQuestionsSchema,
  type PreviewQuestions,
  siteFromEmail,
  siteHost,
  type Discovery,
  type ScannedFact,
} from '@/api/contracts/onboarding';
import {
  authEndpoints,
  integrationEndpoints,
  knowledgeEndpoints,
  onboardingEndpoints,
  workspaceEndpoints,
} from '@/api/endpoints/registry';
import {
  loadShopifyAvailability,
  type ShopifyAvailability,
} from '@/features/capabilities/load-capabilities';
import { logger } from '@/observability/logger';

/** Where 00d's guess came from - its line under the title says so. */
export type GuessSource = 'scan' | 'profile' | 'email';

export interface WebsiteRead {
  /** The host to confirm, or `null`: nothing to guess from - the question opens. */
  readonly guess: { readonly host: string; readonly from: GuessSource } | null;
  readonly email: string | null;
  /** The business's name as the workspace knows it. */
  readonly business: string | null;
  /** The last scan, when there was one - what 00d's card can say it found. */
  readonly discovery: Discovery | null;
}

/**
 * 00d. The guess, in order: the site a scan already read, the site the
 * profile holds, the site the work address implies. A free mail domain
 * implies none. Each read failing just narrows the guess - 00d always has its
 * question to fall back to.
 */
export async function loadWebsiteStep(): Promise<WebsiteRead> {
  const [me, status, discovery] = await Promise.all([
    serverApi()
      .get({ endpoint: authEndpoints.me(), payload: currentUserSchema })
      .catch(() => null),
    serverApi()
      .get({ endpoint: onboardingEndpoints.status(), payload: onboardingStatusSchema, raw: true })
      .then((r) => r.data)
      .catch((cause: unknown) => {
        logger.warn('onboarding.status_failed', { cause });
        return null;
      }),
    loadDiscovery(),
  ]);
  const email = me?.user.email ?? null;
  const fromScan = discovery?.websiteDomain ? siteHost(discovery.websiteDomain) : null;
  const fromProfile = status?.businessProfile?.websiteDomain
    ? siteHost(status.businessProfile.websiteDomain)
    : null;
  const fromEmail = siteFromEmail(email);
  const guess = fromScan
    ? { host: fromScan, from: 'scan' as const }
    : fromProfile
      ? { host: fromProfile, from: 'profile' as const }
      : fromEmail
        ? { host: fromEmail, from: 'email' as const }
        : null;
  return {
    guess,
    email,
    business:
      discovery?.business?.name?.trim() ||
      status?.businessProfile?.organizationName?.trim() ||
      me?.tenantName?.trim() ||
      null,
    discovery,
  };
}

/** The scan's row, `null` when never scanned. Throws when unread. */
export async function readDiscovery(): Promise<Discovery | null> {
  const read = await serverApi().get({
    endpoint: onboardingEndpoints.discovery(),
    payload: discoveryReadSchema,
    raw: true,
  });
  return read.data.discovery;
}

/** The scan's row. `null`: never scanned - or unread, which 00d treats the same way. */
export async function loadDiscovery(): Promise<Discovery | null> {
  try {
    return await readDiscovery();
  } catch (cause) {
    logger.warn('onboarding.discovery_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return null;
  }
}

export async function loadScannedFacts(): Promise<readonly ScannedFact[] | null> {
  try {
    const sources = await serverApi().get({
      endpoint: knowledgeEndpoints.sources(),
      payload: knowledgeListSchema,
    });
    return scannedFacts(sources.flatMap((s) => s.documents));
  } catch (cause) {
    logger.warn('onboarding.facts_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return null;
  }
}

export interface LearnedRead {
  readonly discovery: Discovery | null;
  readonly facts: readonly ScannedFact[] | null;
  /** `null`: unread. */
  readonly voice: WorkspaceVoice | null;
}

/** 00f: what the read put in Knowledge, what it heard of the brand, the stored voice. */
export async function loadLearned(): Promise<LearnedRead> {
  const [discovery, facts, voice] = await Promise.all([
    loadDiscovery(),
    loadScannedFacts(),
    serverApi()
      .get({ endpoint: workspaceEndpoints.voice(), payload: workspaceVoiceSchema })
      .catch((cause: unknown) => {
        logger.warn('onboarding.voice_failed', {
          status: isApiError(cause) ? cause.status : undefined,
        });
        return null;
      }),
  ]);
  return { discovery, facts, voice };
}

export interface TruthRead {
  /** The catalogue with this workspace's connection on each. `null`: unread. */
  readonly integrations: readonly Integration[] | null;
  readonly shopify: ShopifyAvailability | null;
  /** The store platform the website read found, and the site it found it on. */
  readonly detected: { readonly slug: string; readonly host: string | null } | null;
  /**
   * The core system the server counts (`coreSystemConnected`) - the one
   * `/complete` checks. `null`: none, or unread.
   */
  readonly coreSystem: string | null;
}

/** 00g: what can be connected, what is, and what the read found on the site. */
export async function loadTruth(): Promise<TruthRead> {
  const [integrations, shopify, discovery, status] = await Promise.all([
    serverApi()
      .get({ endpoint: integrationEndpoints.list(), payload: integrationsSchema })
      .catch((cause: unknown) => {
        logger.warn('onboarding.integrations_failed', {
          status: isApiError(cause) ? cause.status : undefined,
        });
        return null;
      }),
    loadShopifyAvailability(),
    loadDiscovery(),
    serverApi()
      .get({ endpoint: onboardingEndpoints.status(), payload: onboardingStatusSchema, raw: true })
      .then((r) => r.data)
      .catch(() => null),
  ]);
  const platform = discovery?.technology?.platform?.slug?.trim().toLowerCase() || null;
  return {
    integrations,
    shopify,
    coreSystem: status?.coreSystemConnected ?? null,
    detected: platform
      ? {
          slug: platform,
          host: discovery?.websiteDomain ? siteHost(discovery.websiteDomain) : null,
        }
      : null,
  };
}

/**
 * 00h: what to try GOTCHA on - real unanswered questions, then what
 * customers usually ask (the route chooses, up to three). `null`: unread.
 */
export async function loadTry(locale: string): Promise<PreviewQuestions | null> {
  try {
    const read = await serverApi().get({
      endpoint: onboardingEndpoints.previewQuestions(),
      payload: previewQuestionsSchema,
      raw: true,
      query: { locale },
    });
    return read.data;
  } catch (cause) {
    logger.warn('onboarding.preview_questions_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return null;
  }
}

export interface SystemsRead {
  /** `null`: the suggestions could not be read - never "nothing to suggest". */
  readonly suggestions: readonly IntegrationSuggestion[] | null;
  /** The catalogue, for how each one connects; `null`: unread. */
  readonly integrations: readonly Integration[] | null;
  readonly shopify: Awaited<ReturnType<typeof loadShopifyAvailability>>;
}

/**
 * Step 2: what the site job suggests connecting (the platform it runs on,
 * tools it saw), and the catalogue rows that say how each one connects.
 */
export async function loadSystems(): Promise<SystemsRead> {
  const [suggestions, integrations, shopify] = await Promise.all([
    serverApi()
      .get({
        endpoint: onboardingEndpoints.integrationSuggestions(),
        payload: integrationSuggestionsSchema,
      })
      .catch((cause: unknown) => {
        logger.warn('onboarding.suggestions_failed', {
          status: isApiError(cause) ? cause.status : undefined,
        });
        return null;
      }),
    serverApi()
      .get({ endpoint: integrationEndpoints.list(), payload: integrationsSchema })
      .catch((cause: unknown) => {
        logger.warn('onboarding.integrations_failed', {
          status: isApiError(cause) ? cause.status : undefined,
        });
        return null;
      }),
    loadShopifyAvailability(),
  ]);
  return { suggestions, integrations, shopify };
}

export interface ChannelsStepRead {
  /** The tenant's channels; `null`: unread - never "none connected". */
  readonly channels: readonly Channel[] | null;
  /** The website widget's install code and whether it is live; `null`: unread. */
  readonly install: WidgetInstall | null;
  /** WhatsApp's signup launches, and which OAuth providers are set up (`null`: unread). */
  readonly config: ChannelsConfig;
}

/** Step 3: what is connected, the widget's code, and how each channel connects. */
export async function loadChannelsStep(): Promise<ChannelsStepRead> {
  const [channels, install, config] = await Promise.all([
    loadChannels().then((read) => read.channels),
    loadWidgetInstall(),
    loadChannelsConfig(),
  ]);
  return { channels, install, config };
}

/**
 * What onboarding resumes from: the step saved on Continue/Skip, and what
 * the server can prove (the site job, a connected platform, anything to
 * suggest, a channel a customer can reach). `job: 'unread'`: the job could
 * not be read - neither proven nor disproven.
 */
export async function loadResumeFacts(): Promise<
  Omit<ResumeFacts, 'job'> & { readonly job: ResumeFacts['job'] | 'unread' }
> {
  const api = serverApi();
  const [saved, job, status, suggestions, channels, install] = await Promise.all([
    api
      .get({ endpoint: onboardingEndpoints.step(), payload: savedStepSchema })
      .then((read) => read.step)
      .catch(() => null),
    readScan(0),
    api
      .get({ endpoint: onboardingEndpoints.status(), payload: onboardingStatusSchema, raw: true })
      .then((r) => r.data)
      .catch(() => null),
    api
      .get({
        endpoint: onboardingEndpoints.integrationSuggestions(),
        payload: integrationSuggestionsSchema,
      })
      .catch(() => null),
    loadChannels()
      .then((read) => read.channels)
      .catch(() => null),
    loadWidgetInstall(),
  ]);
  return {
    // "done" is past the last screen: the last screen is where it resumes.
    saved: saved === 'done' ? 'live' : saved,
    job: job.ok ? { status: job.job.status } : job.reason === 'none' ? null : 'unread',
    platformConnected: Boolean(status?.coreSystemConnected),
    noSuggestions: suggestions !== null && suggestions.length === 0,
    channelConnected:
      (channels ?? []).some((each) => each.connectionStatus === 'CONNECTED') ||
      install?.code?.status === 'live' ||
      (install?.shopify ?? []).some((shop) => shop.status === 'active' && shop.embedLive),
  };
}
