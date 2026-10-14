import { z } from 'zod';

import { plainDashes } from '@/lib/plain-dashes';

/**
 * Settings · Workspace - screen 11.
 *
 * Shapes read from `services/auth/src/routes/workspace.ts` in full, not from
 * the OpenAPI document: the generator cannot extract response schemas, and an
 * absent schema there means "not extractable", never "returns nothing".
 *
 * These are *"the facts every AI employee quotes to a customer"*, so a field
 * that is absent must render as absent. A workspace that has not filled in its
 * address and one whose address failed to load look identical if either is
 * coerced to an empty string, and only one of them is safe to leave alone.
 */

/** A single day. `open`/`close` are absent on a closed day, not empty. */
export const dayScheduleSchema = z.looseObject({
  enabled: z.boolean().default(false),
  open: z.string().optional(),
  close: z.string().optional(),
});

export const DAY_KEYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

export type DayKey = (typeof DAY_KEYS)[number];

/**
 * Opening hours.
 *
 * `aiOutsideHours` is not cosmetic: `active` means the AI keeps answering
 * while the business is closed, `silent` means it does not. The screen shows
 * the week, but this decides what a customer gets at 23:00.
 */
export const businessHoursSchema = z.looseObject({
  enabled: z.boolean().default(false),
  schedule: z.record(z.string(), dayScheduleSchema).nullable().optional(),
  aiOutsideHours: z.enum(['active', 'silent']).catch('active'),
  outsideHoursHandoffMessage: z.string().default(''),
});

export const workspaceSchema = z.looseObject({
  /** Falls back to the tenant name server-side, so this is never blank. */
  name: z.string().nullable().optional(),
  /** The design's "What you sell". `BusinessProfile.businessDescription`. */
  description: z.string().nullable().optional(),
  websiteDomain: z.string().nullable().optional(),
  industry: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  /**
   * A list by contract, even though storage holds one.
   *
   * PATCH used to accept up to six and keep `languages[0]`, so a caller adding
   * English beside Hebrew got a 200 and lost English - and the response is a
   * re-read, so the loss was visible only to a caller that diffed the reply
   * against what it sent, and invisible to anything that did the normal thing
   * and trusted the success.
   *
   * **It now refuses a list longer than one with a 422**, so nothing is
   * dropped silently. The array shape stays, because it is the contract for
   * when a second column exists.
   *
   * The UI is still single-select - one stored language is still one stored
   * language - but the reason has changed from "a control here would lose
   * data" to "there is nothing to put in a second slot". That matters for
   * whoever builds the multi-select later: the blocker is storage now, not a
   * silent failure, and the endpoint will tell them so.
   */
  languages: z.array(z.string()).default([]),
  /** ISO-4217, for prices the AI quotes. Not the billing currency. */
  currency: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  /** Null when the setting has never been written, or would not parse. */
  hours: businessHoursSchema.nullable().optional(),
  /**
   * The later of the profile's and the hours' timestamps, and the value to
   * send back as `If-Match`. A concurrency check that watched only one of two
   * writable sources would miss half the conflicts.
   */
  updatedAt: z.string().nullable().optional(),
  /**
   * Who last wrote each field - screen 11b.
   *
   * `"scan"` · `"human"` · **`null`, which means UNKNOWN and NOT "from the
   * website"**. The route repeats that warning where it builds the map,
   * because reading null as scan-owned is the single mistake that would make
   * a rescan overwrite somebody's correction.
   *
   * Stored in `TenantSetting` under `profileFieldProvenance`, not in a column
   * - which is why a schema search says this does not exist. It was written
   * for this screen: *"Screen 11b's mechanic is: Scan again re-reads the site
   * and only touches fields marked From website; anything typed stays."*
   */
  fieldSources: z.record(z.string(), z.enum(['scan', 'human']).nullable()).default({}),
});

export type Workspace = z.infer<typeof workspaceSchema>;

/** The fields the provenance map tracks, in the service's own order. */
export const PROVENANCED_FIELDS = [
  'organizationName',
  'businessDescription',
  'primaryLanguage',
  'industry',
  'country',
  'address',
  'currency',
] as const;

export type FieldOrigin = 'scan' | 'human' | 'unknown';

/**
 * How a field should be labelled.
 *
 * Three states, and the third is not a missing second state. The profile is
 * seeded by an onboarding confirm step that *"means two different things: 'the
 * scan proposed this' and 'the human accepted or corrected it'. Same column,
 * same statement."* So an unmarked field is genuinely unattributable, and
 * saying *"from the website"* about one would be a guess presented as a fact.
 */
