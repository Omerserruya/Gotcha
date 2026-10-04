import { z } from 'zod';

/**
 * Settings · Business systems — screen 14.
 *
 * *"Platform config, no AI behaviour."*
 *
 * Shapes read from `services/ai/src/routes/integrations.ts`.
 *
 * Two things the design draws that nothing behind them can produce:
 *
 *   - **"11 exchange requests are waiting."** Nothing queues or holds work
 *     when an integration fails — there is no held-work table and no retry
 *     queue anywhere. `ApprovalRequest` is a different concept: work paused
 *     awaiting a HUMAN decision, not work held because a platform is
 *     unreachable. The nearest real number is failed `ToolExecution` rows,
 *     which means "how many attempts failed", not "how many requests are
 *     waiting". Different cause, different remedy, and relabelling one as the
 *     other would be this screen's money limits.
 *   - **"4,180 customers synced."** There is no sync concept for integrations
 *     at all: nothing records "pulled N records at T".
 *     `source-of-truth/customers` pages at 8 (max 20) and carries no total.
 *
 * And one word to be careful with: `lastTestedAt` is a **connection test**,
 * never a sync. The screen says *last checked*. "Last synced" would read
 * identically to a user and mean something the product does not do.
 */

/** How a system authenticates. Decides whether a break is repairable here. */
export const AUTH_TYPES = ['API_KEY', 'OAUTH2', 'BASIC_AUTH', 'WEBHOOK', 'CUSTOM'] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

/** `ConnectionStatus`. `TESTING` is transient — a test in flight. */
export const INTEGRATION_STATES = [
  'PENDING',
  'TESTING',
  'CONNECTED',
  'ERROR',
  'DISCONNECTED',
] as const;
export type IntegrationState = (typeof INTEGRATION_STATES)[number];

/**
 * Is this one of the five states we have a name for?
 *
 * The column is `z.enum(...).catch('PENDING')`, so a parsed value is always in
 * range — but the rail also renders connections from a second read whose shape
 * is looser, and an unrecognised value must say "status unknown" rather than
 * print itself. A reader cannot act on a code.
 */
export function isIntegrationState(value: string): value is IntegrationState {
  return (INTEGRATION_STATES as readonly string[]).includes(value);
}

/**
 * What a capability is allowed to do, as the design's tri-state.
 *
 * Not an approximation of a boolean — the model really does store three
 * outcomes, across two rows:
 *
 *   `never`  — `TenantTool.isEnabled = false`
 *   `ask`    — enabled, and `requiresApproval`, so running it creates an
 *              `ApprovalRequest` and the conversation is held for a human
 *   `allow`  — enabled, no approval required
 *
 * `CatalogTool.hitlPolicy` seeds it and the tenant row is authoritative over
 * the seed: it can tighten or loosen.
 */
export const CAPABILITY_STANCES = ['allow', 'ask', 'never'] as const;
export type CapabilityStance = (typeof CAPABILITY_STANCES)[number];

/**
 * One capability of one system.
 *
 * `name` and `description` are human-written prose on `CatalogTool`, which is
 * why *"never show raw scopes"* needs no filtering here: this API does not
 * deal in scopes. The screen renders what a person gains, because that is what
 * the backend stores.
 */
export const capabilitySchema = z
  .object({
    id: z.string().min(1),
    slug: z.string().min(1),
    name: z.string().min(1),
    riskLevel: z.string().nullable().optional(),
    /** Present only once the tenant has activated this tool. */
    tenantTool: z
      .object({ id: z.string().min(1), isEnabled: z.boolean().default(true) })
      .nullable()
      .optional(),
  })
  .transform((raw) => ({
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    riskLevel: raw.riskLevel ?? null,
    /**
     * A tool the tenant has never activated is `never` — it cannot run.
     *
     * The `ask` half needs `TenantToolPermission`, which this route does not
     * join, so it is resolved separately where the panel needs it rather than
     * guessed here.
     */
    enabled: raw.tenantTool?.isEnabled ?? false,
  }));

export type Capability = z.infer<typeof capabilitySchema>;

/**
 * The tenant's connection to one system.
 *
 * **`credentials` is deliberately absent.** `GET /integrations/:slug` selects
 * and returns it — the stored integration secret, encrypted but still a
 * secret — while the sibling list route excludes it with a comment saying no
 * list view needs it. Naming fields explicitly is what keeps it out of this
 * app regardless of which route we call.
 *
 * The three health fields are optional because **no route serves them yet**.
 * Every mention of them in the routes file is a write: `/test` records what
 * failed, when and whether, in six places, and nothing reads them back. A
 * contract is with the backend; absent must render as absent until it lands,
 * never as "fine".
 */
