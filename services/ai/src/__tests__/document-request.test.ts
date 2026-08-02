/**
 * "תשלחו לי חשבונית", and the six other things that sentence can mean.
 *
 * Scenario 28 failed as `shopify_406` - a provider status code shown to a
 * customer. The status code was the visible bug; the real one is that "invoice"
 * was treated as one capability when it is at least three, so a request for a
 * tax document was answered by attempting an order email.
 *
 * The redaction tests are the other half of this phase. `order_status_url`
 * carries `authenticate?key=`, which is a bearer credential for that customer's
 * order page: pasting it into a chat hands it to whoever reads the transcript.
 */
import { describe, it, expect } from "vitest";
import {
  detectDocumentRequest,
  resolveDocumentCapability,
  buildDocumentDirective,
  type DocumentContext,
} from "../services/document-request.service";
import {
  redactPrivateShopifyData,
  redactString,
  containsPrivateShopifyData,
} from "../services/connectors/shopify-safe-output";

const ctx = (over: Partial<DocumentContext> = {}): DocumentContext => ({
  shopifyConnected: true,
  invoicingProvider: null,
  canSendWhatsAppMedia: false,
  hasCustomerEmail: true,
  ...over,
});

describe("telling the documents apart", () => {
  it("a tax invoice is not an invoice", () => {
    expect(detectDocumentRequest("אפשר לקבל חשבונית מס?")).toBe("tax_invoice");
    expect(detectDocumentRequest("אפשר לקבל חשבונית?")).toBe("invoice");
  });

  it("recognises each supported type", () => {
    expect(detectDocumentRequest("אפשר קבלה על התשלום?")).toBe("payment_receipt");
    expect(detectDocumentRequest("תשלחו לי אישור הזמנה")).toBe("order_confirmation");
    expect(detectDocumentRequest("צריך אישור על ההחזר")).toBe("refund_confirmation");
    expect(detectDocumentRequest("תעודת זיכוי בבקשה")).toBe("credit_note");
    expect(detectDocumentRequest("send me the tracking link")).toBe("order_status_link");
  });

  it("does not see a document in an ordinary question", () => {
    expect(detectDocumentRequest("מתי ההזמנה מגיעה?")).toBeNull();
  });
});

describe("what can actually be produced", () => {
  it("a tax invoice with no invoicing provider is unavailable, and says why", () => {
    const cap = resolveDocumentCapability("tax_invoice", ctx());
    expect(cap.available).toBe(false);
    expect(cap.source).toBe("none");
    expect(cap.reason).toContain("No accounting or invoicing system is connected");
  });

  it("a credit note is treated the same way - it is an accounting document", () => {
    expect(resolveDocumentCapability("credit_note", ctx()).available).toBe(false);
  });

  it("a tax invoice becomes available once a provider is connected", () => {
    const cap = resolveDocumentCapability("tax_invoice", ctx({ invoicingProvider: "iCount" }));
    expect(cap.available).toBe(true);
    expect(cap.source).toBe("invoicing_provider");
  });

  it("an order confirmation is available from Shopify with an email on file", () => {
    const cap = resolveDocumentCapability("order_confirmation", ctx());
    expect(cap.available).toBe(true);
    expect(cap.channels).toEqual(["email"]);
  });

  it("nothing is sendable with no channel at all", () => {
    const cap = resolveDocumentCapability("payment_receipt", ctx({ hasCustomerEmail: false }));
    expect(cap.available).toBe(false);
    expect(cap.reason).toContain("no verified address or channel");
  });

  it("the order-status link is REFUSED even though Shopify has one", () => {
    const cap = resolveDocumentCapability("order_status_link", ctx());
    expect(cap.available).toBe(false);
    expect(cap.reason).toContain("pre-authenticated");
    expect(cap.alternatives.join(" ")).toContain("said plainly");
  });

  it("always offers a real alternative, never a dead end", () => {
    for (const t of ["tax_invoice", "credit_note", "invoice"] as const) {
      expect(resolveDocumentCapability(t, ctx()).alternatives.length).toBeGreaterThan(0);
    }
  });
});

