import 'server-only';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { currentUserSchema } from '@/api/contracts/identity';
import { integrationsSchema, type Integration } from '@/api/contracts/integrations';
import {
  knowledgeListSchema,
  unansweredListSchema,
  type UnansweredQuestion,
} from '@/api/contracts/knowledge';
import { workspaceVoiceSchema, type WorkspaceVoice } from '@/api/contracts/workspace';
import {
  discoveryReadSchema,
  scannedFacts,
  onboardingStatusSchema,
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

export interface ReadingRead {
  readonly discovery: Discovery | null;
  /** `null`: Knowledge could not be read - not "nothing found". */
  readonly facts: readonly ScannedFact[] | null;
}

/**
 * 00e: the read's row, and the pages it has turned into Knowledge so far.
 * Throws when the row is unread: on 00e that is "couldn't look", never "it
 * has not started".
 */
export async function loadReading(): Promise<ReadingRead> {
  const [discovery, facts] = await Promise.all([readDiscovery(), loadScannedFacts()]);
  return { discovery, facts };
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
}

/** 00g: what can be connected, what is, and what the read found on the site. */
export async function loadTruth(): Promise<TruthRead> {
  const [integrations, shopify, discovery] = await Promise.all([
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
  ]);
  const platform = discovery?.technology?.platform?.slug?.trim().toLowerCase() || null;
  return {
    integrations,
    shopify,
    detected: platform
      ? {
          slug: platform,
          host: discovery?.websiteDomain ? siteHost(discovery.websiteDomain) : null,
        }
      : null,
  };
}

/** 00h shows three. */
export const TRY_QUESTIONS = 3;

/**
 * 00h: real questions customers asked that GOTCHA could not answer -
 * the newest open ones. `null`: unread.
 */
export async function loadTry(): Promise<readonly UnansweredQuestion[] | null> {
  try {
    const page = await serverApi().get({
      endpoint: knowledgeEndpoints.unanswered(),
      payload: unansweredListSchema,
      raw: true,
      query: { status: 'open', limit: String(TRY_QUESTIONS) },
    });
    return page.data.filter((q) => q.question.trim() !== '').slice(0, TRY_QUESTIONS);
  } catch (cause) {
    logger.warn('onboarding.questions_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return null;
  }
}

/**
 * Where an admin coming back resumes: by what exists on the server - the
 * website read's row and whether a core system is connected. Nothing stores
 * "the step reached", so this is read, not remembered.
 */
export async function loadResumeState(): Promise<{
  readonly discovery: { readonly status: string } | null;
  readonly coreConnected: boolean;
}> {
  const [discovery, status] = await Promise.all([
    loadDiscovery(),
    serverApi()
      .get({ endpoint: onboardingEndpoints.status(), payload: onboardingStatusSchema, raw: true })
      .then((r) => r.data)
      .catch(() => null),
  ]);
  return { discovery, coreConnected: Boolean(status?.coreSystemConnected) };
}
