import { z } from 'zod';

/**
 * An email channel account's HTML template (Backend, 2026-10-22).
 *
 *   GET  /api/channels/:id/email-template       channels:manage:read
 *   PUT  /api/channels/:id/email-template       channels:manage:update
 *   POST /api/channels/:id/email-template/test  channels:manage:update
 *
 * Email accounts only (GMAIL, OUTLOOK, EMAIL); any other channel is 404
 * `EMAIL_TEMPLATE_NOT_EMAIL_CHANNEL`, and an id outside the tenant 404
 * `CHANNEL_NOT_FOUND`. Refusals carry their reason in `error`.
 */

/** Never saved reads `{ enabled: false, html: null, updatedAt: null }`. */
export const emailTemplateSchema = z.object({
  enabled: z.boolean(),
  html: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type EmailTemplate = z.infer<typeof emailTemplateSchema>;

/**
 * What the sanitiser can strip. The screen names each one, so a value it
 * has no words for is dropped from the list rather than failing the save
 * that has already happened.
 */
export const REMOVED_KINDS = [
  'script',
  'iframe',
  'object',
  'embed',
  'form',
  'on*',
  'javascript:',
] as const;
export type RemovedKind = (typeof REMOVED_KINDS)[number];

/** A PUT's answer: the html AS STORED (sanitised), and what was taken out of it. */
export const savedEmailTemplateSchema = emailTemplateSchema.extend({
  removed: z
    .array(z.string())
    .catch([])
    .default([])
    .transform((kinds) =>
      kinds.filter((kind): kind is RemovedKind =>
        (REMOVED_KINDS as readonly string[]).includes(kind),
      ),
    ),
});

/** The test send goes to the signed-in user's own address, and says which. */
export const emailTemplateTestSchema = z.object({ sentTo: z.string() });

/** The route's refusals, by `error`. */
export const EMAIL_TEMPLATE_ERRORS = {
  contentMissing: 'EMAIL_TEMPLATE_CONTENT_PLACEHOLDER_MISSING',
  tooLarge: 'EMAIL_TEMPLATE_TOO_LARGE',
  notSet: 'EMAIL_TEMPLATE_NOT_SET',
  /** The test only: the signed-in user has no address to send it to. */
  noSender: 'EMAIL_TEMPLATE_NO_SENDER_ADDRESS',
  notConnected: 'EMAIL_TEMPLATE_CHANNEL_NOT_CONNECTED',
  sendFailed: 'EMAIL_TEMPLATE_TEST_SEND_FAILED',
  notEmail: 'EMAIL_TEMPLATE_NOT_EMAIL_CHANNEL',
} as const;
