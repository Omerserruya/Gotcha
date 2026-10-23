import { z } from 'zod';

import { plainDashes } from '@/lib/plain-dashes';

/**
 * Onboarding v2 (Omer, 2026-10-23): learn the site, connect systems,
 * channels, check and go live. Backend's routes on feat/onboarding-v2
 * (auth `routes/onboarding.ts:1867-1980`, `services/onboarding-discover/*`).
 *
 * Every shape here is READ for drawing, so it is lenient field by field: one
 * field this build does not know, or a value it has never seen, never throws
 * a whole poll or a whole review away. What the scan's model wrote is shown
 * with plain hyphens (Omer bans the em dash, model output included).
 */

const text = z.string().nullable().catch(null).default(null);
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
const count = z.number().int().nonnegative().catch(0).default(0);
const flag = z.boolean().catch(false).default(false);

/** A list read item by item: one unreadable entry is dropped, never the list. */
const listOf = <T extends z.ZodType>(item: T) =>
  z
    .array(z.unknown())
    .catch([])
    .default([])
    .transform((items) =>
      items.flatMap((each) => {
        const read = item.safeParse(each);
        return read.success ? [read.data as z.output<T>] : [];
      }),
    );

// ─── 1. Learning the site: the job ───────────────────────────────────────────

/** STALLED is derived by the server: RUNNING with no heartbeat for 90s. */
export const JOB_STATUSES = ['QUEUED', 'RUNNING', 'COMPLETE', 'FAILED', 'STALLED'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** The job's stages, in order (job-store.ts `STAGES`). */
export const JOB_STAGES = [
  'detect_platform',
  'harvest_platform',
  'sitemap',
  'read_pages',
  'extract',
  'write_knowledge',
  'suggest_integrations',
  'done',
] as const;
export type JobStage = (typeof JOB_STAGES)[number];

export const JOB_EVENT_KINDS = ['progress', 'found', 'warn', 'error'] as const;

/**
 * One feed line: a stable KEY plus params, never copy. The screen renders
 * the language; a key it does not know is dropped, never shown raw.
 */
export const jobEventSchema = z.object({
  seq: z.number().int(),
  at: z.string().catch(''),
  stage: z.enum(JOB_STAGES).nullable().catch(null),
  kind: z.enum(JOB_EVENT_KINDS).catch('progress'),
  key: z.string(),
  params: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .catch({})
    .default({}),
});
export type JobEvent = z.infer<typeof jobEventSchema>;

/** What was found so far: CUMULATIVE, so one read after a reload redraws every chip. */
export const jobFoundSchema = z
  .object({
    platform: text,
    productCount: count,
    /** No store feed: N product pages read. "N sampled", never a catalogue size. 0: none. */
    productsSampled: count,
    policies: z.array(z.string()).catch([]).default([]),
    faqCount: count,
    contact: flag,
    hours: flag,
    brand: flag,
    tools: z.array(z.string()).catch([]).default([]),
    /** The site refuses automatic reading. */
    blocked: flag,
  })
  .catch({
    platform: null,
    productCount: 0,
    productsSampled: 0,
    policies: [],
    faqCount: 0,
    contact: false,
    hours: false,
    brand: false,
    tools: [],
    blocked: false,
  });
export type JobFound = z.infer<typeof jobFoundSchema>;

export const jobCountsSchema = z
  .object({
    pagesPlanned: count,
    pagesRead: count,
    pagesBlocked: count,
    products: count,
    policies: count,
    faqs: count,
    documents: count,
  })
  .catch({
    pagesPlanned: 0,
    pagesRead: 0,
    pagesBlocked: 0,
    products: 0,
    policies: 0,
    faqs: 0,
    documents: 0,
  });

/** `GET /api/onboarding/discover/job?since=` → `{ data }`. 404 NO_JOB before any scan. */
export const discoverJobSchema = z.object({
  jobId: z.string(),
  domain: z.string().catch(''),
  /** A status this build does not know reads as RUNNING: keep polling, never a dead end. */
  status: z.enum(JOB_STATUSES).catch('RUNNING'),
  stage: z.enum(JOB_STAGES).nullable().catch(null),
  startedAt: text,
  heartbeatAt: text,
  finishedAt: text,
  /** Only events after `since`; the server keeps the newest 300. */
  events: listOf(jobEventSchema),
  counts: jobCountsSchema,
  found: jobFoundSchema,
  error: z
    .object({ code: z.string(), stage: z.enum(JOB_STAGES).nullable().catch(null) })
    .nullable()
    .catch(null)
    .default(null),
});
export type DiscoverJob = z.infer<typeof discoverJobSchema>;

/** `POST /discover/job` and `/discover/retry` → 202 `{ data }`. */
export const jobStartSchema = z.object({
  jobId: z.string(),
  status: z.enum(JOB_STATUSES).catch('QUEUED'),
  resumed: flag,
});

/** Is the job still doing work? The screen keeps polling while it is. */
export const isLiveJob = (job: Pick<DiscoverJob, 'status'>) =>
  job.status === 'QUEUED' || job.status === 'RUNNING';

// ─── 2. What was learned (editable) ──────────────────────────────────────────

export const POLICY_KINDS = [
  'returns',
  'exchange',
  'shipping',
  'refund',
  'warranty',
  'terms',
  'privacy',
  'other',
] as const;

export const learnedPolicySchema = z.object({
  /** The policy's id is its kind. */
  id: z.string(),
  kind: z.enum(POLICY_KINDS).catch('other'),
  summary: modelText,
  terms: z
    .object({
      windowDays: z.number().nullable().catch(null).default(null),
      exchange: z
        .object({ allowed: z.boolean().nullable().catch(null).default(null), how: modelText })
        .nullable()
        .catch(null)
        .default(null),
      shipping: z
        .object({ times: modelText, costs: modelText, freeOver: modelText })
        .nullable()
        .catch(null)
        .default(null),
      refund: z
        .object({ method: modelText, days: z.number().nullable().catch(null).default(null) })
        .nullable()
        .catch(null)
        .default(null),
      warranty: z
        .object({ months: z.number().nullable().catch(null).default(null) })
        .nullable()
        .catch(null)
        .default(null),
    })
    .nullable()
    .catch(null)
    .default(null),
  sourceUrl: text,
});
export type LearnedPolicy = z.infer<typeof learnedPolicySchema>;

export const learnedFaqSchema = z.object({
  id: z.string(),
  q: z.string().transform((s) => plainDashes(s)),
  a: z.string().transform((s) => plainDashes(s)),
  sourceUrl: text,
});
export type LearnedFaq = z.infer<typeof learnedFaqSchema>;

/** `GET /api/onboarding/learned` → `{ data }`; 404 NOT_LEARNED. PATCH answers the same shape. */
export const learnedSchema = z.object({
  domain: text,
  platform: text,
  profile: z
    .object({ name: modelText, industry: modelText, summary: modelText, valueProp: modelText })
    .nullable()
    .catch(null)
    .default(null),
  /** `null`: nothing about products was learned. Not "no products". */
  products: z
    .object({
      count: z.number().int().nonnegative().nullable().catch(null).default(null),
      /** More exist than were counted. */
      more: flag,
      categories: modelTexts,
      priceRange: z
        .object({
          min: z.number().nullable().catch(null).default(null),
          max: z.number().nullable().catch(null).default(null),
          currency: text,
        })
        .nullable()
        .catch(null)
        .default(null),
      highlights: listOf(
        z.object({
          title: z.string().transform((s) => plainDashes(s)),
          url: text,
          price: z.union([z.string(), z.number()]).nullable().catch(null).default(null),
        }),
      ),
      /** feed: the store's own catalogue; sampled: a few product pages read. */
      source: text,
    })
    .nullable()
    .catch(null)
    .default(null),
  policies: listOf(learnedPolicySchema),
  faq: listOf(learnedFaqSchema),
  contact: z
    .object({
      emails: z.array(z.string()).catch([]).default([]),
      phones: z.array(z.string()).catch([]).default([]),
      whatsapp: z.array(z.string()).catch([]).default([]),
      address: modelText,
      hours: modelText,
    })
    .nullable()
    .catch(null)
    .default(null),
  brand: z
    .object({
      personality: modelText,
      voice: modelText,
      tone: modelText,
      style: modelText,
      audience: modelText,
      positioning: modelText,
      vocabulary: modelTexts,
      preferredTerminology: modelTexts,
      forbiddenWords: modelTexts,
      ctaStyle: modelText,
      greetingExample: modelText,
      languages: modelTexts,
    })
    .nullable()
    .catch(null)
    .default(null),
  tools: listOf(z.object({ slug: z.string(), name: z.string().catch('') })),
});
export type Learned = z.infer<typeof learnedSchema>;

/** The sections PATCH /learned edits. */
export const LEARNED_SECTIONS = ['policies', 'faq', 'profile', 'contact', 'brand'] as const;
export type LearnedSection = (typeof LEARNED_SECTIONS)[number];

// ─── 3. Systems to connect ───────────────────────────────────────────────────

/** `GET /api/onboarding/integration-suggestions` → `{ data: [...] }`. */
export const integrationSuggestionSchema = z.object({
  slug: z.string(),
  name: z.string().catch(''),
  /** Why it is suggested. Unknown: no why line, never a guessed one. */
  reason: z.enum(['platform', 'detected_on_site']).nullable().catch(null),
  /** Where the tool was seen on the site, when the server knows. */
  evidenceUrl: text,
  connected: flag,
});
export type IntegrationSuggestion = z.infer<typeof integrationSuggestionSchema>;
export const integrationSuggestionsSchema = listOf(integrationSuggestionSchema);

// ─── 4. Go live, and the test ────────────────────────────────────────────────

/** `POST /api/onboarding/go-live { employeeName?, confirm: true }` → `{ data }`. Idempotent. */
export const goLiveSchema = z.object({
  employee: z.object({ id: z.string(), name: z.string(), status: z.string().catch('') }),
  channels: listOf(
    z.object({
      id: z.string(),
      type: z.string(),
      displayName: text,
      routed: flag,
    }),
  ),
  knowledgeBases: count,
  policiesApplied: count,
  tools: z
    .object({
      platform: text,
      /** READ tools only at go-live (Backend's decision): looking up orders, never changing them. */
      granted: z.array(z.string()).catch([]).default([]),
    })
    .catch({ platform: null, granted: [] }),
  warnings: z.array(z.string()).catch([]).default([]),
  test: z
    .object({ suggestedQuestion: text, suggestedOrderQuestion: text })
    .catch({ suggestedQuestion: null, suggestedOrderQuestion: null })
    .default({ suggestedQuestion: null, suggestedOrderQuestion: null }),
});
export type GoLive = z.infer<typeof goLiveSchema>;

/**
 * The live employee asked in a sandbox (supervisor, 2026-10-23: POST
 * /api/ai-assist/onboarding-employee-test, NOT BUILT YET). Read-only tools,
 * no conversation, no message, no outbox, no send; 409 before go-live.
 */
export const employeeTestSchema = z.object({
  answer: z.string().transform((s) => plainDashes(s)),
  toolsUsed: listOf(z.object({ name: z.string(), ok: flag })),
  sources: listOf(z.object({ title: z.string().catch(''), sourceUrl: text })),
  usedRealOrder: flag,
  /** The order the answer came from, when it did (asked of Backend; null until sent). */
  orderNumber: text,
  platform: text,
});
export type EmployeeTest = z.infer<typeof employeeTestSchema>;

// ─── The step reached ────────────────────────────────────────────────────────

/** The four steps, as routes (website and reading are both step 1). */
export const ONBOARDING_V2_STEPS = ['website', 'reading', 'systems', 'channels', 'live'] as const;
export type OnboardingV2Step = (typeof ONBOARDING_V2_STEPS)[number];
