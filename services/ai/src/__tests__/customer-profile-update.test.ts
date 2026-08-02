/**
 * A customer changing their own Shopify profile.
 *
 * The ownership question is answered by construction, not by checking:
 * `update_my_profile` has no customer selector in its schema, and
 * `applySelfScope` strips anything selector-shaped the model sends before the
 * adapter is reached. These tests hold that shape in place - a future schema
 * change that adds `customer_id` back would make the model's opinion load
 * bearing again.
 *
 * The rest covers the ordinary ways a self-service edit goes wrong: a
 * malformed value, an address that changes country and keeps the old province,
 * an email already sitting on another account, and a write that Shopify
 * accepts while the record does not actually change.
 */
import { describe, it, expect } from "vitest";
import {
  validateProfilePatch,
  verifyReadBack,
  detectDuplicate,
  normalizePhone,
} from "../services/connectors/shopify-profile-update";
import {
  applySelfScope,
  deriveSelfSelector,
  SELF_SCOPED_SHOPIFY_TOOLS,
  SELF_SCOPE_KEY,
  type RequesterIdentity,
} from "../services/connectors/customer-access-guard";
import {
  detectProfileUpdateIntent,
  buildProfileUpdateDirective,
} from "../services/customer-request-intents.service";

function identity(over: Partial<RequesterIdentity> = {}): RequesterIdentity {
  return {
    phoneSuffixes: new Set(["545680665"]),
    emails: new Set(),
    customerIds: new Set(),
    conversationId: "conv_1",
    channelSenderId: "972545680665",
    ...over,
  };
}

describe("ownership is derived, never accepted", () => {
  it("update_my_profile is registered as self-scoped", () => {
    expect(SELF_SCOPED_SHOPIFY_TOOLS.has("update_my_profile")).toBe(true);
  });

  it("prefers a customer id the system itself resolved", () => {
    const s = deriveSelfSelector(identity({ customerIds: new Set(["27711594201457"]) }));
    expect(s).toEqual({ customer_id: "27711594201457" });
  });

  it("falls back to the FULL authenticated sender, never a truncated suffix", () => {
    expect(deriveSelfSelector(identity())).toEqual({ phone: "+972545680665" });
  });

  it("refuses to derive anything when the channel proved nothing", () => {
    expect(deriveSelfSelector(identity({ phoneSuffixes: new Set(), channelSenderId: null }))).toBeNull();
  });

  it("strips a customer id the model supplied and derives the real one", () => {
    const out = applySelfScope(identity(), { customer_id: "999", first_name: "Matan" })!;
    expect(out.args.customer_id).toBeUndefined();
    expect(out.args[SELF_SCOPE_KEY]).toEqual({ phone: "+972545680665" });
    expect(out.args.first_name).toBe("Matan");
    expect(out.stripped).toEqual(["customer_id"]);
  });

  // On a self-scoped tool the arguments ARE the new values. Merging the derived
  // selector into them made an injected `{ phone: … }` indistinguishable from
  // "set my phone to this", and an injected `{ customer_id: … }` was rejected
  // by the field validator, which then reported `nothing_to_update` for a
  // change the customer had just confirmed. Live, 2026-08-02.
  it("keeps the selector OUT of the fields being changed", () => {
    const out = applySelfScope(identity(), { email: "new@example.com" })!;
    expect(out.args.email).toBe("new@example.com");
    expect(out.args[SELF_SCOPE_KEY]).toEqual({ phone: "+972545680665" });
    expect(out.stripped).toEqual([]);
  });

  it("treats email and phone as VALUES on this tool, not as ownership claims", () => {
    const out = applySelfScope(identity(), { phone: "0501112222" })!;
    expect(out.args.phone).toBe("0501112222");
    expect(out.args[SELF_SCOPE_KEY]).toEqual({ phone: "+972545680665" });
  });

  it("keeps the fields being changed while discarding an id selector", () => {
    const out = applySelfScope(identity(), { address: { city: "Haifa" }, id: "1" })!;
    expect(out.args.address).toEqual({ city: "Haifa" });
    expect(out.stripped).toEqual(["id"]);
  });

  it("reports nothing stripped when the model sent no selector at all", () => {
    expect(applySelfScope(identity(), { first_name: "Matan" })!.stripped).toEqual([]);
  });
});