export const connectionSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(INTEGRATION_STATES).catch('PENDING'),
    createdAt: z.string().nullable().optional(),
    /** When the connection was last TESTED. Not a sync. */
    lastTestedAt: z.string().nullable().optional(),
    /** `null` = never tested, which is not the same as tested and fine. */
    lastTestResult: z.boolean().nullable().optional(),
    /** The platform's own words, truncated to 200 chars by the backend. */
    lastError: z.string().nullable().optional(),
    /**
     * The connection's config. ONE field is read from it — Shopify's
     * `shopDomain`, 14d's "avivco.myshopify.com" — and the transform drops the
     * rest: config can hold more than a page needs, and nothing else of it
     * leaves this contract.
     */
    config: z.unknown().optional(),
  })
  .transform(({ config, ...rest }) => {
    const shop =
      typeof config === 'object' && config !== null
        ? (config as { shopDomain?: unknown }).shopDomain
        : undefined;
    return { ...rest, shopDomain: typeof shop === 'string' && shop.trim() ? shop.trim() : null };
  });

/**
 * `GET /api/integrations` — enveloped in `data`.
 *
 * **`object`, not `looseObject`.** The route spreads the whole catalog entry,
 * which carries `authSchema` and `configSchema` — shape descriptions the
 * screen never renders — and the detail route spreads `credentials` too.
 * Naming what we use is the standing rule on this project, and this is the
 * fourth route it has caught handing out more than a page needs.
 */
/** One credential a system asks for, as `authSchema.fields` describes it. */
export const credentialFieldSchema = z.object({
  key: z.string().min(1),
  /** `text` · `url` · `password` · `select`; anything else is typed text. */
  type: z.enum(['text', 'url', 'password', 'select']).catch('text'),
  label: z.string().min(1),
  required: z.boolean().catch(false).default(false),
  options: z.array(z.string()).optional(),
  placeholder: z.string().optional(),
  default: z.string().optional(),
});
export type CredentialField = z.infer<typeof credentialFieldSchema>;

/**
 * How a system is connected, from `authSchema` — and ONLY that.
 *
 * ★ `authSchema` also carries `scopes` (raw OAuth scopes) and `helpText`
 * (Airtable's names the scopes it needs). Neither may reach a screen, so the
 * transform reads `oauth` and `fields` and nothing else leaves this contract.
 *
 * `oauth` is the schema's own flag, not `authType`: Airtable is typed
 * `OAUTH2` and connects with a pasted token, and its schema says so. A field
 * that fails to parse drops the form to none rather than the whole catalogue.
 */
export const connectSchema = z
  .unknown()
  .optional()
  .transform((raw) => {
    const schema = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const fields = z.array(credentialFieldSchema).safeParse(schema.fields ?? []);
    return {
      oauth: schema.oauth === true,
      fields: fields.success ? fields.data : [],
    };
  });
export type ConnectShape = z.infer<typeof connectSchema>;

export const integrationSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  logoUrl: z.string().nullable().optional(),
  docsUrl: z.string().nullable().optional(),
  /**
   * How this system authenticates — and therefore whether a broken one can be
   * repaired from here.
   *
   * `OAUTH2` means repair is a re-authorisation at the provider, which is
   * screen 13's blocker all over again: the callback returns to whichever app
   * `FRONTEND_URL` names, and that is not this one. Anything else is
   * credentials that can be replaced in place via `PUT /:slug/credentials`,
   * which touches no tool activation and destroys no per-agent narrowing.
   *
   * `authSchema` sits beside this on the wire and carries the raw OAuth
   * `scopes`, which this screen may never show — so it is read through
   * `connectSchema`, which keeps `oauth` and `fields` and drops the rest.
   */
  authType: z.enum(AUTH_TYPES).catch('CUSTOM'),
  /** `authSchema` on the wire, reduced to what a Connect form needs. */
  authSchema: connectSchema,
  catalogTools: z.array(capabilitySchema).default([]),
  tenantConnection: connectionSchema.nullable().optional(),
});

export const integrationsSchema = z.array(integrationSchema);
export type Integration = z.infer<typeof integrationSchema>;

/**
 * A system that needs attention.
 *
 * `status` alone is not enough, for the same reason it was not on screen 13:
 * a connection can carry a failed test while its status still reads
 * `CONNECTED`. The demo tenant's Shopify row is `ERROR` *and* carries a
 * token-refresh failure, but the two can disagree and the failure is the fact
 * that matters.
 */
export function isFailing(
  connection: z.infer<typeof connectionSchema> | null | undefined,
): boolean {
  if (!connection) return false;
  return (
    connection.status === 'ERROR' ||
    connection.lastTestResult === false ||
    (connection.lastError?.trim().length ?? 0) > 0
  );
}

// ── Tool policy, which is a second read and the authoritative one ────

/**
 * `GET /api/tool-permissions` — enveloped in `data`.
 *
 * **`object`, not `looseObject`, and here it is a product rule as well as a
 * security one.** The route also returns `grantedScopes` and `missingScopes`
 * — raw OAuth scopes — and this screen may never show those: *"What it can
 * do"* speaks in what an employee gains. Not naming them strips them in the
 * API layer, so no component can render them by accident.
 *
 * `toolName` is `integration.<slug>` for a catalog tool, or
 * `<provider>.<slug>` where an adapter exists (`shopify.cancel_order`). Both
 * key on the slug — the backend says so itself. A name with no dot is an
 * internal tool and not an integration capability at all.
 */
