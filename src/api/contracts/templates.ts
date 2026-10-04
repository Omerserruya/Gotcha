import { z } from 'zod';

/**
 * Message templates — screen 05c.
 *
 * Shapes read from `services/conversation/src/routes/templates.ts` and the
 * `MessageTemplate` model. Every verb on that route is `requireRole("ADMIN")`.
 *
 * ── APPROVAL IS A WHATSAPP CONCEPT, NOT A TEMPLATE CONCEPT ──
 * `channel` is nullable, and null means *all channels*. A template bound to
 * `EMAIL` has no reviewer and never needed one — so *"email only"* is **the
 * reason there is no approval state**, not a state beside "approved". Listing
 * it as a peer of the other states reads as though somebody approved it,
 * which is the `succeeded: null` rendering as `false` mistake in another
 * costume.
 *
 * ── LOCALISATIONS ARE ROWS, NOT A FIELD ──
 * `@@unique([tenantId, name, language, channel])`. Each language is its own
 * row sharing a `name`, so *"Hebrew + English"* is a grouping this app
 * performs — the same shape as `personId` on screen 04. There is no
 * `translations` field to be missing.
 *
 * ── WHAT IS NOT MODELLED ──
 * **No ETA.** Nothing anywhere models how long a provider takes to review, so
 * *"Being reviewed · 1 day"* has no source. The state is real; the number
 * beside it is not.
 *
 * **No rewrite suggestion.** `rejectionReason` is stored and nothing proposes
 * a fix, so *"GOTCHA rewrote it to lead with the customer's own request"* is
 * a claim about work that does not happen.
 *
 * **No usage count and no reply rate.** The `broadcasts Broadcast[]` relation
 * exists and would join cleanly, and `GET /api/templates` has no `include`.
 * Unserved rather than impossible.
 *
 * **No per-template permissions.** Nothing records which employees or
 * automations may use a template.
 */

/** The platform's four. The design draws three and forgets `DRAFT`. */
export const TEMPLATE_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export const templateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  language: z.string().default('en'),
  /** `null` means every channel — which includes WhatsApp, so approval applies. */
  channel: z.string().nullable().default(null),
  /**
   * The WhatsApp number it belongs to; `null` for the tenant's own. Named for
   * 05's campaign form, which offers a number only its own templates.
   */
  channelAccountId: z.string().nullable().catch(null).default(null),
  category: z.string().default('general'),
  body: z.string().default(''),
  footer: z.string().nullable().default(null),
  status: z.enum(TEMPLATE_STATUSES).catch('DRAFT'),
  /** The provider's own words. Real, and the centre of this screen. */
  rejectionReason: z.string().nullable().default(null),
  /*
   * ★ ON THE WIRE ALL ALONG. The list route answers whole rows, and `z.object`
   * stripped these — the three things 05c's preview is made of: the header,
   * the buttons ("See it", "Not now") and the variables with their samples
   * and descriptions ("Filled in from").
   */
  headerType: z.string().nullish().default(null),
  headerContent: z.string().nullish().default(null),
  buttons: z
    .array(
      z.object({
        type: z.string().default('QUICK_REPLY'),
        text: z.string().default(''),
      }),
    )
    .catch([])
    .default([]),
  variables: z
    .array(
      z.object({
        key: z.string(),
        sample: z.string().nullish().default(null),
        description: z.string().nullish().default(null),
      }),
    )
    .catch([])
    .default([]),
  /** Increments on edit, so `1` means never changed since it was written. */
  version: z.number().default(1),
  isActive: z.boolean().default(true),
  updatedAt: z.string().nullable().default(null),
  createdAt: z.string().nullable().default(null),
});

export type Template = z.infer<typeof templateSchema>;

/** `{ data, total, page, limit }` — a real `count`, unlike the contacts list. */
export const templateListSchema = z.object({
  data: z.array(templateSchema).default([]),
  total: z.number().default(0),
});