export function fieldOrigin(workspace: Workspace, field: string): FieldOrigin {
  return workspace.fieldSources?.[field] ?? 'unknown';
}

/**
 * Is anything at all marked?
 *
 * **Today, on every tenant in the estate, no.** `profileFieldProvenance` has
 * zero rows across the whole database, so a rescan currently applies nothing
 * and offers everything.
 *
 * The map is self-healing - once a scan writes a field through the service,
 * that field is marked and refreshes silently forever after - so the true
 * sentence is *"the first scan will ask about everything; after that it
 * refreshes what it owns"*. That is a statement about a system that improves,
 * not an apology, and it is the only honest thing to put beside a set of
 * badges that will all be blank.
 */
export function anyFieldAttributed(workspace: Workspace): boolean {
  return Object.values(workspace.fieldSources ?? {}).some((v) => v !== null);
}

/**
 * `country` arrives as the literal string `"unknown"` on this tenant.
 *
 * Rendered as-is it reads as a country called "unknown". Treated as blank it
 * reads as a field nobody filled in - which is also wrong, and differently:
 * we DID look, and what we found was unusable.
 */
export function isUnusableValue(value: string | null | undefined): boolean {
  return value == null || value.trim() === '' || value.trim().toLowerCase() === 'unknown';
}

/**
 * How the business sounds.
 *
 * Three states, not two. `none` (nothing learned yet) and `learned`
 * (derived from the business's own past messages, untouched) offer different
 * actions, and `edited` is the one the import pipeline refuses to overwrite.
 */
export const VOICE_SOURCES = ['none', 'learned', 'edited'] as const;
export type VoiceSource = (typeof VOICE_SOURCES)[number];

export const VOICE_MIN = 40;
export const VOICE_MAX = 1800;

export const workspaceVoiceSchema = z.looseObject({
  guidance: z.string().nullable().optional(),
  source: z.enum(VOICE_SOURCES).catch('none'),
  editedAt: z.string().nullable().optional(),
  /**
   * Provenance for the guidance. Still a hardcoded stub server-side -
   * `workspace.ts:303`, `:336` and `:366` all send
   * `{ messagesAnalysed: null, importedAt: null }` - so the screen renders
   * `source` and omits these. A provenance claim built from a placeholder is
   * worse than none.
   *
   * ── WHY THIS BROKE, AND WHY THE BREAK WAS BACKWARDS ──
   * The stub used to send `0`. Backend's `6a9ffa58` changed it to `null`,
   * which is **more truthful**: zero messages analysed is a claim, and null
   * is "we do not know". This schema said `z.number().default(0)`, which
   * fills `undefined` and REJECTS an explicit null - so the guard refused an
   * improvement, because the less truthful shape had been encoded as
   * required.
   *
   * The refusal itself was correct behaviour: the whole voice editor
   * disappeared behind "the voice could not be loaded just now" rather than
   * rendering against a payload it did not understand. **A contract that
   * fails closed will sometimes fail on good news.** That is the price, and
   * it is the right one - but it is worth knowing the direction it can come
   * from, because a backend making its own payload more honest is not the
   * change anyone watches for.
   *
   * `nullable`, not just optional: the field is PRESENT and null, and those
   * are different states. `default(null)` covers a payload that omits it.
   */
  basis: z
    .looseObject({
      messagesAnalysed: z.number().nullable().default(null),
      importedAt: z.string().nullable().optional(),
    })
    .optional(),
  /**
   * An empty write is a REVERT, not a delete: it clears the edit stamp so the
   * next import can learn the voice again. "We threw your text away" and "we
   * handed this back to the learner" look identical from a blank box, so the
   * server says which, and the screen must too.
   */
  reverted: z.boolean().optional(),
});

export type WorkspaceVoice = z.infer<typeof workspaceVoiceSchema>;

/** A model's reply: plain hyphens (`plainDashes`). */
export const voiceSampleSchema = z.looseObject({
  reply: z.string().transform((s) => plainDashes(s)),
});

export const prohibitedClaimsSchema = z.looseObject({
  claims: z.array(z.string()).default([]),
});

export type ProhibitedClaims = z.infer<typeof prohibitedClaimsSchema>;

/* ── Screen 11b · scanning the website again ─────────────────────────────── */