export const toolPermissionSchema = z.object({
  toolName: z.string().min(1),
  enabled: z.boolean().default(true),
  requiresApproval: z.boolean().default(false),
});

export const toolPermissionsSchema = z.array(toolPermissionSchema);
export type ToolPermission = z.infer<typeof toolPermissionSchema>;

/** `integration.process_refund` and `shopify.process_refund` → `process_refund`. */
export function toolSlugOf(toolName: string): string | null {
  const dot = toolName.lastIndexOf('.');
  if (dot < 0) return null;
  const slug = toolName.slice(dot + 1).trim();
  return slug.length > 0 ? slug : null;
}

/**
 * What a capability may actually do.
 *
 * ── WHAT GATES AN INTEGRATION TOOL, ESTABLISHED FROM THE RUNTIME ──
 * The AI's tool surface is built by exactly one query
 * (`tool-registry.ts`, `getAvailableTools`):
 *
 *     tenantTool.findMany({ isEnabled: true,
 *                           tenantIntegration: { status: "CONNECTED" } })
 *
 * So activation plus a live connection is what decides whether a capability
 * can run at all. Approval, when required, comes from
 * `TenantTool.configOverrides.hitlPolicy` falling back to the
 * `CatalogTool.hitlPolicy` seed — which is what `GET /api/tool-permissions`
 * reports as `requiresApproval`.
 *
 * ── THE TRAP, AND IT IS THE OPPOSITE OF WHAT IT LOOKS LIKE ──
 * `TenantToolPermission` has a row `integration.process_refund` with
 * `enabled = false`, and it is tempting to treat that as an owner switching a
 * refund tool off. **Nothing enforces it for integration tools.** No execution
 * path reads that table at all — only routes do — and
 * `GET /api/tool-permissions` hardcodes `enabled: true` for every integration
 * tool it returns, because the surface is already filtered by `isEnabled`.
 *
 * So rendering that row as *Never* would report a restriction the runtime does
 * not apply: wrong in the CAUTIOUS direction, which is better than the
 * reassuring one and still a false statement about what the AI may do. It is
 * the same shape as the hand-set `tenant_features` rows on screen 13 — a table
 * that looks authoritative and is consulted by nothing.
 *
 * `enabled` on a `ToolPermission` is therefore deliberately unused here.
 */
export function resolveStance(
  activated: boolean,
  policy: ToolPermission | undefined,
): CapabilityStance {
  if (!activated) return 'never';
  return policy?.requiresApproval ? 'ask' : 'allow';
}

/* ── Screen 10's left rail: what is connected, and what could be ─────────── */

/**
 * Connected means there is a tenant connection row, whatever state it is in.
 *
 * ★ A BROKEN CONNECTION IS STILL CONNECTED. `status: "ERROR"` belongs in the
 * connected list with its error showing — moving it to "available" would
 * offer a Connect button for something already connected, which is the
 * distinction 14c, 04d and 05d each had to make separately.
 */
export function isConnected(entry: Integration): boolean {
  return Boolean(entry.tenantConnection);
}

/**
 * The two lists the design's rail is made of.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE COUNT IS WHATEVER THE TABLE HOLDS, AND THE DESIGN SAYS 58
 * ════════════════════════════════════════════════════════════════════════════
 * `IntegrationCatalog` has **17 published rows on dev**. The design draws
 * "Available · 58" and names ten providers, most of which have no row.
 *
 * This returns what is there. Padding the list to match the design — or
 * printing 58 above a list of 17 — would imply coverage the product does not
 * have, which is the same defect as a knowledge counter made of candidates
 * nobody accepted. Each missing provider is a catalogue row plus an adapter,
 * and that is a decision for Omer rather than a gap to paper over.
 */
export function splitCatalogue(entries: readonly Integration[]): {
  readonly connected: readonly Integration[];
  readonly available: readonly Integration[];
} {
  return {
    connected: entries.filter(isConnected),
    available: entries.filter((e) => !isConnected(e)),
  };
}

/**
 * Available entries grouped by category, in the catalogue's own order.
 *
 * `category` is a stored column the route sorts by `sortOrder`, so the groups
 * arrive in the order somebody chose rather than alphabetically. An entry
 * with no category goes in its own bucket rather than being assigned one —
 * inventing a category is how a filter starts lying about what it contains.
 */
export function byCategory(
  entries: readonly Integration[],
): readonly { readonly category: string | null; readonly entries: readonly Integration[] }[] {
  const order: (string | null)[] = [];
  const buckets = new Map<string | null, Integration[]>();
  for (const entry of entries) {
    const key = entry.category?.trim() || null;
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(entry);
  }
  return order.map((category) => ({ category, entries: buckets.get(category)! }));
}

/**
 * The catalogue names its actions in two cases ("Cancel Order", "Add order
 * note"); the product writes sentence case. Acronyms (VIP, ETA) and the
 * system's own name stay as they are.
 */
export function sentenceCase(name: string, keep: string | null): string {
  return name
    .split(' ')
    .map((word, i) => {
      if (/^[A-Z0-9]{2,}$/.test(word) || (keep !== null && word === keep)) return word;
      const lower = word.toLowerCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
}
