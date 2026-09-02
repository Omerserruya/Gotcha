import { describe, it, expect } from "vitest";
import { mapCustomer, mapAddress } from "../services/connectors/shopify-gql-customers";
import { verifyReadBack, detectDuplicate, validateProfilePatch } from "../services/connectors/shopify-profile-update";

/**
 * The customer shape, and the two things that read it hardest.
 *
 * `update_my_profile` only tells a customer their details changed when
 * `verifyReadBack` confirms it against an independent read. That verifier walks
 * SNAKE_CASE keys - `first_name`, `default_address.country_code` - so a mapper
 * that returned Shopify's camelCase would report every successful write as
 * unverified, and the model would tell a customer their address change failed
 * after it had already landed. That is why the checks below run the real
 * verifier over the real mapper rather than asserting key names.
 */

const customerNode = {
  legacyResourceId: "8123456789",
  firstName: "Dana",
  lastName: "Levi",
  defaultEmailAddress: { emailAddress: "dana@example.com", marketingState: "SUBSCRIBED" },
  defaultPhoneNumber: { phoneNumber: "+972545680665" },
  note: "Called about a return",
  tags: ["VIP", "retention"],
  createdAt: "2026-01-05T09:00:00Z",
  numberOfOrders: "7",
  amountSpent: { amount: "1899.50", currencyCode: "ILS" },
  defaultAddress: {
    id: "gid://shopify/MailingAddress/9911?model_name=CustomerAddress",
    address1: "Herzl 1",
    address2: null,
    city: "Tel Aviv",
    province: "Tel Aviv District",
    provinceCode: "TA",
    country: "Israel",
    countryCodeV2: "IL",
    zip: "6120101",
    phone: "+972545680665",
    firstName: "Dana",
    lastName: "Levi",
    company: null,
    name: "Dana Levi",
  },
  addressesV2: { nodes: [{ id: "gid://shopify/MailingAddress/9911?model_name=CustomerAddress", city: "Tel Aviv" }] },
};

describe("customer mapping", () => {
  it("rebuilds the REST keys from the fields that replaced them", () => {
    const c = mapCustomer(customerNode)!;
    expect(c.id).toBe(8123456789);
    expect(c.first_name).toBe("Dana");
    expect(c.email).toBe("dana@example.com");
    expect(c.phone).toBe("+972545680665");
    expect(c.orders_count).toBe(7);
    expect(c.total_spent).toBe("1899.50");
    expect(c.currency).toBe("ILS");
    expect(c.email_marketing_consent).toEqual({ state: "subscribed" });
  });

  it("keeps total_spent a string so money never round-trips through a float", () => {
    expect(typeof mapCustomer(customerNode)!.total_spent).toBe("string");
  });

  it("reads the numeric id out of an address gid that carries a query string", () => {
    expect(mapAddress(customerNode.defaultAddress)!.id).toBe(9911);
  });

  // The gid is the only handle customerAddressUpdate accepts, and the numeric
  // id cannot be turned back into one (the ?model_name= suffix is not derivable).
  it("keeps the address gid alongside the numeric id", () => {
    expect(mapAddress(customerNode.defaultAddress)!.admin_graphql_api_id)
      .toBe("gid://shopify/MailingAddress/9911?model_name=CustomerAddress");
  });

  it("returns null for a missing customer rather than an empty object", () => {
    expect(mapCustomer(null)).toBeNull();
    expect(mapAddress(null)).toBeNull();
  });

  it("survives a customer with no email, phone, address or spend", () => {
    const c = mapCustomer({ legacyResourceId: "1" })!;
    expect(c.email).toBeNull();
    expect(c.phone).toBeNull();
    expect(c.default_address).toBeNull();
    expect(c.addresses).toEqual([]);
    expect(c.orders_count).toBe(0);
    expect(c.email_marketing_consent).toBeNull();
  });
});

describe("the mapped customer still satisfies the profile verifier", () => {
  it("verifies a name and phone change read back off the mapper", () => {
    const patch = validateProfilePatch({ first_name: "Dana", phone: "0545680665" });
    const verdict = verifyReadBack(patch, mapCustomer(customerNode) as any);
    expect(verdict.mismatches).toEqual([]);
    expect(verdict.verified).toBe(true);
  });

  it("verifies an address change through default_address", () => {
    const patch = validateProfilePatch({ address: { address1: "Herzl 1", city: "Tel Aviv", zip: "6120101" } });
    expect(verifyReadBack(patch, mapCustomer(customerNode) as any).verified).toBe(true);
  });

  // The Hebrew-country case: Shopify stores "Israel" for "ישראל" and the
  // verifier accepts it by comparing against country_code. That only works if
  // the mapper carried countryCodeV2 across under the old name.
  it("accepts Shopify normalising a Hebrew country name, via country_code", () => {
    const patch = validateProfilePatch({ address: { country: "ישראל", zip: "6120101" } });
    const verdict = verifyReadBack(patch, mapCustomer(customerNode) as any);
    expect(verdict.mismatches).toEqual([]);
    expect(verdict.normalized.map((n) => n.field)).toContain("country");
  });

  it("still reports a change that did NOT land", () => {
    const patch = validateProfilePatch({ first_name: "Someone Else" });
    const verdict = verifyReadBack(patch, mapCustomer(customerNode) as any);
    expect(verdict.verified).toBe(false);
    expect(verdict.mismatches[0]).toMatchObject({ field: "first_name", actual: "Dana" });
  });
});

describe("duplicate detection over mapped search rows", () => {
  const other = mapCustomer({
    legacyResourceId: "999",
    defaultEmailAddress: { emailAddress: "dana@example.com" },
    defaultPhoneNumber: { phoneNumber: "+972545680665" },
  });

  it("finds an email already held by another account", () => {
    const patch = validateProfilePatch({ email: "dana@example.com" });
    expect(detectDuplicate(patch, "8123456789", [other as any])).toMatchObject({ conflict: true, field: "email" });
  });

  it("finds a phone match across national and international form", () => {
    const patch = validateProfilePatch({ phone: "0545680665" });
    expect(detectDuplicate(patch, "8123456789", [other as any])).toMatchObject({ conflict: true, field: "phone" });
  });

  it("does not call the customer's OWN record a duplicate", () => {
    const patch = validateProfilePatch({ email: "dana@example.com" });
    expect(detectDuplicate(patch, "8123456789", [mapCustomer(customerNode) as any])).toEqual({ conflict: false });
  });
});
