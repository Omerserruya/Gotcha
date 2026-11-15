import { z } from 'zod';

import { embeddedSignupLaunchSchema } from './whatsapp-connect';

/**
 * GOTCHA's own WhatsApp number - the sender of the platform's alerts, never a
 * tenant's channel (Backend PLAN.md, 2026-11-15; auth
 * `/api/system/platform-whatsapp`, SYSTEM_ADMIN only).
 *
 * ★ The status is read from `status`, never from `lastError`: that string is
 *   "[CODE] sentence" in English, for the logs. `lastErrorCode` is the code.
 *
 * ★ Unknown values degrade, they never reject: a status or template state this
 *   build has not named reads as "unknown" on its row, not as a failed read of
 *   the whole page ([[enum-domains-from-the-type]]).
 */

export const SENDER_STATUSES = [
  'CONNECTED',
  'PENDING_WEBHOOK',
  'TOKEN_INVALID',
  'DISCONNECTED',
] as const;
export type SenderStatus = (typeof SENDER_STATUSES)[number] | 'UNKNOWN';

export const SENDER_SOURCES = ['db', 'env', 'none'] as const;
export type SenderSource = (typeof SENDER_SOURCES)[number];

/** Meta's own template states, plus the platform's NOT_SUBMITTED. */
export const TEMPLATE_STATUSES = [
  'NOT_SUBMITTED',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'PAUSED',
  'DISABLED',
  'IN_APPEAL',
  'PENDING_DELETION',
] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number] | 'UNKNOWN';

export const TEMPLATE_LANGUAGES = ['he', 'en'] as const;
export type TemplateLanguage = (typeof TEMPLATE_LANGUAGES)[number];

const nullableText = z.string().nullish().default(null);

/** A value from `list`, or UNKNOWN: one new state never rejects the read. */
function knownOrUnknown<const T extends readonly string[]>(list: T) {
  return z
    .unknown()
    .transform((value): T[number] | 'UNKNOWN' =>
      typeof value === 'string' && (list as readonly string[]).includes(value)
        ? (value as T[number])
        : 'UNKNOWN',
    );
}

export const platformNumberSchema = z.object({
  display: nullableText,
  verifiedName: nullableText,
  phoneNumberId: z.string(),
  wabaId: nullableText,
  qualityRating: nullableText,
  messagingLimitTier: nullableText,
});
export type PlatformNumber = z.infer<typeof platformNumberSchema>;

export const platformSenderSchema = z.object({
  status: knownOrUnknown(SENDER_STATUSES),
  source: z.enum(SENDER_SOURCES).catch('none'),
  envPresent: z.boolean().catch(false).default(false),
  number: platformNumberSchema.nullish().catch(null).default(null),
  connectedAt: nullableText,
  connectedBy: z.object({ id: z.string(), name: nullableText }).nullish().catch(null).default(null),
  disconnectedAt: nullableText,
  lastErrorCode: nullableText,
  /** Launched by the tenants' own launcher: the same Meta app and config (PLAN §8). */
  launch: embeddedSignupLaunchSchema.nullish().catch(null).default(null),
});
export type PlatformSender = z.infer<typeof platformSenderSchema>;

export const templateLanguageSchema = z.object({
  body: z.string().default(''),
  draftBody: nullableText,
  status: knownOrUnknown(TEMPLATE_STATUSES),
  /** Meta's `rejected_reason` code (`INVALID_FORMAT`, ...), shown as given. */
  rejectedReason: nullableText,
  metaTemplateId: nullableText,
  submittedAt: nullableText,
  lastSyncedAt: nullableText,
});
export type TemplateLanguageRow = z.infer<typeof templateLanguageSchema>;

export const platformTemplateSchema = z.object({
  eventType: z.string(),
  name: z.string(),
  category: z.string().default('UTILITY'),
  parameterCount: z.number().int().nonnegative().catch(0).default(0),
  buttons: z
    .object({
      url: z.boolean().catch(false).default(false),
      quickReplies: z.number().int().nonnegative().catch(0).default(0),
      copyCode: z.boolean().catch(false).default(false),
    })
    .catch({ url: false, quickReplies: 0, copyCode: false })
    .default({ url: false, quickReplies: 0, copyCode: false }),
  alertEnabled: z.boolean().catch(false).default(false),
  /** Verification and the high-risk approval ride on another switch (PLAN §5). */
  toggleable: z.boolean().catch(false).default(false),
  /** AUTHENTICATION bodies are Meta's: false, and PUT answers 405. */
  editable: z.boolean().catch(false).default(false),
  /**
   * The route's own answer to "can this switch turn on": both languages
   * APPROVED and a number connected. Read, never recomputed here.
   */
  canEnable: z.boolean().catch(false).default(false),
  languages: z.object({
    he: templateLanguageSchema.nullish().default(null),
    en: templateLanguageSchema.nullish().default(null),
  }),
});
export type PlatformTemplate = z.infer<typeof platformTemplateSchema>;

export const platformTemplateListSchema = z.array(platformTemplateSchema);

/** The route's own refusals (PLAN "Error codes"), each its own sentence. */
export const PLATFORM_REFUSALS = [
  'choose_one_number',
  'number_belongs_to_workspace',
  'waba_belongs_to_workspace',
  'template_body_invalid',
  'template_not_editable',
  'meta_edit_limit',
  'template_not_approved',
  'no_platform_number',
  'unknown_template',
  'code_exchange_failed',
  'no_waba',
  'no_phone_numbers',
  'platform_store_unavailable',
  'meta_error',
] as const;
export type PlatformRefusal = (typeof PLATFORM_REFUSALS)[number];

/**
 * A body is edited while it is ours to change or Meta's answer invites it:
 * never sent, sent back, paused, or approved (an approved one may be edited
 * on Meta a few times a month: `meta_edit_limit`). Never while Meta is
 * reviewing or deleting it, and never a body Meta writes (`editable: false`).
 */
const EDITABLE_STATUSES: readonly TemplateStatus[] = [
  'NOT_SUBMITTED',
  'REJECTED',
  'PAUSED',
  'APPROVED',
];

export function isEditable(template: PlatformTemplate, status: TemplateStatus): boolean {
  return template.editable && EDITABLE_STATUSES.includes(status);
}

/** Sent to Meta when there is something new to review: never sent, sent back, paused, or a draft. */
export function isSubmittable(row: TemplateLanguageRow): boolean {
  return (
    row.draftBody !== null ||
    row.status === 'NOT_SUBMITTED' ||
    row.status === 'REJECTED' ||
    row.status === 'PAUSED'
  );
}

/** The sender can send: CONNECTED, or PENDING_WEBHOOK (inbound may lag). */
export function senderCanSend(status: SenderStatus): boolean {
  return status === 'CONNECTED' || status === 'PENDING_WEBHOOK';
}