describe("what a customer may change about themselves", () => {
  it("accepts the supported profile fields", () => {
    const p = validateProfilePatch({ first_name: "Matan", last_name: "Amran" });
    expect(p.customer).toEqual({ first_name: "Matan", last_name: "Amran" });
    expect(p.errors).toEqual([]);
  });

  it("flags email and phone as sensitive - they move who we resolve later", () => {
    expect(validateProfilePatch({ email: "a@b.co" }).sensitive).toBe(true);
    expect(validateProfilePatch({ phone: "0545680665" }).sensitive).toBe(true);
    expect(validateProfilePatch({ first_name: "Matan" }).sensitive).toBe(false);
  });

  it("rejects a malformed email before Shopify has to", () => {
    const p = validateProfilePatch({ email: "matan@" });
    expect(p.errors).toContain("invalid_email:matan@");
    expect(p.customer.email).toBeUndefined();
  });

  it("rejects a phone that is not a phone", () => {
    expect(validateProfilePatch({ phone: "call me" }).errors[0]).toMatch(/^invalid_phone/);
  });

  it("accepts national format - that is how the customer writes their own number", () => {
    expect(validateProfilePatch({ phone: "054-568-0665" }).customer.phone).toBe("0545680665");
  });

  it("refuses merchant-owned fields a customer must not set", () => {
    const p = validateProfilePatch({ tags: "VIP", note: "give discount", first_name: "Matan" });
    expect(p.rejected.sort()).toEqual(["note", "tags"]);
    expect(p.customer).toEqual({ first_name: "Matan" });
  });

  it("takes address fields nested or flat", () => {
    expect(validateProfilePatch({ address: { city: "Haifa", zip: "3100000" } }).address)
      .toEqual({ city: "Haifa", zip: "3100000" });
    expect(validateProfilePatch({ city: "Haifa" }).address).toEqual({ city: "Haifa" });
  });

  it("refuses a country change that leaves the old province behind", () => {
    const p = validateProfilePatch({ address: { country: "United States" } });
    expect(p.errors).toContain("country_changed_without_province_or_zip");
  });

  it("allows a country change that brings a province with it", () => {
    const p = validateProfilePatch({ address: { country: "United States", province: "California" } });
    expect(p.errors).toEqual([]);
  });

  it("says so when there is nothing to change", () => {
    expect(validateProfilePatch({}).errors).toContain("nothing_to_update");
  });
});

describe("verifying the write against an independent read", () => {
  it("confirms a change the record actually shows", () => {
    const p = validateProfilePatch({ first_name: "Matan" });
    expect(verifyReadBack(p, { first_name: "Matan" }).verified).toBe(true);
  });

  it("catches a write Shopify accepted but did not apply", () => {
    const p = validateProfilePatch({ email: "new@example.com" });
    const v = verifyReadBack(p, { email: "old@example.com" });
    expect(v.verified).toBe(false);
    expect(v.mismatches[0]).toEqual({ field: "email", requested: "new@example.com", actual: "old@example.com" });
  });

  it("treats Shopify's E.164 rewrite as success, not as a mismatch", () => {
    const p = validateProfilePatch({ phone: "054-568-0665" });
    expect(verifyReadBack(p, { phone: "+972545680665" }).verified).toBe(true);
  });

  it("reads address fields from the default address", () => {
    const p = validateProfilePatch({ address: { city: "Haifa" } });
    expect(verifyReadBack(p, { default_address: { city: "Haifa" } }).verified).toBe(true);
    expect(verifyReadBack(p, { default_address: { city: "Tel Aviv" } }).verified).toBe(false);
  });

  it("a customer that could not be read back is never reported as updated", () => {
    expect(verifyReadBack(validateProfilePatch({ first_name: "X" }), null).verified).toBe(false);
  });
});

