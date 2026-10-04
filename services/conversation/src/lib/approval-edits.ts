/**
 * "Edit amount" on an approval.
 *
 * An approver may LOWER the amount of a money-moving action before approving
 * it - refund 179 as 120. That is all. It is not a general params editor: the
 * fields are a closed list per tool, and anything else is refused.
 *
 * Why this does not go through `allowModification`: that switch governs the
 * free-form `modifiedParams` replacement, which can change WHAT runs (another
 * order, another customer). It defaults to off for every tool, so honouring it
 * here would make the feature dead on arrival. An amount edit can only narrow
 * the action the approver is already authorising - it is bounded by the
 * original amount below - and business policy still revalidates the edited
 * params before dispatch (runApprovedAction), failing closed.
 *
 * Units are the TOOL's units. Shopify and PayPal take the order currency
 * (major units, cents allowed); Stripe and Square take MINOR units (integer
 * cents). Validating "2 decimals" against a Stripe amount would accept 12.5
 * cents, so each tool says which it is.
 */

export type AmountUnit = "major" | "minor";

/** tool -> the params key `edits.amount` writes, and its unit. */
export const EDITABLE_AMOUNT_TOOLS: Readonly<Record<string, { key: string; unit: AmountUnit }>> = {
  "shopify.process_refund": { key: "amount", unit: "major" },
  "paypal.refund_capture": { key: "amount", unit: "major" },
  "paypal.create_payment_link": { key: "amount", unit: "major" },
  "stripe.refund_payment": { key: "amount", unit: "minor" },
  "stripe.create_payment_link": { key: "amount", unit: "minor" },
  "square.refund_payment": { key: "amount", unit: "minor" },
  "square.create_payment_link": { key: "amount", unit: "minor" },
};

/** The only edit fields the contract knows. */
const EDIT_FIELDS = new Set(["amount"]);

export type EditResult =
  | { ok: true; params: Record<string, unknown>; edit: { field: "amount"; key: string; from: number; to: number; unit: AmountUnit } }
  | { ok: false; status: 400; error: string; message: string };

const refuse = (error: string, message: string): EditResult => ({ ok: false, status: 400, error, message });

/**
 * Validate `edits` against the approval's tool and ORIGINAL params, and return
 * the params to dispatch. Pure: no I/O, so the whole rule is testable.
 */
export function applyApprovalEdits(tool: string, original: Record<string, unknown>, edits: unknown): EditResult {
  if (edits == null || typeof edits !== "object" || Array.isArray(edits)) {
    return refuse("invalid_edits", "edits must be an object");
  }
  const fields = Object.keys(edits as object);
  if (fields.length === 0) return refuse("invalid_edits", "edits is empty");
  const unknown = fields.filter((f) => !EDIT_FIELDS.has(f));
  if (unknown.length) {
    return refuse("edit_not_allowed", `only amount can be edited before approval (got: ${unknown.join(", ")})`);
  }

  const spec = EDITABLE_AMOUNT_TOOLS[tool];
  if (!spec) return refuse("edit_not_allowed", `the amount of "${tool}" cannot be edited before approval`);

  const to = (edits as any).amount;
  if (typeof to !== "number" || !Number.isFinite(to)) return refuse("invalid_amount", "amount must be a number");
  if (to <= 0) return refuse("invalid_amount", "amount must be greater than 0");
  // Tolerance, not equality: 120.1 * 100 is 12010.000000000002 in floating point.
  if (spec.unit === "minor" ? !Number.isInteger(to) : Math.abs(Math.round(to * 100) - to * 100) > 1e-6) {
    return refuse(
      "invalid_amount",
      spec.unit === "minor" ? "this tool takes the amount in minor units (a whole number)" : "amount may have at most 2 decimals",
    );
  }

  // The bound. A full refund (no amount) has no number here to stay under, and
  // the order total is not known to this service - so it is refused rather
  // than guessed. Absent is not "anything goes".
  const from = original[spec.key];
  if (typeof from !== "number" || !Number.isFinite(from) || from <= 0) {
    return refuse("edit_requires_original_amount", "this request has no amount to edit (for example, a full refund)");
  }
  if (to > from) return refuse("amount_above_original", `amount may only be lowered (original ${from})`);

  return {
    ok: true,
    params: { ...original, [spec.key]: to },
    edit: { field: "amount", key: spec.key, from, to, unit: spec.unit },
  };
}
