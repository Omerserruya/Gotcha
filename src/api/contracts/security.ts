import { z } from 'zod';

/**
 * Settings · Security — screen 16.
 *
 * *"Access control, plus the record of everything that happened — including
 * everything GOTCHA did."*
 *
 * Shapes read from `services/auth/src/routes/account.ts`,
 * `services/auth/src/routes/tenant-security.ts` and the Authentik mapper in
 * `packages/shared/src/lib/authentik.ts`.
 *
 * **Sessions and login history come from Authentik, not from our
 * `UserSession` table**, and the difference matters: our column is `ipHash`
 * and carries no geography, while the IdP returns a real `last_ip` and a
 * GeoIP-derived city. The screen reads the route, so it can name a city.
 *
 * Both routes answer `{ available, … }` and fall back to `available: false`
 * when the IdP cannot be reached. That flag is the distinction this project
 * has hand-rolled on five screens — *"you have none"* against *"we could not
 * find out"* — and here the backend models it for us. It is never collapsed.
 */

/**
 * One signed-in session, from `GET /api/account/sessions`.
 *
 * `current` is computed by the backend by matching the caller's IP and raw
 * user agent — Authentik's own `current` reflects the admin token that asked,
 * not the person's browser, so it is useless here and the route says so.
 */
export const sessionSchema = z.object({
  id: z.string().min(1),
  /** The device the reader is on right now. */
  current: z.boolean().default(false),
  /** A real address, not a hash. Rendered; never logged. */
  ip: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
  /** From Authentik's GeoIP. Absent when it is not configured. */
  city: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  lastUsed: z.string().nullable().optional(),
  expires: z.string().nullable().optional(),
});

export const sessionsResponseSchema = z.object({
  /** `false` = the IdP could not be reached. NOT "no sessions". */
  available: z.boolean().default(false),
  sessions: z.array(sessionSchema).default([]),
});

export type SecuritySession = z.infer<typeof sessionSchema>;

/**
 * One sign-in, from `GET /api/account/login-history`.
 *
 * This is the design's *"an unfamiliar session is flagged in the list rather
 * than in an email"* — it is where someone notices a sign-in they did not
 * make.
 *
 * The backend already drops server-side noise from it: logins from private
 * IPs and library user-agents (token refreshes, internal flows) are filtered
 * out, with a comment that the history should read *"where I signed in", not
 * server noise*. Worth knowing, because it means an empty list here is a real
 * answer rather than a filter that ate everything.
 */
export const loginEventSchema = z.object({
  id: z.string().min(1),
  action: z.string(),
  /** `false` only for `login_failed`, which is the row that matters most. */
  success: z.boolean().default(true),
  ip: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
  timestamp: z.string().nullable().optional(),
});

export const loginHistoryResponseSchema = z.object({
  available: z.boolean().default(false),
  events: z.array(loginEventSchema).default([]),
});

export type LoginEvent = z.infer<typeof loginEventSchema>;

/**
 * `GET`/`PATCH /api/tenant/security` — enveloped in `data`.
 *
 * Note the slash. The route FILE is `tenant-security.ts`; the MOUNT is
 * `/api/tenant/security`. Taking the path from the filename cost six capture
 * runs — the fetch 404s and the section simply does not render.
 *
 * Two switches, and they are the whole of the tenant's access policy that this
 * app can read. The design also asks for **SSO / Google domain**; no field for
 * it exists here, and it may be an Authentik-side setting rather than ours —
 * a question rather than a gap, and the screen draws no control for it.
 */
export const tenantSecuritySchema = z.object({
  mfaRequiredForAdmins: z.boolean().default(false),
  mfaRequiredForAllUsers: z.boolean().default(false),
});

export type TenantSecurity = z.infer<typeof tenantSecuritySchema>;

/**
 * An audit entry, from `GET /api/audit-logs`.
 *
 * `AuditLog` holds 5,159 rows on the demo tenant, 5,059 of them written by the
 * AI. Until this route existed, every one of its eleven read sites was an AI
 * service reading the log for its own reasoning — the AI could see its own
 * history and the account's owner could not.
 *
 * **`metadata` is deliberately not served.** A real row is
 * `{"args":{"phone":"+972545680665"}}`; returning the blob would put customer
 * phone numbers onto a security screen in bulk, for every lookup the AI ever
 * made. Specific non-PII fields are lifted by name instead — `succeeded` is
 * the first.
 *
 * Two things deliberately absent:
 *   - **a money filter.** There is no `amount` column. It is expressible as an
 *     enumeration of money tool names, and that is complete only until someone
 *     adds a tool — a security filter that silently narrows as the product
 *     grows is worse than none, because the reader concludes the missing rows
 *     did not happen.
 *   - **a category default.** The log conflates actions that had an effect
 *     with lookups the AI made while composing one answer, and the schema does
 *     not distinguish them. Any split we invent is a guess that drifts, so the
 *     screen shows the real action vocabulary with counts instead.
 */
export const auditEntrySchema = z.object({
  id: z.string().min(1),
  /** `user` | `ai` | `system`. */
  actorType: z.string(),
  actorId: z.string().nullable().optional(),
  /** e.g. `adapter.err.shopify.process_refund`, `ai.paused_for_approval`. */
  action: z.string(),
  /**
   * The CONVERSATION this happened in — not the business object.
   *
   * A refund row reads `conversation`; the order id lives in
   * `metadata.args.order_id` with no consistent shape across tools. So there
   * is no general "object" to name, and labelling this one would be wrong.
   */
  targetType: z.string().nullable().optional(),
  targetId: z.string().nullable().optional(),
  /**
   * Whether the action worked — and `null` is a THIRD state, not `false`.
   *
   * Lifted from `metadata.ok` by the backend. `null` means the emitter
   * recorded no verdict, which is not the same as recording a failure.
   * Collapsing them would make every un-instrumented action look like a
   * failure on a security screen, which is the reassuring-direction error
   * inverted: alarming about things that did not go wrong.
   */
  succeeded: z.boolean().nullable().optional(),
  createdAt: z.string(),
});

export const auditPageSchema = z.object({
  data: z.array(auditEntrySchema).default([]),
  nextCursor: z.string().nullable().optional(),
});

/**
 * `GET /api/audit-logs/actions` — the real action vocabulary with counts.
 *
 * The screen shows this instead of a category filter we invented. The log
 * conflates actions that had an effect with lookups the AI made while
 * composing one answer, and the schema does not distinguish them — so any
 * split we chose would be a guess that drifts as tools are added. Showing what
 * is actually in the log lets a reader navigate it without trusting our
 * taxonomy, and a new tool simply appears with its count.
 *
 * Scoped to the list's own `actorType` and window, so the numbers never
 * disagree with the rows in front of the reader. `action` is deliberately NOT
 * applied, so the facet still shows what you could switch to.
 */
export const auditFacetSchema = z.object({
  action: z.string().min(1),
  count: z.number().default(0),
});

export const auditFacetsSchema = z.object({
  data: z.array(auditFacetSchema).default([]),
  /** `true` = a 51st action really exists, verified rather than assumed. */
  truncated: z.boolean().default(false),
});

export type AuditFacet = z.infer<typeof auditFacetSchema>;

export type AuditEntry = z.infer<typeof auditEntrySchema>;

/** `DELETE /api/account/sessions[/:id]` answers `{ ok: true }`, bare. */
export const revokeResultSchema = z.object({ ok: z.boolean().default(true) });
