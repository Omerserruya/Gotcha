/**
 * Tool Contracts — first-class, declarative source of truth for what a tool
 * REQUIRES before it may execute.
 *
 * Two concerns, deliberately split to their correct owners:
 *
 *   1. requiredInputs (THIS file) — the inputs a tool genuinely needs from the
 *      customer before it can run. Enforced at dispatch as defense-in-depth ON
 *      TOP of each tool's JSON-schema `required` (see `missingRequiredArgs` in
 *      ai-bot.service.ts). The schema gate covers well-formed core tools; this
 *      registry covers INTEGRATION/catalog tools whose per-tenant schemas we do
 *      NOT control and may declare nothing as required - so a refund can't fire
 *      without an order id even if the tenant's CatalogTool schema is sloppy.
 *
 *   2. approvalPolicy (NOT here) — whether an action needs human approval. That
 *      already has a canonical, tenant-overridable, args-aware home: the shared
 *      HITL gate (`SYSTEM_TOOL_POLICIES` + `hitlPolicy` with the CEL-lite
 *      `on_condition` evaluator) in `@chatcenter/shared/lib/tool-gate.ts`.
 *      Duplicating threshold logic here would violate the orchestrator's
 *      single-source-of-truth rule, so we DON'T. Financial tools (refund,
 *      discount) are floored to `always` there per CLAUDE.md §9.
 *
 * Intentionally NOT listed: `schedule_meeting`. Its schema is all-optional BY
 * DESIGN - the GoogleCalendarAdapter proposes slots, so the bot can book with
 * minimal args. Hard-requiring date/time/email would regress the propose-slots
 * flow. Its risk is handled by the HITL gate (`on_condition` > 60min), not here.
 */

export type MissingInputStrategy = "ask_one_at_a_time" | "ask_all";

export interface ToolContract {
  tool: string;
  /** Inputs that MUST be present (non-empty) before the tool may execute. */
  requiredInputs: string[];
  /** How the bot should collect missing inputs when the gate blocks. */
  missingInputStrategy: MissingInputStrategy;
}

/**
 * Registry keyed by tool name. Seeded with the integration/catalog tools whose
 * premature execution is genuinely harmful and whose required inputs are
 * customer-supplied (must never be invented). Add a row to gate a new tool.
 */
export const TOOL_CONTRACTS: Record<string, ToolContract> = {
  check_shipment:  { tool: "check_shipment",  requiredInputs: ["order_number"], missingInputStrategy: "ask_one_at_a_time" },
  check_order:     { tool: "check_order",     requiredInputs: ["order_number"], missingInputStrategy: "ask_one_at_a_time" },
  track_order:     { tool: "track_order",     requiredInputs: ["order_number"], missingInputStrategy: "ask_one_at_a_time" },
  issue_refund:    { tool: "issue_refund",    requiredInputs: ["order_id"],     missingInputStrategy: "ask_one_at_a_time" },
  refund:          { tool: "refund",          requiredInputs: ["order_id"],     missingInputStrategy: "ask_one_at_a_time" },
  apply_discount:  { tool: "apply_discount",  requiredInputs: ["order_id"],     missingInputStrategy: "ask_one_at_a_time" },
};

function valueMissing(v: unknown): boolean {
  return (
    v === undefined ||
    v === null ||
    (typeof v === "string" && v.trim() === "") ||
    (Array.isArray(v) && v.length === 0)
  );
}

export interface ContractGateResult {
  missing: string[];
  strategy: MissingInputStrategy;
}

/**
 * Returns the contract-required inputs missing from `args` for `tool`, plus the
 * collection strategy. Empty `missing` ⇒ the contract is satisfied (or the tool
 * has no contract). Pure - safe to unit-test and to call before dispatch.
 */
export function missingContractInputs(
  tool: string,
  args: Record<string, unknown>,
): ContractGateResult {
  const contract = TOOL_CONTRACTS[tool];
  if (!contract) return { missing: [], strategy: "ask_one_at_a_time" };
  const missing = contract.requiredInputs.filter((k) => valueMissing(args?.[k]));
  return { missing, strategy: contract.missingInputStrategy };
}