describe("the document directive", () => {
  it("forbids the provider status code that reached a customer", () => {
    const d = buildDocumentDirective(resolveDocumentCapability("tax_invoice", ctx()));
    expect(d).toContain("without any provider name, status code or error text");
  });

  it("forbids dressing an order summary up as an invoice", () => {
    const d = buildDocumentDirective(resolveDocumentCapability("tax_invoice", ctx()));
    expect(d).toContain("Do NOT present an order summary as an invoice or a receipt");
    expect(d).toContain("A tax invoice not issued by an invoicing system is not one");
  });

  it("pins delivery to the stored address and refuses one typed in chat", () => {
    const d = buildDocumentDirective(resolveDocumentCapability("order_confirmation", ctx()));
    expect(d).toContain("ONLY to the address already stored on the account");
    expect(d).toContain("never accept one from the conversation");
  });

  it("gates the sent claim on the tool succeeding", () => {
    const d = buildDocumentDirective(resolveDocumentCapability("order_confirmation", ctx()));
    expect(d).toContain("ONLY after the send tool returns success");
  });

  it("forbids the order-status link even on the available path", () => {
    const d = buildDocumentDirective(resolveDocumentCapability("order_confirmation", ctx()));
    expect(d).toContain("Never include the shop's order-status link");
  });
});

describe("private Shopify data never reaches a prompt", () => {
  it("drops the credential-bearing fields found live in Part 4", () => {
    const out: any = redactPrivateShopifyData({
      id: 1, name: "#1011",
      browser_ip: "1.2.3.4",
      checkout_token: "abc123",
      token: "shpat_deadbeefdeadbeef",
      order_status_url: "https://shop.myshopify.com/1/orders/x/authenticate?key=secret",
      customer: { id: 9, email: "matan@example.com" },
    });
    expect(out.browser_ip).toBeUndefined();
    expect(out.checkout_token).toBeUndefined();
    expect(out.token).toBeUndefined();
    expect(out.order_status_url).toBeUndefined();
    expect(out.name).toBe("#1011");
    expect(out.customer.email).toBe("matan@example.com");
  });

  it("DROPS rather than nulls - a null reads as 'there is no status URL'", () => {
    const out: any = redactPrivateShopifyData({ order_status_url: "https://x/authenticate?key=k" });
    expect("order_status_url" in out).toBe(false);
  });

  it("catches an admin URL wherever it hides, including free text", () => {
    const out: any = redactPrivateShopifyData({
      note: "see https://urban-supply.myshopify.com/admin/orders/123 for detail",
    });
    expect(out.note).not.toContain("myshopify.com/admin");
    expect(out.note).toContain("[redacted]");
  });

  it("catches an authenticate key and a live checkout inside a string", () => {
    expect(redactString("go to https://s.myshopify.com/x/authenticate?key=abc")).not.toContain("key=abc");
    expect(redactString("https://s.myshopify.com/checkouts/tok123")).not.toContain("tok123");
  });

  it("catches access tokens by prefix", () => {
    for (const t of ["shpat_aaaaaaaaaaa", "shpca_bbbbbbbbbbb", "shpss_ccccccccccc"]) {
      expect(redactString(`token is ${t}`), t).not.toContain(t);
    }
  });

  it("survives arrays and nesting", () => {
    const out: any = redactPrivateShopifyData({
      orders: [{ id: 1, checkout_token: "x" }, { id: 2, fulfillments: [{ token: "y" }] }],
    });
    expect(out.orders[0].checkout_token).toBeUndefined();
    expect(out.orders[1].fulfillments[0].token).toBeUndefined();
    expect(out.orders[1].id).toBe(2);
  });

  it("leaves an ordinary storefront link alone", () => {
    const safe = "https://urban-supply.myshopify.com/products/the-minimal-snowboard";
    expect(redactString(safe)).toBe(safe);
  });

  it("detects a leak in outbound text without changing it", () => {
    expect(containsPrivateShopifyData("here: https://s.myshopify.com/admin/orders/1")).toBe(true);
    expect(containsPrivateShopifyData("your order #1011 has shipped")).toBe(false);
  });

  it("is not defeated by a shared regex keeping its lastIndex", () => {
    const s = "https://a.myshopify.com/admin/x";
    expect(containsPrivateShopifyData(s)).toBe(true);
    expect(containsPrivateShopifyData(s)).toBe(true);
  });
});