/**
 * Does this template need a provider's approval at all?
 *
 * WhatsApp reviews templates; email does not. `null` channel means the
 * template may be used anywhere, so it inherits the strictest case.
 */
export function needsApproval(template: Template): boolean {
  return template.channel === null || template.channel === 'WHATSAPP';
}

/**
 * What the row says about this template, in terms of what you can do.
 *
 * `exempt` is not a status — it is the absence of the question, and the row
 * says so rather than implying approval was granted.
 */
export type TemplateStance = 'ready' | 'reviewing' | 'rejected' | 'unsent' | 'exempt' | 'off';

export function templateStance(template: Template): TemplateStance {
  /*
   * ★★ APPROVED IS NOT READY WHEN IT IS SWITCHED OFF. The bot takes only
   * `isActive: true AND status: APPROVED` (`ai-bot.service.ts`), and flows
   * and voice require the same — so an approved, inactive template cannot be
   * sent by anything, and "Ready to send" on it was false (measured on dev).
   * A template still in review, rejected or unsent already says it cannot
   * be sent, and keeps saying why.
   */
  if (!needsApproval(template)) return template.isActive ? 'exempt' : 'off';
  switch (template.status) {
    case 'APPROVED':
      return template.isActive ? 'ready' : 'off';
    case 'PENDING_APPROVAL':
      return 'reviewing';
    case 'REJECTED':
      return 'rejected';
    case 'DRAFT':
      // The state the design forgot. A template written and never submitted
      // is real and common, and rendering it blank or borrowing another
      // label would both be worse than giving it a row of its own.
      return 'unsent';
  }
}

/** Never edited since it was created. Makes "never changed since" real. */
export function isUnchanged(template: Template): boolean {
  return template.version === 1;
}

export interface TemplateGroup {
  readonly name: string;
  /** The row that represents the group — the first, in route order. */
  readonly primary: Template;
  /** Every language this template exists in, deduplicated. */
  readonly languages: readonly string[];
  /** All rows, so a per-language state can be inspected. */
  readonly all: readonly Template[];
}

/**
 * One row per template name, with its languages gathered.
 *
 * Grouped on `name` because that is what the unique key says identifies a
 * template across languages. Two rows with the same name and different
 * channels would also group — which is correct: it is one template the tenant
 * thinks of by that name, and the row shows the channels it covers.
 */
export function groupByName(templates: readonly Template[]): readonly TemplateGroup[] {
  const groups = new Map<string, Template[]>();
  for (const template of templates) {
    const existing = groups.get(template.name);
    if (existing) existing.push(template);
    else groups.set(template.name, [template]);
  }
  return [...groups.entries()].map(([name, all]) => ({
    name,
    primary: all[0]!,
    languages: [...new Set(all.map((t) => t.language).filter(Boolean))],
    all,
  }));
}

/**
 * A variable as the preview shows it: its sample when one was given — so the
 * preview reads as a real message — else its description, else its number.
 */
export function variableLabel(
  variable:
    | { readonly key: string; readonly sample: string | null; readonly description: string | null }
    | undefined,
  key: string,
): string {
  return variable?.sample?.trim() || variable?.description?.trim() || key;
}

/**
 * The body split at its `{{n}}` placeholders, so each can be highlighted.
 * Meta substitutes positional placeholders only; anything else is text.
 */
export type BodyPart =
  { readonly text: string } | { readonly variable: string; readonly key: string };

export function bodyParts(template: Pick<Template, 'body' | 'variables'>): readonly BodyPart[] {
  const parts: BodyPart[] = [];
  const pattern = /\{\{\s*(\d+)\s*\}\}/g;
  let last = 0;
  for (const match of template.body.matchAll(pattern)) {
    if (match.index > last) parts.push({ text: template.body.slice(last, match.index) });
    const key = match[1]!;
    parts.push({
      key,
      variable: variableLabel(
        template.variables.find((v) => v.key === key),
        key,
      ),
    });
    last = match.index + match[0].length;
  }
  if (last < template.body.length) parts.push({ text: template.body.slice(last) });
  return parts;
}
