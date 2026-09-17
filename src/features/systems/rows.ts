import {
  isFailing,
  resolveStance,
  toolSlugOf,
  type CapabilityStance,
  type Integration,
  type ToolPermission,
} from '@/api/contracts/integrations';

/**
 * What screen 14 renders, from what the two reads returned.
 *
 * Pure. The component decides how a row reads in Hebrew; this decides what a
 * row IS — and in particular what a capability is actually permitted to do,
 * which is the one thing on this screen that can be confidently wrong.
 */

export interface CapabilityRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  /**
   * `null` when the policy read failed.
   *
   * Not `allow`, and not `never`. We do not know, and a screen that guesses
   * here is guessing about whether an AI may issue a refund.
   */
  readonly stance: CapabilityStance | null;
}

export interface SystemRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly connected: boolean;
  readonly failing: boolean;
  /** The platform's own words. Rendered as-is, never paraphrased. */
  readonly error: string | null;
  /** When the connection was last TESTED. Never captioned as a sync. */
  readonly lastCheckedAt: string | null;
  /** `null` = never tested, which is not the same as tested and fine. */
  readonly lastCheckPassed: boolean | null;
  /**
   * Whether a broken connection can be repaired from this app.
   *
   * `false` for OAuth systems: repairing one means re-authorising at the
   * provider, and the callback returns to whichever app `FRONTEND_URL` names.
   * The banner then states the failure and offers no action, which is the same
   * answer screen 13 gives for the same reason.
   */
  readonly repairableHere: boolean;
  /**
   * Whether ANY of this system's capabilities can run right now.
   *
   * The AI's tool surface requires `tenantIntegration.status === "CONNECTED"`,
   * so while a system is broken none of its capabilities are available —
   * however they are configured. That is a fact about the SYSTEM, kept here
   * rather than relabelling every capability: the panel says what the policy
   * is, and this says none of it is running.
   */
  readonly capabilitiesRunning: boolean;
  readonly capabilities: readonly CapabilityRow[];
}

/**
 * Policy by tool slug.
 *
 * `integration.process_refund` and `shopify.process_refund` both key on
 * `process_refund` — the backend says so, and `tool-registry` builds both
 * spellings from the same `catalogTool.slug`. A name with no dot is an
 * internal tool, not an integration capability, and is dropped.
 */
function policyBySlug(permissions: readonly ToolPermission[]): Map<string, ToolPermission> {
  const map = new Map<string, ToolPermission>();
  for (const permission of permissions) {
    const slug = toolSlugOf(permission.toolName);
    if (slug) map.set(slug, permission);
  }
  return map;
}

export function buildSystemRows(
  integrations: readonly Integration[],
  permissions: readonly ToolPermission[],
  policyLoaded: boolean,
  locale: string,
): SystemRow[] {
  const policy = policyBySlug(permissions);

  const rows: SystemRow[] = integrations
    // A system the tenant has never connected is catalogue, not configuration.
    // This screen is "your business systems", not a marketplace.
    .filter((integration) => integration.tenantConnection != null)
    .map((integration) => {
      const connection = integration.tenantConnection ?? null;
      return {
        id: integration.id,
        slug: integration.slug,
        name: integration.name,
        description: integration.description?.trim() || null,
        connected: connection?.status === 'CONNECTED',
        failing: isFailing(connection),
        error: connection?.lastError?.trim() || null,
        lastCheckedAt: connection?.lastTestedAt ?? null,
        lastCheckPassed: connection?.lastTestResult ?? null,
        repairableHere: integration.authType !== 'OAUTH2',
        capabilitiesRunning: connection?.status === 'CONNECTED',
        /*
         * A stance is only knowable while the system is CONNECTED.
         *
         * `GET /api/tool-permissions` builds its list from
         * `getAvailableTools`, which filters
         * `tenantIntegration: { status: "CONNECTED" }`. So a disconnected
         * system's tools are absent from that response entirely — not
         * reported as unrestricted, simply not reported.
         *
         * Falling through to the activation there would render every
         * capability as "allowed" for a system whose approval requirements we
         * were never told, and which in any case cannot run anything. Unknown
         * is the honest answer, and the row says separately that none of it is
         * running.
         */
        capabilities: integration.catalogTools.map((tool) => ({
          id: tool.id,
          slug: tool.slug,
          name: tool.name,
          stance:
            policyLoaded && connection?.status === 'CONNECTED'
              ? resolveStance(tool.enabled, policy.get(tool.slug))
              : null,
        })),
      };
    });

  /*
   * Failing systems first. A business system that stopped responding is the
   * reason someone opened this screen, and it must not sit below two healthy
   * ones. Otherwise by name, locale-aware.
   */
  const collator = new Intl.Collator(locale, { sensitivity: 'base' });
  rows.sort((a, b) => {
    if (a.failing !== b.failing) return a.failing ? -1 : 1;
    return collator.compare(a.name, b.name);
  });

  return rows;
}

/** How many capabilities of a system sit in each stance. Order is the design's. */
export function stanceCounts(row: SystemRow): {
  allow: number;
  ask: number;
  never: number;
  unknown: number;
} {
  const counts = { allow: 0, ask: 0, never: 0, unknown: 0 };
  for (const capability of row.capabilities) {
    if (capability.stance === null) counts.unknown += 1;
    else counts[capability.stance] += 1;
  }
  return counts;
}

/**
 * The readable part of a platform error.
 *
 * Shopify's is `token_refresh_failed:shopify_token_refresh_failed_401:` and
 * then an entire HTML document, truncated mid-tag at 200 characters. The
 * useful sentence is at the front; the rest is the body of a response that
 * happened to be concatenated onto it.
 *
 * This is NOT paraphrasing, and the distinction is the whole reason it is
 * allowed: not one word is rewritten. It declines to render a fragment of a
 * markup document as if it were prose, and it stops only at `<!` or `<html`,
 * the two unambiguous starts of one. An error that legitimately contains a
 * `<` — "value < 10" — is untouched.
 *
 * If nothing readable precedes the markup, the original is returned whole: a
 * strange message is still better than an empty one.
 */
export function messageOf(error: string | null): string | null {
  if (!error) return null;
  const markup = error.search(/<!|<html/i);
  if (markup < 0) return error;
  const readable = error.slice(0, markup).trim();
  return readable.length > 0 ? readable : error;
}
