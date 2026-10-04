/**
 * "Edit amount" on an approval.
 *
 * An approver may LOWER the amount of a money-moving action before approving
 * it - refund 179 as 120 - or the percentage of a discount, 20% as 10%. That
 * is all. It is not a general params editor: the
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
export type EditUnit = AmountUnit | "percent";
export type EditField = "amount" | "percentage";

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

/**
 * tool -> the params key `edits.percentage` writes. Shopify's discount and
 * coupon tools carry no amount at all - only a percentage off - so lowering a
 * discount means lowering this.
 */
export const EDITABLE_PERCENTAGE_TOOLS: Readonly<Record<string, { key: string }>> = {
  "shopify.create_discount_code": { key: "percentage" },
  "shopify.create_one_time_coupon": { key: "percentage" },
  "shopify.create_vip_coupon": { key: "percentage" },
  "shopify.issue_compensation_coupon": { key: "percentage" },
};

/** The only edit fields the contract knows. */
const EDIT_FIELDS = new Set<EditField>(["amount", "percentage"]);

export type EditResult =
  | { ok: true; params: Record<string, unknown>; edit: { field: EditField; key: string; from: number; to: number; unit: EditUnit } }
  | { ok: false; status: 400; error: string; message: string };

const refuse = (error: string, message: string): EditResult => ({ ok: false, status: 400, error, message });

/** At most 2 decimals. Tolerance, not equality: 120.1 * 100 is 12010.000000000002. */
const twoDecimals = (n: number) => Math.abs(Math.round(n * 100) - n * 100) <= 1e-6;

/**
 * Validate `edits` against the approval's tool and ORIGINAL params, and return
 * the params to dispatch. Pure: no I/O, so the whole rule is testable.
 * One field per request: each listed tool has exactly one editable field.
 */
export function applyApprovalEdits(tool: string, original: Record<string, unknown>, edits: unknown): EditResult {
  if (edits == null || typeof edits !== "object" || Array.isArray(edits)) {
    return refuse("invalid_edits", "edits must be an object");
  }
  const fields = Object.keys(edits as object);
  if (fields.length === 0) return refuse("invalid_edits", "edits is empty");
  const unknown = fields.filter((f) => !EDIT_FIELDS.has(f as EditField));
  if (unknown.length) {
    return refuse("edit_not_allowed", `only amount or percentage can be edited before approval (got: ${unknown.join(", ")})`);
  }
  if (fields.length > 1) return refuse("edit_not_allowed", "edit one field at a time");

  const field = fields[0] as EditField;
  return field === "amount"
    ? editAmount(tool, original, (edits as any).amount)
    : editPercentage(tool, original, (edits as any).percentage);
}

function editAmount(tool: string, original: Record<string, unknown>, to: unknown): EditResult {
  const spec = EDITABLE_AMOUNT_TOOLS[tool];
  if (!spec) return refuse("edit_not_allowed", `the amount of "${tool}" cannot be edited before approval`);

  if (typeof to !== "number" || !Number.isFinite(to)) return refuse("invalid_amount", "amount must be a number");
  if (to <= 0) return refuse("invalid_amount", "amount must be greater than 0");
  if (spec.unit === "minor" ? !Number.isInteger(to) : !twoDecimals(to)) {
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

function editPercentage(tool: string, original: Record<string, unknown>, to: unknown): EditResult {
  const spec = EDITABLE_PERCENTAGE_TOOLS[tool];
  if (!spec) return refuse("edit_not_allowed", `the percentage of "${tool}" cannot be edited before approval`);

  if (typeof to !== "number" || !Number.isFinite(to)) return refuse("invalid_percentage", "percentage must be a number");
  if (to <= 0 || to > 100) return refuse("invalid_percentage", "percentage must be greater than 0 and at most 100");
  if (!twoDecimals(to)) return refuse("invalid_percentage", "percentage may have at most 2 decimals");

  const from = original[spec.key];
  if (typeof from !== "number" || !Number.isFinite(from) || from <= 0 || from > 100) {
    return refuse("edit_requires_original_percentage", "this request has no valid percentage to edit");
  }
  if (to > from) return refuse("percentage_above_original", `percentage may only be lowered (original ${from})`);

  return {
    ok: true,
    params: { ...original, [spec.key]: to },
    edit: { field: "percentage", key: spec.key, from, to, unit: "percent" },
  };
}