/** Why a field was offered rather than applied. Two different admissions. */
export const OFFER_REASONS = ['human_edited', 'source_unknown'] as const;
export type OfferReason = (typeof OFFER_REASONS)[number];

export const scanOfferSchema = z.object({
  field: z.string(),
  current: z.unknown().nullable().default(null),
  proposed: z.unknown().nullable().default(null),
  because: z.enum(OFFER_REASONS),
});

export type ScanOffer = z.infer<typeof scanOfferSchema>;

/**
 * What the crawl could SEE, which decides whether its findings mean anything.
 *
 * `distinctTextPages === 1` means every path answered with the same page - a
 * login wall - so the screen says the site could not be read instead of
 * quoting `pagesRead`. A caveat that appears because a measurement says so is
 * information; one that is always there is wallpaper.
 */
export const crawlReachSchema = z.object({
  requested: z.number().default(0),
  pagesRead: z.number().default(0),
  distinctTextPages: z.number().default(0),
});

export type CrawlReach = z.infer<typeof crawlReachSchema>;

/* ── The rescan as a run (2026-10-14): started, then read until it ends ── */

/**
 * Why a run failed (`GET /workspace/scan`, auth 8d01252f), each its own
 * sentence. `timed_out`: the server's three minutes passed.
 */
export const SCAN_FAILURES = [
  'no_domain',
  'no_profile',
  'fetch_failed',
  'scan_failed',
  'internal_error',
  'timed_out',
] as const;
export type ScanFailure = (typeof SCAN_FAILURES)[number];

const count = z.number().int().nonnegative().catch(0).default(0);

/** What the rescan did to the knowledge it generated (it keeps what a person edited). */
export const scanKnowledgeSchema = z.object({
  created: count,
  updated: count,
  unchanged: count,
  preserved: count,
  removed: count,
  failed: count,
});
export type ScanKnowledge = z.infer<typeof scanKnowledgeSchema>;

/**
 * One rescan. POST starts it and answers at once (202, or 409
 * SCAN_IN_PROGRESS with the run already going); GET reads it until it is
 * done or failed. A crawl and a model call, 25-40 seconds: longer than the
 * browser and the BFF ever waited, so it is never awaited in one request.
 *
 * Per offer: one that does not parse is left out, never the run.
 */
export const scanRunSchema = z.object({
  status: z.enum(['running', 'done', 'failed']),
  startedAt: z.string().nullable().catch(null).default(null),
  finishedAt: z.string().nullable().catch(null).default(null),
  reason: z.string().nullable().catch(null).default(null),
  applied: z.array(z.string()).catch([]).default([]),
  offer: z
    .array(z.unknown())
    .catch([])
    .default([])
    .transform((rows) =>
      rows.flatMap((row): ScanOffer[] => {
        const item = scanOfferSchema.safeParse(row);
        return item.success ? [item.data] : [];
      }),
    ),
  reach: crawlReachSchema.nullable().catch(null).default(null),
  knowledge: scanKnowledgeSchema.nullable().catch(null).default(null),
});
export type ScanRun = z.infer<typeof scanRunSchema>;

/** `GET /workspace/scan`: the last run (`null`: none ever started). */
export const scanStateSchema = z.object({
  run: scanRunSchema.nullable().catch(null).default(null),
});

export const acceptResultSchema = z.object({
  accepted: z.array(z.string()).default([]),
  /**
   * Named rather than dropped. A stale screen offering a field the last scan
   * did not propose must be told, not quietly told it worked.
   */
  skipped: z.array(z.object({ field: z.string(), reason: z.string() })).default([]),
  fieldSources: z.record(z.string(), z.enum(['scan', 'human']).nullable()).default({}),
});

export type AcceptResult = z.infer<typeof acceptResultSchema>;

/**
 * Could the site be read at all?
 *
 * One distinct page means the crawl fetched many URLs and saw one - the
 * password-protected case, measured on this very tenant at 17 requested, 17
 * returned, 1 distinct. Everything the scan proposes from such a crawl is
 * inferred from a login screen.
 */
export function siteWasReadable(reach: CrawlReach | null): boolean {
  return reach === null || reach.distinctTextPages > 1;
}

/**
 * A website as 02 writes it: the host alone - "avivco.il", never
 * "https://www.avivco.il/". The field arrives as a full URL; the scheme and
 * `www.` are noise beside a name, and the full URL wrapped 11's banner onto
 * two lines. A value that does not parse is shown without its scheme.
 */
