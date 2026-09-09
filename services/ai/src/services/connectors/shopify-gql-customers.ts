/**
 * Customers, on Admin GraphQL.
 *
 * Family 3, and the first one that WRITES. Everything here touches a real
 * person's record - their email, their phone, their address, the note the AI
 * appended after a conversation - so the rules are stricter than for products:
 *
 *   * every mutation names its `userErrors`, so a refusal can never be read as
 *     a success (Shopify answers 200 either way);
 *   * no mutation is retried, because a repeated `customerCreate` is a
 *     duplicate person and a repeated note append is a duplicated note;
 *   * the reads keep returning the REST shape, because `verifyReadBack` and
 *     `detectDuplicate` in shopify-profile-update.ts compare snake_case keys
 *     (`first_name`, `default_address.country_code`) and would silently report
 *     every write as unverified against camelCase.
 *
 * ── Fields that moved ──
 *
 * `Customer.email`, `Customer.phone`, `Customer.emailMarketingConsent` and
 * `Customer.addresses` are all deprecated in 2026-07. Their replacements
 * (`defaultEmailAddress`, `defaultPhoneNumber`, `addressesV2`) need no scope
 * this app does not already hold, so they are used here and the REST-era key
 * names are rebuilt in the mapper.
 *
 * ── Tags ──
 *
 * REST had no tag operation: adding one meant reading the customer, appending
 * to a comma string and writing the whole field back, which loses any tag added
 * by anything else in between. `tagsAdd` / `tagsRemove` are atomic and say what
 * the tags ARE afterwards, so that read-modify-write is gone.
 */
import {
  shopifyGraphQLRequest,
  paginate,
  toGid,
  escapeSearchValue,
  type ShopifyCtx,
} from "./shopify-graphql";

const ADDRESS_FIELDS = `
  id
  address1
  address2
  city
  province
  provinceCode
  country
  countryCodeV2
  zip
  phone
  firstName
  lastName
  company
  name`;

const CUSTOMER_FIELDS = `
  legacyResourceId
  firstName
  lastName
  defaultEmailAddress { emailAddress marketingState }
  defaultPhoneNumber { phoneNumber }
  note
  tags
  createdAt
  numberOfOrders
  amountSpent { amount currencyCode }
  defaultAddress { ${ADDRESS_FIELDS} }
  addressesV2(first: 20) { nodes { ${ADDRESS_FIELDS} } }`;

/** The lighter set for search results - no address book per row. */
const CUSTOMER_ROW_FIELDS = `
  legacyResourceId
  firstName
  lastName
  defaultEmailAddress { emailAddress }
  defaultPhoneNumber { phoneNumber }
  note
  tags
  createdAt
  numberOfOrders
  amountSpent { amount currencyCode }
  defaultAddress { ${ADDRESS_FIELDS} }`;

/** What a mutation gives back: enough to confirm the write, not the whole record. */
const CUSTOMER_WRITE_FIELDS = `
  legacyResourceId
  firstName
  lastName
  defaultEmailAddress { emailAddress }
  defaultPhoneNumber { phoneNumber }
  note
  tags`;

const CUSTOMER_BY_ID = `
  query GotchaCustomerById($id: ID!) {
    customer(id: $id) { ${CUSTOMER_FIELDS} }
  }`;

