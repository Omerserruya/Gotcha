/**
 * Which system creates a return for this tenant - decided once, in one place.
 *
 * Scenario 21 was UNSUPPORTED: `returns_count: 0`, no fake RMA, and a handoff.
 * That was honest, and it was honest for a reason worth naming - nothing in the
 * product could create a return at all. Both candidate providers were
 * "connected" and neither could do it:
 *
 *   - Shopify has `read_returns` and a `get_returns` tool. `write_returns` was
 *     granted and NO TOOL USED IT (recorded in Part 3's scope matrix).
 *   - ReturnGO is a returns platform whose adapter exposes three tools:
 *     list transactions, summarise status, update a transaction. There is no
 *     create. A returns platform that cannot open a return.
 *
 * Which is exactly why this resolver reports CAPABILITIES rather than
 * connections. "ReturnGO is connected" is true and useless; "ReturnGO cannot
 * create a return" is the fact that decides what happens next. Treating a
 * connected integration as capable is how a customer gets told an RMA was
 * opened by an adapter with no endpoint for it.
 *
 * Exactly one provider creates any given return. Both are allowed to be READ
 * for status - neither source alone is complete - but creation has a single
 * owner, chosen deterministically, so a return can never be opened twice.
 */

import { loadConnection, capabilityStateFromConfig } from "./connectors/integration-framework";

export type ReturnProviderName = "shopify" | "returngo" | "none";

export interface ReturnProviderCapabilities {
  provider: ReturnProviderName;
  connected: boolean;
  supportsCreateReturn: boolean;
  supportsExchange: boolean;
  supportsRefund: boolean;
  supportsLabels: boolean;
  supportsStatus: boolean;
  supportsEvidenceUpload: boolean;
  supportsWebhookUpdates: boolean;
  /** Why this provider was chosen, or why nothing was. */
  reason: string;
  /** Providers that can answer STATUS questions, which may be more than one. */
  statusProviders: ReturnProviderName[];
}

/**
 * Explicit selection wins over inference.
 *
 * A merchant running both platforms has an opinion, and guessing at it is how
 * a return gets opened in the system nobody is watching. `config.returnProvider`
 * on either integration is the switch; absent one, the precedence below is
 * capability-first and therefore self-correcting - a provider that gains a
 * create endpoint becomes eligible without a config change.
 */
function explicitSelection(
  config: Record<string, any> | null | undefined,
): Exclude<ReturnProviderName, "none"> | null {
  const v = String(config?.returnProvider ?? "").toLowerCase().trim();
  if (v === "shopify" || v === "returngo") return v;
  return null;
}

/**
 * ReturnGO's real surface, not its brochure.
 *
 * Every flag here is false except the two the adapter actually implements. If
 * a create endpoint is added to `returngo.adapter.ts`, this is the line that
 * changes - and it must change HERE rather than being inferred, because the
 * whole failure mode being prevented is inferring capability from existence.
 */
function returnGoCapabilities(connected: boolean): ReturnProviderCapabilities {
  return {
    provider: "returngo",
    connected,
    supportsCreateReturn: false,
    supportsExchange: false,
    supportsRefund: false,
    supportsLabels: false,
    supportsStatus: connected,
    supportsEvidenceUpload: false,
    supportsWebhookUpdates: false,
    reason: connected
      ? "ReturnGO is connected but its adapter has no create-return operation - only transaction reads and updates."
      : "ReturnGO is not connected.",
    statusProviders: [],
  };
}

function shopifyCapabilities(connected: boolean, granted: string[]): ReturnProviderCapabilities {
  // read_returns does NOT imply write_returns. They are separate grants, and a
  // store can read every RMA it has while being unable to open one.
  const canCreate = connected && granted.includes("write_returns");
  return {
    provider: "shopify",
    connected,
    supportsCreateReturn: canCreate,
    supportsExchange: false,
    supportsRefund: connected && granted.includes("write_orders"),
    supportsLabels: false,
    supportsStatus: connected && granted.includes("read_returns"),
    supportsEvidenceUpload: false,
    supportsWebhookUpdates: false,
    reason: !connected
      ? "Shopify is not connected."
      : canCreate
        ? "Shopify native returns: connected with write_returns."
        : "Shopify is connected but the store has not granted write_returns, so it cannot open a return.",
    statusProviders: [],
  };
}

const NO_PROVIDER: ReturnProviderCapabilities = {
  provider: "none",
  connected: false,
  supportsCreateReturn: false,
  supportsExchange: false,
  supportsRefund: false,
  supportsLabels: false,
  supportsStatus: false,
  supportsEvidenceUpload: false,
  supportsWebhookUpdates: false,
  reason: "No connected integration can create a return for this tenant.",
  statusProviders: [],
};

