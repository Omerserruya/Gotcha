import { z } from 'zod';

/**
 * Screen 04e - what happened in this customer's context.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE READ EXISTS NOW, AND IT DECLARES WHAT IT CANNOT ATTRIBUTE
 * ════════════════════════════════════════════════════════════════════════════
 *   GET /api/audit-logs/customer/:contactId
 *       ?actorType= &action= &from= &to= &limit= &cursor= &shopifyCustomerId=
 *
 * `GET /api/audit-logs` could not be used: its `buildWhere` accepts
 * `actorType`, `action`, `from` and `to` and nothing else, so it is
 * tenant-wide and cannot be scoped to a person at all.
 *
 * The new read resolves the soft join behind `findSiblingContacts` and the
 * preserved `metadata.aliases`, so a merged contact resolves to the survivor,
 * and **it names both origins** - otherwise a customer whose WhatsApp history
 * was imported has that history missing from the record of what was done for
 * them. `applyLiveByDefault` has now quietly emptied a customer read in five
 * separate places, and this is the fifth.
 *
 * ── AND `metadata` IS LIFTED, NEVER RETURNED ──
 * It holds `args`, and `args` hold phone numbers. `succeeded` is derived from
 * it server-side and the blob stays there.
 *
 * ── TWO OF THE THREE TARGET TYPES ARE NOT ATTRIBUTABLE ──
 * `targetId` on a customer-keyed row is a **Shopify** customer id, not a
 * Contact id, so the endpoint cannot derive it - the commerce panel holds it
 * and passes `?shopifyCustomerId=`. Order-keyed rows cannot be attributed at
 * all: same id space, and no local Order table to enumerate a person's orders
 * from.
 *
 * So `coverage` declares it rather than the list quietly omitting it, for the
 * reason this project keeps arriving at: **an empty list cannot say why it is
 * empty, and "no orders" is the wrong thing for a screen to imply.**
 */

/**
 * Who acted.
 *
 * ★ THERE IS NO `flow`. The design asks for AI, user and flow; the column is
 * `user | ai | system` only, so a flow-driven action arrives as one of those
 * three and the distinction the design draws cannot be made. Named on screen
 * rather than silently approximated.
 */
