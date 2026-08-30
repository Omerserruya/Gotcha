/**
 * Discounts, on Admin GraphQL.
 *
 * Family 6, and the one place where REST and GraphQL genuinely do not describe
 * the same object. REST had a PRICE RULE with a DISCOUNT CODE attached to it -
 * two resources, two ids, two calls to create one coupon. GraphQL has a single
 * `DiscountCodeNode`, and there is no price rule to fetch.
 *
 * ── What that means for the shapes ──
 *
 * `price_rule_id` survives as a FIELD NAME, carrying the numeric id of the
 * discount node. Nothing outside this integration interprets it: it is handed
 * back by `lookupDiscountCode` and passed straight into deactivation, so
 * renaming it would churn the tool surface for no gain, and dropping it would
 * break the compensation-coupon idempotency check that looks a code up before
 * creating it.
 *
 * `value` keeps REST's convention - a NEGATIVE decimal string alongside a
 * `value_type` - because that is what the model has been reading. GraphQL
 * expresses a 10% discount as `percentage: 0.1`, so the translation is
 * `0.1 → "-10.0"`, not a passthrough.
 *
 * ── One behavioural improvement, taken deliberately ──
 *
 * Disabling a coupon used to mean writing `ends_at: now` onto the price rule -
 * a code with a past expiry. `discountCodeDeactivate` is the supported
 * operation and says what it means. The outcome a customer sees is the same
 * (the code stops working) and the admin now shows it as deactivated rather
 * than as expiring at an odd timestamp.
 */
import { shopifyGraphQLRequest, paginate, toGid, numericId, type ShopifyCtx } from "./shopify-graphql";

const DISCOUNT_FIELDS = `
  title
  status
  startsAt
  endsAt
  usageLimit
  asyncUsageCount
  codes(first: 1) { nodes { code } }
  context {
    __typename
    ... on DiscountCustomers { customers { legacyResourceId } }
  }
  customerGets {
    value {
      ... on DiscountPercentage { percentage }
      ... on DiscountAmount { amount { amount } }
    }
  }`;

const DISCOUNT_BY_CODE = `
  query GotchaDiscountByCode($code: String!) {
    codeDiscountNodeByCode(code: $code) {
      id
      codeDiscount { ... on DiscountCodeBasic { ${DISCOUNT_FIELDS} } }
    }
  }`;