describe("duplicate detection", () => {
  it("finds an email already registered to another account", () => {
    const p = validateProfilePatch({ email: "taken@example.com" });
    const d = detectDuplicate(p, "111", [{ id: "222", email: "taken@example.com" }]);
    expect(d).toEqual({ conflict: true, field: "email", existingCustomerId: "222" });
  });

  it("does not call the customer's own record a duplicate of itself", () => {
    const p = validateProfilePatch({ email: "mine@example.com" });
    expect(detectDuplicate(p, "111", [{ id: "111", email: "mine@example.com" }])).toEqual({ conflict: false });
  });

  it("matches a phone across national and international form", () => {
    const p = validateProfilePatch({ phone: "0545680665" });
    const d = detectDuplicate(p, "111", [{ id: "222", phone: "+972545680665" }]);
    expect(d).toMatchObject({ conflict: true, field: "phone" });
  });

  it("normalizes punctuation consistently", () => {
    expect(normalizePhone("+972 (54) 568-0665")).toBe("+972545680665");
  });
});

describe("the profile-update directive", () => {
  it("fires on the ways a customer asks", () => {
    for (const s of [
      "תעדכנו לי את המייל",
      "אפשר לשנות את הטלפון שלי?",
      "הכתובת שלי השתנתה",
      "change my email please",
    ]) {
      expect(detectProfileUpdateIntent(s), s).toBe(true);
    }
  });

  it("does NOT claim an order's shipping address - that is a different flow", () => {
    expect(detectProfileUpdateIntent("תשנו לי את הכתובת בהזמנה")).toBe(false);
    expect(detectProfileUpdateIntent("change the shipping address for order 1011")).toBe(false);
  });

  it("forbids asking for a customer id the tool cannot even accept", () => {
    const d = buildProfileUpdateDirective({ hasProfileTool: true });
    expect(d).toContain("there is no customer id");
    expect(d).toContain("do NOT ask for their customer number");
  });

  it("requires confirmation before a sensitive change and honesty after", () => {
    const d = buildProfileUpdateDirective({ hasProfileTool: true });
    expect(d).toContain("get a clear yes");
    expect(d).toContain("If verified is false");
    expect(d).toContain("never describe an unconfirmed write as done");
  });

  it("without the tool it must not promise to pass it on", () => {
    const d = buildProfileUpdateDirective({ hasProfileTool: false });
    expect(d).toContain("cannot change it from here");
    expect(d).toContain("unless you actually create a handoff");
  });
});

/**
 * Shopify rewrites a country name, and the profile verifier did not know.
 *
 * The ORDER address verifier learned this in Part 5: a customer writing "ישראל"
 * gets "Israel" stored. The PROFILE verifier did not, so the identical write
 * reported as a failure - and the model, told the change had not gone through,
 * asked the customer which spelling of their own country it should use.
 */
describe("the country Shopify stores is not always the country asked for", () => {
  it("accepts the canonical rewrite of a non-ASCII country name", () => {
    const p = validateProfilePatch({ address: { address1: "הרצל 1", city: "חיפה", country: "ישראל", zip: "3100000" } });
    const v = verifyReadBack(p, {
      default_address: { address1: "הרצל 1", city: "חיפה", country: "Israel", country_code: "IL", zip: "3100000" },
    });
    expect(v.verified).toBe(true);
    expect(v.normalized).toEqual([{ field: "country", requested: "ישראל", actual: "Israel" }]);
  });

  it("matches on the country CODE when that is what was asked for", () => {
    const p = validateProfilePatch({ address: { address1: "Herzl 1", city: "Haifa", country: "IL" } });
    expect(verifyReadBack(p, { default_address: { address1: "Herzl 1", city: "Haifa", country: "Israel", country_code: "IL" } }).verified).toBe(true);
  });

  it("still fails when an ASCII country comes back as a different country", () => {
    const p = validateProfilePatch({ address: { address1: "Herzl 1", city: "Haifa", country: "Israel" } });
    const v = verifyReadBack(p, { default_address: { address1: "Herzl 1", city: "Haifa", country: "United States", country_code: "US" } });
    expect(v.verified).toBe(false);
  });

  it("a wrong city still fails alongside a normalised country", () => {
    const p = validateProfilePatch({ address: { address1: "הרצל 1", city: "חיפה", country: "ישראל" } });
    const v = verifyReadBack(p, { default_address: { address1: "הרצל 1", city: "Tel Aviv", country: "Israel", country_code: "IL" } });
    expect(v.verified).toBe(false);
    expect(v.mismatches.map((m) => m.field)).toEqual(["address.city"]);
  });
});