export const ACTOR_TYPES = ['user', 'ai', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** Which of the three ways a row reaches a customer. */
export const AUDIT_TARGETS = ['conversation', 'customer', 'order'] as const;
export type AuditTarget = (typeof AUDIT_TARGETS)[number];

export const auditEventSchema = z.object({
  id: z.string(),
  actorType: z.enum(ACTOR_TYPES).nullable().default(null),
  actorId: z.string().nullable().default(null),
  /**
   * The platform's own vocabulary. Rendered through a lookup where we have
   * one and verbatim where we do not, never invented.
   *
   * ★★ THE EXAMPLES HERE WERE COPIED FROM THE ROUTE'S HEADER AND ONE OF
   * THEM IS NOT WRITTEN ANYWHERE.
   *
   * That header lists `ai.responded`, `adapter.ok/err.shopify.*` and
   * `crm.link.linked` as "the rich set". The first two are real - checked at
   * `ai.service.ts:501` and `integration-framework.ts:581`. **No code in the
   * platform writes `crm.link.linked`**; it exists in that comment and in
   * one test's query string, and nowhere else.
   *
   * Repeating it here made a comment into evidence, which is the costume
   * this project keeps meeting: the comment does the reading, and does it
   * wrong. The verified list lives in `CustomerActions.tsx`, beside the
   * lookup that uses it, and was built from the write sites.
   */
  action: z.string(),
  targetType: z.string().nullable().default(null),
  /**
   * ⚠ THE CONVERSATION THE ACTION HAPPENED IN, NOT THE THING ACTED ON. The
   * route says so itself: the order id lives in `metadata.args` and "has no
   * general shape across tools", so it is deliberately not promoted. A screen
   * that renders this as "the order" would name the wrong object.
   */
  targetId: z.string().nullable().default(null),
  createdAt: z.string(),
  /**
   * ★★ THREE-STATE, AND THE PLATFORM SAYS WHY IN ITS OWN COMMENT:
   * *"null when the emitter recorded no verdict, which is different from
   * false: 'we did not record whether this worked' is not 'it failed'."*
   *
   * Exactly the distinction this project has been drawing all week, arriving
   * from the other direction. A screen that renders null as a failure invents
   * a failed refund; one that renders it as success invents a completed one.
   */
  succeeded: z.boolean().nullable().default(null),
  /**
   * The WEAKER signal, from the action name - `adapter.ok.*` / `adapter.err.*`.
   * Also tri-state: `null` when the name says neither.
   *
   * Carried separately so a screen can show it AS a weaker signal. It is not
   * a fallback for `succeeded`: see `outcomeOf` for why that distinction is
   * the whole point.
   */
  nameImpliesSucceeded: z.boolean().nullable().default(null),
  /** True when the emitter's verdict and its own name disagree. */
  outcomeDisagrees: z.boolean().default(false),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const auditPageSchema = z.object({
  data: z.array(auditEventSchema).default([]),
  nextCursor: z.string().nullable().default(null),
});
export type AuditPage = z.infer<typeof auditPageSchema>;

/**
 * Did this action work? FOUR answers, and `not_recorded` is one of them.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE FIRST VERSION OF THIS FUNCTION HAD THE DEFECT IT WAS WRITTEN AGAINST
 * ════════════════════════════════════════════════════════════════════════════
 * It returned three states and fell back to the `adapter.err.` prefix when
 * `succeeded` was null - described in its own comment as "the fallback, and
 * only then, so an unrecorded verdict is still unknown".
 *
 * It was not. **A fallback IS resolution by naming convention**, which is the
 * thing that comment said not to do, in the same sentence. A row with no
 * recorded verdict and a name containing `err` came out as `failed` - turning
 * *"nobody wrote down whether this refund happened"* into *"this refund
 * failed"*, which is a claim about a customer's money that nobody made.
 *
 * Backend caught it. The three signals now travel separately and this
 * function collapses them **without ever letting the name decide**:
 *
 *   outcomeDisagrees    → `contradicts`   the emitter and its own name differ
 *   succeeded === true  → `worked`
 *   succeeded === false → `failed`
 *   succeeded === null  → `not_recorded`  WHATEVER the name says
 *
 * `contradicts` is first because it is a defect, not a value: a row that says
 * a refund both worked and did not is something somebody must see, and
 * smoothing it into either answer hides a bug in the emitter.
 *
 * ── AND THE NAME IS STILL WORTH SHOWING, JUST NOT WORTH OBEYING ──
 * On a `not_recorded` row, `nameImpliesSucceeded` is the only hint there is.
 * The screen renders it as a hint - "named as a failure, though the outcome
 * was never recorded" - which informs without asserting. That is a different
 * act from resolving the state with it, and it is the one this contract
 * allows.
 */
export type ActionOutcome = 'worked' | 'failed' | 'not_recorded' | 'contradicts';

export function outcomeOf(event: AuditEvent): ActionOutcome {
  if (event.outcomeDisagrees) return 'contradicts';
  if (event.succeeded === true) return 'worked';
  if (event.succeeded === false) return 'failed';
  return 'not_recorded';
}

/**
 * The hint on a row whose outcome was never recorded, or null.
 *
 * Returns the NAME's implication only where there is no verdict to state -
 * so a screen can say what the action is called without claiming what it did.
 */
export function unrecordedHint(event: AuditEvent): 'named_ok' | 'named_err' | null {
  if (event.succeeded !== null) return null;
  if (event.nameImpliesSucceeded === true) return 'named_ok';
  if (event.nameImpliesSucceeded === false) return 'named_err';
  return null;
}

/** The tool an adapter row acted through, or null for anything else. */
export function toolOf(event: AuditEvent): string | null {
  const m = /^adapter\.(?:ok|err)\.(.+)$/.exec(event.action);
  return m?.[1] ?? null;
}

/* ── What the log can and cannot account for ─────────────────────────────── */

/**
 * ★★ DECLARED, NOT INFERRED - the same shape as the timeline's `coverage`.
 *
 * `attributable: false` on orders is not a failure and not an empty result:
 * it is the endpoint saying it has no way to find those rows for this person.
 * A screen that showed only what it received would imply the customer has no
 * order history, which is a different and wrong claim.
 */
export const coverageEntrySchema = z.object({
  attributable: z.boolean().default(false),
  /** e.g. `shopifyCustomerId` - what would make this type attributable. */
  requires: z.string().nullish().default(null),
  reason: z.string().nullish().default(null),
  detail: z.string().nullish().default(null),
});
export type AuditCoverageEntry = z.infer<typeof coverageEntrySchema>;

/**
 * ★ NO `.default({})`. An absent coverage map rendered as "this log accounts
 * for everything", which is the opposite of what the field exists to say.
 */
export const auditCoverageSchema = z.record(z.string(), coverageEntrySchema);
export type AuditCoverage = z.infer<typeof auditCoverageSchema>;

/**
 * Everything the log cannot account for, in one list.
 *
 * Both kinds together - not attributable at all, and attributable only with
 * something we did not pass - because to a merchant they are the same fact:
 * a reason not to read this as the whole record.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ `supplied` EXISTS BECAUSE `coverage` IS A CONSTANT, NOT A REPORT
 * ════════════════════════════════════════════════════════════════════════════
 * The endpoint returns the same `CUSTOMER_AUDIT_COVERAGE` object on every
 * response, whether or not `?shopifyCustomerId=` was sent. So `requires:
 * "shopifyCustomerId"` means *"this is what would make customer-keyed rows
 * attributable"* - **not** *"you did not send it"*.
 *
 * Read as the second thing, a screen that DID send it would print *"Pass
 * ?shopifyCustomerId= to include them"* underneath the very rows that
 * parameter fetched. False, and false in the specific way this project keeps
 * finding: a sentence that is true only while a condition holds, with
 * nothing tying the sentence to the condition.
 *
 * So the caller says what it actually sent, and a requirement it met stops
 * being a gap.
 */
export function coverageGaps(
  coverage: AuditCoverage,
  supplied: readonly string[] = [],
): readonly { readonly target: string; readonly detail: string }[] {
  return Object.entries(coverage)
    .filter(([, e]) => !e.attributable || (e.requires && !supplied.includes(e.requires)))
    .map(([target, e]) => ({ target, detail: e.detail ?? '' }))
    .filter((g) => g.detail !== '');
}

/**
 * How wide the resolution went, and whether it was bounded.
 *
 * `conversationScanTruncated` is the 500-conversation `IN` cap - the same
 * distinction as the timeline's: a bounded read that discloses its bound is
 * fine, one that quietly drops the oldest is the defect.
 */
export const auditScopeSchema = z.object({
  identities: z.number().default(0),
  conversations: z.number().default(0),
  /** ★ NOT defaulted: absent would read as "nothing was dropped". */
  conversationScanTruncated: z.boolean(),
});
export type AuditScope = z.infer<typeof auditScopeSchema>;

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ NOTHING AT THIS LEVEL IS DEFAULTED, AND THE REASON IS A SCREEN
 * ════════════════════════════════════════════════════════════════════════════
 * Every key here used to carry a default, which meant **`{}` parsed
 * cleanly** - and rendered as *"nothing has been recorded against this
 * person yet"* with no coverage caveats underneath it. A stale service, a
 * renamed field or a half-deployed route would all have produced that
 * screen, and it is a confident statement about somebody's history made
 * from a response that said nothing.
 *
 * The route sends all five unconditionally. Required, so a disagreement
 * fails the parse, the loader records it, and the screen says we could not
 * read it - which is true, unlike the empty log.
 *
 * Found because a test wrote `{ nonsense: true }` expecting a failure and
 * got a valid `CustomerAudit`. **A required field proves itself; a
 * defaulted one cannot** - third application of that rule today.
 *
 * The defaults INSIDE `auditEventSchema` stay: one odd row degrading is
 * better than a whole log vanishing, and the row still has a required `id`,
 * `action` and `createdAt` to prove itself with.
 */
export const customerAuditSchema = z.object({
  contact: z
    .object({ id: z.string(), displayName: z.string().nullable().default(null) })
    .nullable(),
  data: z.array(auditEventSchema),
  nextCursor: z.string().nullable(),
  coverage: auditCoverageSchema,
  scope: auditScopeSchema,
});
export type CustomerAudit = z.infer<typeof customerAuditSchema>;
