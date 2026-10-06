import { z } from 'zod';

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
const texts = z.array(z.string()).catch([]).default([]);

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
    .looseObject({ name: text, industry: text, summary: text, products: texts })
    .nullable()
    .catch(null)
    .default(null),
  brand: z
    .looseObject({
      voice: text,
      tone: text,
      style: text,
      vocabulary: texts,
      forbiddenWords: texts,
      languages: texts,
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
    .array(z.looseObject({ label: z.string() }))
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