const DISCOUNT_LIST = `
  query GotchaDiscountList($first: Int!, $after: String) {
    discountNodes(first: $first, after: $after) {
      nodes {
        id
        discount { ... on DiscountCodeBasic { ${DISCOUNT_FIELDS} } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const DISCOUNT_CREATE = `
  mutation GotchaDiscountCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode { id }
      userErrors { field message code }
    }
  }`;

const DISCOUNT_DEACTIVATE = `
  mutation GotchaDiscountDeactivate($id: ID!) {
    discountCodeDeactivate(id: $id) {
      codeDiscountNode {
        id
        codeDiscount { ... on DiscountCodeBasic { title status endsAt } }
      }
      userErrors { field message code }
    }
  }`;

export interface DiscountSummary {
  /** The discount node's numeric id, under the name REST used for its handle. */
  price_rule_id: number | null;
  id: number | null;
  title: string | null;
  code: string | null;
  /** REST's convention: a negative decimal string. */
  value: string | null;
  /** "percentage" | "fixed_amount", as REST reported it. */
  value_type: string | null;
  starts_at: string | null;
  ends_at: string | null;
  usage_limit: number | null;
  usage_count: number;
  status: string | null;
  /** Numeric customer ids this discount is restricted to, empty when it is open to all. */
  prerequisite_customer_ids: number[];
  /** REST's word for the same thing: "all" or "prerequisite". */
  customer_selection: string;
}

/**
 * A discount node in the shape the tools already return.
 *
 * `nodeId` is the gid, which is the only handle the deactivate mutation takes;
 * the numeric id is what the tool surface and the model see.
 */
export function mapDiscount(nodeId: string | null, d: any): DiscountSummary | null {
  if (!d) return null;
  const customers = (d.context?.customers || []).map((c: any) => Number(c?.legacyResourceId)).filter(Number.isFinite);
  const id = numericId({ id: nodeId ?? undefined });
  return {
    price_rule_id: id,
    id,
    title: d.title ?? null,
    code: d.codes?.nodes?.[0]?.code ?? null,
    ...mapValue(d.customerGets?.value),
    starts_at: d.startsAt ?? null,
    ends_at: d.endsAt ?? null,
    usage_limit: d.usageLimit ?? null,
    usage_count: Number(d.asyncUsageCount ?? 0) || 0,
    status: d.status ? String(d.status).toLowerCase() : null,
    prerequisite_customer_ids: customers,
    customer_selection: customers.length ? "prerequisite" : "all",
  };
}

/**
 * REST's `value` / `value_type` from GraphQL's discount value union.
 *
 * The percentage is a FRACTION in GraphQL (0.1 for 10%) and was a signed
 * percentage string in REST ("-10.0"). Passing the fraction through would tell
 * a customer their coupon is worth 0.1% off.
 */
function mapValue(value: any): { value: string | null; value_type: string | null } {
  if (value?.percentage != null) {
    return { value: String(-Math.abs(Number(value.percentage) * 100)), value_type: "percentage" };
  }
  if (value?.amount?.amount != null) {
    return { value: String(-Math.abs(Number(value.amount.amount))), value_type: "fixed_amount" };
  }
  return { value: null, value_type: null };
}

/** One discount by its code, or null when no such code exists. */
export async function getDiscountByCode(ctx: ShopifyCtx, code: string): Promise<DiscountSummary | null> {
  const data = await shopifyGraphQLRequest(ctx, DISCOUNT_BY_CODE, { code }, { retryable: true });
  const node = data?.codeDiscountNodeByCode;
  return node ? mapDiscount(node.id, node.codeDiscount) : null;
}

/**
 * Code discounts, newest page first.
 *
 * `discountNodes` also carries automatic discounts, which have no code and are
 * not what any of these tools are about; the mapper returns null for them and
 * they are dropped.
 */
export async function listDiscounts(ctx: ShopifyCtx, limit: number): Promise<DiscountSummary[]> {
  const rows = await paginate<any>(ctx, DISCOUNT_LIST, {}, "discountNodes", limit);
  return rows
    .map((n: any) => mapDiscount(n?.id ?? null, n?.discount))
    .filter((d): d is DiscountSummary => d != null && d.code != null);
}

export interface DiscountCreateOptions {
  code: string;
  percentage: number;
  usage_limit?: number;
  ends_at_iso?: string;
  customer_id?: string;
  title?: string;
}

/**
 * Create a percentage code discount.
 *
 * ONE call where REST needed two - a price rule, then a code hung off it - so
 * the half-created state REST could leave behind (a rule with no code) no
 * longer exists. Not retried: a repeated create is a second coupon, and
 * Shopify only refuses it when the code happens to collide.
 */
export async function createDiscount(ctx: ShopifyCtx, opts: DiscountCreateOptions): Promise<{ code: string; price_rule_id: number | null; percentage: number }> {
  const percentage = Math.abs(Number(opts.percentage));
  const input: Record<string, unknown> = {
    title: opts.title || `Bot ${opts.code}`,
    code: opts.code,
    startsAt: new Date().toISOString(),
    ...(opts.ends_at_iso ? { endsAt: opts.ends_at_iso } : {}),
    usageLimit: opts.usage_limit != null ? opts.usage_limit : 1,
    // GraphQL wants a fraction; the tool argument is a percentage.
    customerGets: { value: { percentage: percentage / 100 }, items: { all: true } },
    context: opts.customer_id
      ? { customers: { add: [toGid("Customer", opts.customer_id)] } }
      : { all: true },
  };
  const data = await shopifyGraphQLRequest(
    ctx,
    DISCOUNT_CREATE,
    { basicCodeDiscount: input },
    { userErrorsAt: "discountCodeBasicCreate" },
  );
  const gid = data?.discountCodeBasicCreate?.codeDiscountNode?.id ?? null;
  return { code: opts.code, price_rule_id: numericId({ id: gid ?? undefined }), percentage };
}

/**
 * Deactivate a code discount.
 *
 * Takes the gid because that is the only handle the mutation accepts, and the
 * caller has just read it off `getDiscountByCode`.
 */
export async function deactivateDiscount(ctx: ShopifyCtx, discountId: string | number): Promise<DiscountSummary | null> {
  const data = await shopifyGraphQLRequest(
    ctx,
    DISCOUNT_DEACTIVATE,
    { id: toGid("DiscountCodeNode", discountId) },
    { userErrorsAt: "discountCodeDeactivate" },
  );
  const node = data?.discountCodeDeactivate?.codeDiscountNode;
  return node ? mapDiscount(node.id, node.codeDiscount) : null;
}