/**
 * Pure selection, given what each provider can do. Separated from the I/O so
 * the precedence is testable without a database.
 */
export function selectReturnProvider(
  shopify: ReturnProviderCapabilities,
  returngo: ReturnProviderCapabilities,
  explicit: Exclude<ReturnProviderName, "none"> | null,
): ReturnProviderCapabilities {
  const statusProviders: ReturnProviderName[] = [];
  if (returngo.supportsStatus) statusProviders.push("returngo");
  if (shopify.supportsStatus) statusProviders.push("shopify");

  const byName = { shopify, returngo } as const;

  // An explicit choice is honoured only when it can actually do the job.
  // Silently falling through to the other provider would open the return in
  // the system the merchant did not choose, which is worse than refusing.
  if (explicit) {
    const chosen = byName[explicit];
    if (chosen.supportsCreateReturn) return { ...chosen, statusProviders };
    return {
      ...NO_PROVIDER,
      statusProviders,
      reason: `${explicit} is selected as the return provider but cannot create a return: ${chosen.reason}`,
    };
  }

  if (returngo.supportsCreateReturn) return { ...returngo, statusProviders };
  if (shopify.supportsCreateReturn) return { ...shopify, statusProviders };
  return {
    ...NO_PROVIDER,
    statusProviders,
    reason: `No return provider can create a return. ${shopify.reason} ${returngo.reason}`.trim(),
  };
}

/**
 * The tenant's return provider, resolved from live connection state.
 *
 * Never throws: an unreachable database or a decryption failure resolves to
 * "none", which routes to a real human handoff. Failing toward a person is the
 * only safe direction - failing toward a provider we could not verify is how a
 * customer is told a return exists that does not.
 */
export async function getReturnProvider(tenantId: string): Promise<ReturnProviderCapabilities> {
  let shopifyConn: Awaited<ReturnType<typeof loadConnection>> = null;
  let returngoConn: Awaited<ReturnType<typeof loadConnection>> = null;
  try {
    [shopifyConn, returngoConn] = await Promise.all([
      loadConnection({ tenantId, slug: "shopify" }),
      loadConnection({ tenantId, slug: "returngo" }),
    ]);
  } catch (err: any) {
    console.warn("[return-provider] could not read connections:", err?.message);
    return { ...NO_PROVIDER, reason: "Return provider state could not be read, so no automated return is possible." };
  }

  const shopify = shopifyCapabilities(
    !!shopifyConn,
    capabilityStateFromConfig(shopifyConn?.config).grantedScopes,
  );
  const returngo = returnGoCapabilities(!!returngoConn);
  const explicit = explicitSelection(shopifyConn?.config) ?? explicitSelection(returngoConn?.config);

  return selectReturnProvider(shopify, returngo, explicit);
}

/**
 * What the model is told about returns this turn.
 *
 * The "no provider" branch carries the most instruction because it is the one
 * that produced a lie before: with nothing able to open a return, the model
 * said a request had been passed to the team. A note, a tag and a Shopify
 * customer record all leave the customer waiting for someone who has not been
 * asked.
 */
export function buildReturnDirective(caps: ReturnProviderCapabilities): string {
  const lines = [`The customer is asking to return or replace something they received.`];

  if (caps.supportsCreateReturn && caps.provider === "shopify") {
    lines.push(
      `Returns for this store are created in Shopify. Use create_return against the order's fulfilled line items.`,
      `Check first whether a return already exists for those items (get_returns) - do NOT open a second one for the same request.`,
      `Only after create_return returns a real return id may you say a return was opened, and you must give them that id.`,
    );
  } else if (caps.supportsCreateReturn && caps.provider === "returngo") {
    lines.push(
      `Returns for this store are created in ReturnGO. Use the ReturnGO tools only - do NOT also create a Shopify return for the same request.`,
      `Only after the provider returns a real case id may you say a return was opened, and you must give them that id.`,
    );
  } else {
    lines.push(
      `NO system connected to this conversation can open a return: ${caps.reason}`,
      `So you must NOT say a return, RMA or case was opened, and you must NOT say a request was "passed on".`,
      `Gather what a person will need - order, item, quantity, reason, and a photo if it is a damage or wrong-item claim - and then create a REAL handoff.`,
      `Tell the customer a person is taking it over only AFTER the handoff tool has returned success. A note or a tag on the order reaches nobody.`,
    );
  }

  if (caps.statusProviders.length) {
    lines.push(
      `For the STATUS of an existing return you may read ${caps.statusProviders.join(" and ")}; combining both is fine, since neither is complete on its own.`,
    );
  }
  return lines.join("\n");
}