export function displayHost(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.host.replace(/^www\./i, '');
  } catch {
    return trimmed
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/\/+$/, '');
  }
}

/**
 * The crawler's `businessType` codes - every value `site-crawl.service.ts`
 * returns (`classify…`), which is how `industry` gets written by a scan.
 * Onboarding writes free text instead ("SaaS / Customer Communication").
 */
export const INDUSTRY_CODES = [
  'ecommerce',
  'legal',
  'saas',
  'events',
  'tourism',
  'restaurant',
  'health',
  'realestate',
] as const;
export type IndustryCode = (typeof INDUSTRY_CODES)[number];

/**
 * How a stored industry reaches the screen: a crawler code by its NAME, the
 * crawler's "generic" and an empty value as nothing, and a person's own
 * free text as they wrote it. No code is ever shown as stored.
 */
export function industryReading(
  value: string | null | undefined,
): { readonly code: IndustryCode } | { readonly text: string } | null {
  const v = value?.trim();
  if (!v || v === 'generic') return null;
  if ((INDUSTRY_CODES as readonly string[]).includes(v)) return { code: v as IndustryCode };
  return { text: v };
}

/**
 * A stored country by name: an ISO 3166 code through `Intl.DisplayNames`.
 * Anything else is nothing - onboarding's literal "unknown", a written-out
 * "Israel", "ZZ" (which `Intl` calls "Unknown Region") - so the row reads as not set, never as
 * what was stored.
 */
export function countryName(value: string | null | undefined, locale: string): string | null {
  const v = isoCountry(value);
  if (v === null) return null;
  try {
    return new Intl.DisplayNames([locale], { type: 'region', fallback: 'none' }).of(v) ?? null;
  } catch {
    return null;
  }
}

/**
 * A stored country as the ISO 3166 alpha-2 code of a country, or `null` -
 * the code the country select opens on, so "ZZ" opens on "-" and an
 * unchanged save clears it rather than sending it back.
 */
export function isoCountry(value: string | null | undefined): string | null {
  const v = value?.trim().toUpperCase() ?? '';
  return /^[A-Z]{2}$/.test(v) && isAssignedCountry(v) ? v : null;
}

/**
 * A website as the route stores it (auth `normalizeWebsite`, a6bfa7c9): a
 * scheme is added when missing, then the http(s) ORIGIN - lowercased host,
 * no path, no credentials. `null` when it is not an address the route takes.
 */
export function websiteOrigin(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withProto);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
    return `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}`;
  } catch {
    return null;
  }
}

/**
 * Two-letter codes `Intl` names that ISO 3166-1 does not assign to a country:
 * groupings (EU, EZ, UN, QO), "Unknown Region" (ZZ) and the exceptionally
 * reserved islands and territories (AC, CP, CQ, DG, EA, IC, TA).
 */
const NOT_A_COUNTRY = new Set([
  'EU',
  'EZ',
  'UN',
  'QO',
  'ZZ',
  'AC',
  'CP',
  'CQ',
  'DG',
  'EA',
  'IC',
  'TA',
]);

function isAssignedCountry(code: string): boolean {
  if (NOT_A_COUNTRY.has(code)) return false;
  if ((code[0] === 'Q' && code >= 'QM') || (code[0] === 'X' && code !== 'XK')) return false;
  return Intl.getCanonicalLocales(`und-${code}`)[0] === `und-${code}`;
}

/**
 * Every ISO 3166 alpha-2 country, by its name in `locale`, in that order - read
 * from `Intl.DisplayNames` rather than kept as a table here. Private-use codes
 * (`QM-QZ`, `XA-XZ` but Kosovo's `XK`) and the codes above are left out, and
 * so is a retired alias (UK, SU, YU…): `Intl` names it as the country it became,
 * which would list Russia twice.
 */
export function countryOptions(locale: string): readonly { code: string; name: string }[] {
  let names: Intl.DisplayNames;
  try {
    names = new Intl.DisplayNames([locale], { type: 'region', fallback: 'none' });
  } catch {
    return [];
  }
  const out: { code: string; name: string }[] = [];
  for (let a = 65; a <= 90; a += 1) {
    for (let b = 65; b <= 90; b += 1) {
      const code = String.fromCharCode(a, b);
      if (!isAssignedCountry(code)) continue;
      const name = names.of(code);
      if (name && name !== code) out.push({ code, name });
    }
  }
  return out.sort((x, y) => x.name.localeCompare(y.name, locale));
}