const CUSTOMER_SEARCH = `
  query GotchaCustomerSearch($first: Int!, $after: String, $query: String) {
    customers(first: $first, after: $after, query: $query) {
      nodes { ${CUSTOMER_ROW_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const CUSTOMER_METAFIELDS = `
  query GotchaCustomerMetafields($id: ID!, $first: Int!, $after: String) {
    customer(id: $id) {
      metafields(first: $first, after: $after) {
        nodes { legacyResourceId namespace key value type }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

const CUSTOMER_CREATE = `
  mutation GotchaCustomerCreate($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { ${CUSTOMER_WRITE_FIELDS} }
      userErrors { field message }
    }
  }`;

const CUSTOMER_UPDATE = `
  mutation GotchaCustomerUpdate($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer { ${CUSTOMER_WRITE_FIELDS} }
      userErrors { field message }
    }
  }`;

const TAGS_ADD = `
  mutation GotchaCustomerTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { ... on Customer { legacyResourceId tags } }
      userErrors { field message }
    }
  }`;

const TAGS_REMOVE = `
  mutation GotchaCustomerTagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node { ... on Customer { legacyResourceId tags } }
      userErrors { field message }
    }
  }`;

const ADDRESS_CREATE = `
  mutation GotchaCustomerAddressCreate($customerId: ID!, $address: MailingAddressInput!, $setAsDefault: Boolean) {
    customerAddressCreate(customerId: $customerId, address: $address, setAsDefault: $setAsDefault) {
      address { id }
      userErrors { field message }
    }
  }`;

const ADDRESS_UPDATE = `
  mutation GotchaCustomerAddressUpdate($customerId: ID!, $addressId: ID!, $address: MailingAddressInput!, $setAsDefault: Boolean) {
    customerAddressUpdate(customerId: $customerId, addressId: $addressId, address: $address, setAsDefault: $setAsDefault) {
      address { id }
      userErrors { field message }
    }
  }`;

const METAFIELDS_SET = `
  mutation GotchaMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { legacyResourceId namespace key value type }
      userErrors { field message }
    }
  }`;

export interface RestAddress {
  id: number | null;
  /**
   * The gid, under the name REST itself used for it. Kept because an address
   * can only be updated by its gid, and `id` has to stay numeric for everything
   * that already reads these records.
   */
  admin_graphql_api_id: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  province_code: string | null;
  country: string | null;
  country_code: string | null;
  zip: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  name: string | null;
}

export interface RestCustomer {
  id: number | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  note: string | null;
  tags: string[];
  created_at: string | null;
  orders_count: number;
  total_spent: string | null;
  currency: string | null;
  email_marketing_consent: { state: string } | null;
  default_address: RestAddress | null;
  addresses: RestAddress[];
}

export function mapAddress(a: any): RestAddress | null {
  if (!a) return null;
  return {
    id: numericFromGid(a.id),
    admin_graphql_api_id: a.id ?? null,
    address1: a.address1 ?? null,
    address2: a.address2 ?? null,
    city: a.city ?? null,
    province: a.province ?? null,
    province_code: a.provinceCode ?? null,
    country: a.country ?? null,
    // REST's `country_code` is the two-letter code; `countryCodeV2` is the same
    // value. verifyReadBack compares against it to accept Shopify rewriting
    // "ישראל" into "Israel", so losing it would make every Hebrew-language
    // country change report as a failed write.
    country_code: a.countryCodeV2 ?? null,
    zip: a.zip ?? null,
    phone: a.phone ?? null,
    first_name: a.firstName ?? null,
    last_name: a.lastName ?? null,
    company: a.company ?? null,
    name: a.name ?? null,
  };
}

export function mapCustomer(c: any): RestCustomer | null {
  if (!c) return null;
  return {
    id: numeric(c.legacyResourceId),
    first_name: c.firstName ?? null,
    last_name: c.lastName ?? null,
    email: c.defaultEmailAddress?.emailAddress ?? null,
    phone: c.defaultPhoneNumber?.phoneNumber ?? null,
    note: c.note ?? null,
    tags: Array.isArray(c.tags) ? c.tags : [],
    created_at: c.createdAt ?? null,
    // UnsignedInt64 arrives as a string.
    orders_count: Number(c.numberOfOrders ?? 0) || 0,
    // Kept as a decimal string, as REST sent it: callers do their own Number()
    // and money is not a float.
    total_spent: c.amountSpent?.amount ?? null,
    currency: c.amountSpent?.currencyCode ?? null,
    email_marketing_consent: c.defaultEmailAddress?.marketingState
      ? { state: String(c.defaultEmailAddress.marketingState).toLowerCase() }
      : null,
    default_address: mapAddress(c.defaultAddress),
    addresses: (c.addressesV2?.nodes || []).map(mapAddress).filter(Boolean) as RestAddress[],
  };
}

function numeric(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * A MailingAddress gid carries a query string
 * (`gid://shopify/MailingAddress/1?model_name=CustomerAddress`), so the numeric
 * id is the last path segment with anything after `?` dropped.
 */
function numericFromGid(gid: unknown): number | null {
  const tail = String(gid ?? "").split("/").pop()?.split("?")[0] ?? "";
  return tail ? numeric(tail) : null;
}

export async function getCustomerById(ctx: ShopifyCtx, id: string | number): Promise<RestCustomer | null> {
  const data = await shopifyGraphQLRequest(ctx, CUSTOMER_BY_ID, { id: toGid("Customer", id) }, { retryable: true });
  return mapCustomer(data?.customer);
}

/**
 * Search customers with Shopify's own grammar.
 *
 * `query` is passed through as written, exactly as REST's `search.json?query=`
 * did - callers send real search syntax like `email:x OR phone:y` and escaping
 * it here would break every one of them. Callers that search for a single field
 * value should use `findCustomerByField`, which escapes.
 */
export async function searchCustomers(ctx: ShopifyCtx, query: string, limit: number): Promise<RestCustomer[]> {
  const rows = await paginate<any>(ctx, CUSTOMER_SEARCH, { query: String(query || "") }, "customers", limit);
  return rows.map(mapCustomer).filter(Boolean) as RestCustomer[];
}

/** One customer by an exact field value, with the value escaped. */
export async function findCustomerByField(
  ctx: ShopifyCtx,
  field: "email" | "phone",
  value: string,
): Promise<RestCustomer | null> {
  const rows = await paginate<any>(
    ctx,
    CUSTOMER_SEARCH,
    { query: `${field}:${escapeSearchValue(value)}` },
    "customers",
    1,
  );
  return mapCustomer(rows[0]);
}

export async function getCustomerMetafields(ctx: ShopifyCtx, id: string | number, limit = 100): Promise<any[]> {
  const rows = await paginate<any>(
    ctx,
    CUSTOMER_METAFIELDS,
    { id: toGid("Customer", id) },
    "customer.metafields",
    limit,
  );
  return rows.map((m: any) => ({
    id: numeric(m?.legacyResourceId),
    namespace: m?.namespace ?? null,
    key: m?.key ?? null,
    value: m?.value ?? null,
    type: m?.type ?? null,
  }));
}

/** The subset of CustomerInput this integration ever sets. */
export interface CustomerWriteFields {
  email?: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
  note?: string;
  tags?: string[];
}

function toCustomerInput(fields: CustomerWriteFields): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (fields.email != null) input.email = fields.email;
  if (fields.phone != null) input.phone = fields.phone;
  if (fields.first_name != null) input.firstName = fields.first_name;
  if (fields.last_name != null) input.lastName = fields.last_name;
  if (fields.note != null) input.note = fields.note;
  if (fields.tags != null) input.tags = fields.tags;
  return input;
}

export async function createCustomer(ctx: ShopifyCtx, fields: CustomerWriteFields): Promise<RestCustomer | null> {
  // Not retryable: a repeated create is a duplicate person, and Shopify only
  // refuses the second one when an email or phone happens to collide.
  const data = await shopifyGraphQLRequest(
    ctx,
    CUSTOMER_CREATE,
    { input: toCustomerInput(fields) },
    { userErrorsAt: "customerCreate" },
  );
  return mapCustomer(data?.customerCreate?.customer);
}

export async function updateCustomer(
  ctx: ShopifyCtx,
  id: string | number,
  fields: CustomerWriteFields,
): Promise<RestCustomer | null> {
  const data = await shopifyGraphQLRequest(
    ctx,
    CUSTOMER_UPDATE,
    { input: { id: toGid("Customer", id), ...toCustomerInput(fields) } },
    { userErrorsAt: "customerUpdate" },
  );
  return mapCustomer(data?.customerUpdate?.customer);
}

/**
 * Add or remove tags atomically, and report what the customer's tags are now.
 *
 * The `node` payload is typed as the generic Node, so the tags come back
 * through an inline fragment on Customer.
 */
export async function mutateTags(
  ctx: ShopifyCtx,
  id: string | number,
  tags: string[],
  op: "add" | "remove",
): Promise<string[]> {
  const field = op === "add" ? "tagsAdd" : "tagsRemove";
  const data = await shopifyGraphQLRequest(
    ctx,
    op === "add" ? TAGS_ADD : TAGS_REMOVE,
    { id: toGid("Customer", id), tags },
    { userErrorsAt: field },
  );
  const after = data?.[field]?.node?.tags;
  return Array.isArray(after) ? after : [];
}

export interface AddressWriteFields {
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  zip?: string;
  country?: string;
  company?: string;
  phone?: string;
}

/**
 * Write the customer's address.
 *
 * REST needed up to three calls to give a customer their first address: create
 * it, read the new id, then PUT `/default.json`. `setAsDefault` is an argument
 * here, so the "no saved address at all" case is one call and cannot half-land
 * with an address created but not defaulted.
 */
export async function writeCustomerAddress(
  ctx: ShopifyCtx,
  customerId: string | number,
  address: AddressWriteFields,
  existingAddressGid: string | null,
): Promise<void> {
  const customerGid = toGid("Customer", customerId);
  if (existingAddressGid) {
    await shopifyGraphQLRequest(
      ctx,
      ADDRESS_UPDATE,
      { customerId: customerGid, addressId: existingAddressGid, address, setAsDefault: true },
      { userErrorsAt: "customerAddressUpdate" },
    );
    return;
  }
  await shopifyGraphQLRequest(
    ctx,
    ADDRESS_CREATE,
    { customerId: customerGid, address, setAsDefault: true },
    { userErrorsAt: "customerAddressCreate" },
  );
}

/**
 * Set one metafield on a customer.
 *
 * `metafieldsSet` is an upsert keyed on (owner, namespace, key), which is what
 * the REST POST already behaved like for an existing field. Being an upsert
 * also makes it the one mutation in this family that is safe to repeat - but it
 * is still not retried, because nothing here needs it to be.
 */
export async function setCustomerMetafield(
  ctx: ShopifyCtx,
  customerId: string | number,
  metafield: { namespace: string; key: string; value: string; type: string },
): Promise<any> {
  const data = await shopifyGraphQLRequest(
    ctx,
    METAFIELDS_SET,
    { metafields: [{ ownerId: toGid("Customer", customerId), ...metafield }] },
    { userErrorsAt: "metafieldsSet" },
  );
  const m = data?.metafieldsSet?.metafields?.[0];
  return m
    ? { id: numeric(m.legacyResourceId), namespace: m.namespace, key: m.key, value: m.value, type: m.type }
    : null;
}
