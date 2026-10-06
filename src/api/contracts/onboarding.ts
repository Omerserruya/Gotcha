import { z } from 'zod';

import { plainDashes } from '@/lib/plain-dashes';

/**
 * Onboarding after the workspace exists - 00d-00h (design 6), over the
 * routes that already exist (auth service, `/api/onboarding/*`, no status
 * gate). Surveyed 2026-10-06; what is NOT here is drawn with its reason:
 *
 *   no per-track counts (products, policies, places, voice) while reading
 *   no page-against-page conflicts - only history imports have conflicts
 *   voice is one free-text guidance, not traits / formality / says lists
 *   tool permissions are ACTIVE-only, so 00g's table is set after go-live
 *   no sample of real inbound questions beyond unanswered ones
 */

export const ONBOARDING_STEPS = ['website', 'reading', 'learned', 'truth', 'try'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

const text = z.string().nullable().catch(null).default(null);
/*
 * What the scan's model wrote (business, brand, gaps): shown with plain
 * hyphens - Omer bans the em dash everywhere, model output included (dev:
 * a stored gap carried one). Backend is fixing the source too.
 */
const modelText = z
  .string()
  .transform((s) => plainDashes(s))
  .nullable()
  .catch(null)
  .default(null);
const modelTexts = z
  .array(z.string().transform((s) => plainDashes(s)))
  .catch([])
  .default([]);

export const DISCOVERY_STATUSES = ['PENDING', 'SCANNING', 'COMPLETE', 'FAILED'] as const;
export type DiscoveryStatus = (typeof DISCOVERY_STATUSES)[number];

/** `scanPhase`: homepage → pages → synthesis → done | failed. */
export const SCAN_PHASES = ['homepage', 'pages', 'synthesis', 'done', 'failed'] as const;
export type ScanPhase = (typeof SCAN_PHASES)[number];

export const discoverySchema = z.looseObject({
  /** A normalised origin, "https://avivco.il". */
  websiteDomain: text,
  status: z.enum(DISCOVERY_STATUSES).catch('PENDING'),
  scanPhase: z.enum(SCAN_PHASES).nullable().catch(null).default(null),
  updatedAt: text,
  scannedAt: text,
  business: z
    .looseObject({ name: modelText, industry: text, summary: modelText, products: modelTexts })
    .nullable()
    .catch(null)
    .default(null),
  brand: z
    .looseObject({
      voice: modelText,
      tone: modelText,
      style: modelText,
      vocabulary: modelTexts,
      forbiddenWords: modelTexts,
      /** Codes ("he", "en") or names - shown by name. */
      languages: modelTexts,
    })
    .nullable()
    .catch(null)
    .default(null),
  technology: z
    .looseObject({
      platform: z
        .looseObject({ slug: z.string(), name: z.string().catch('') })
        .nullable()
        .catch(null)
        .default(null),
    })
    .nullable()
    .catch(null)
    .default(null),
  crawl: z
    .looseObject({
      requested: z.number().catch(0),
      pagesRead: z.number().catch(0),
      distinctTextPages: z.number().catch(0),
    })
    .nullable()
    .catch(null)
    .default(null),
  gaps: z
    .array(z.looseObject({ label: z.string().transform((s) => plainDashes(s)) }))
    .catch([])
    .default([]),
});
export type Discovery = z.infer<typeof discoverySchema>;

/** `GET /api/onboarding/discovery` (ADMIN). Strict envelope: `null` is "never scanned". */
export const discoveryReadSchema = z.object({
  data: z.object({ discovery: discoverySchema.nullable() }),
});

/** `GET /api/onboarding/status` - only what 00d reads. */
export const onboardingStatusSchema = z.object({
  data: z.looseObject({
    tenant: z.looseObject({ name: text, status: z.string().catch('') }),
    businessProfile: z
      .looseObject({ organizationName: text, websiteDomain: text })
      .nullable()
      .catch(null)
      .default(null),
    coreSystemConnected: text,
  }),
});
export type OnboardingStatus = z.infer<typeof onboardingStatusSchema>['data'];

/**
 * Mail providers whose domain is nobody's website: 00d skips the guess and
 * opens the question (the old app's list, `setup/page.tsx:198`).
 */
const FREE_MAIL = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'icloud.com',
  'me.com',
  'walla.co.il',
  'walla.com',
  'proton.me',
  'protonmail.com',
]);

/** The site a work address implies - `null` for a free mail domain or no address. */
export function siteFromEmail(email: string | null | undefined): string | null {
  const domain = email?.split('@')[1]?.trim().toLowerCase();
  if (!domain || FREE_MAIL.has(domain)) return null;
  return siteHost(domain);
}

/**
 * A typed address as a host - "avivco.il" from "https://www.avivco.il/shop".
 * `null` when it is not one: the backend answers `invalid_domain` for those,
 * and after the request has left that answer arrives nowhere.
 */
export function siteHost(input: string): string | null {
  const bare = input
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/?#]/)[0]
    ?.toLowerCase();
  if (!bare || !/^(?=.{3,255}$)[a-z0-9¡-￿-]+(\.[a-z0-9¡-￿-]+)+$/u.test(bare)) {
    return null;
  }
  return bare;
}

/** The knowledge sources a website read writes (`ingest/latest` counts the same set). */
const SCANNED_SOURCE_TYPES = new Set(['onboarding_scan', 'url', 'website', 'web']);

export interface ScannedFact {
  readonly id: string;
  readonly title: string;
  /** The page it came from, as 00e writes it: "/shipping". */
  readonly path: string | null;
  readonly ready: boolean;
  readonly updatedAt: string | null;
}

/**
 * 00e's "Found just now" and 00f's list: what the read put in Knowledge, each
 * with the page it came from, newest first.
 */
export function scannedFacts(
  documents: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly sourceType: string;
    readonly sourceUrl: string | null;
    readonly updatedAt: string | null;
  }[],
): readonly ScannedFact[] {
  return documents
    .filter((d) => SCANNED_SOURCE_TYPES.has(d.sourceType) && d.title.trim() !== '')
    .map((d) => ({
      id: d.id,
      title: plainDashes(d.title.trim()),
      path: pathOf(d.sourceUrl),
      ready: d.status === 'ready',
      updatedAt: d.updatedAt,
    }))
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

function pathOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const { pathname } = new URL(url);
    return pathname === '' ? '/' : pathname.replace(/\/+$/, '') || '/';
  } catch {
    return null;
  }
}

/**
 * How far a read is, from its phase alone - the route reports no finer
 * progress. `null` before it has started.
 */
export function readProgress(discovery: Discovery | null): number | null {
  if (!discovery || discovery.status === 'PENDING') return null;
  if (discovery.status === 'COMPLETE') return 1;
  switch (discovery.scanPhase) {
    case 'homepage':
      return 0.15;
    case 'pages':
      return 0.45;
    case 'synthesis':
      return 0.8;
    case 'done':
      return 1;
    default:
      return discovery.status === 'SCANNING' ? 0.1 : null;
  }
}

/**
 * Languages as 00d's chip says them: "Hebrew and English", never "he". A
 * code goes through `Intl.DisplayNames`; a name stays as written.
 */
export function languageNames(languages: readonly string[], locale: string): string | null {
  const names = [...new Set(languages.map((l) => l.trim()).filter(Boolean))].map((l) => {
    if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(l)) return l;
    try {
      return new Intl.DisplayNames([locale], { type: 'language' }).of(l) ?? l;
    } catch {
      return l;
    }
  });
  if (names.length === 0) return null;
  return new Intl.ListFormat(locale, { type: 'conjunction' }).format(names);
}
