/**
 * Which system opens a return, and what happens when none can.
 *
 * Scenario 21 was UNSUPPORTED: `returns_count: 0`, no fake RMA, a handoff. That
 * was honest, and honest for a reason worth stating - nothing in the product
 * could create a return. Both candidate providers were "connected" and neither
 * could do it: Shopify had `write_returns` granted with no tool using it, and
 * ReturnGO - a returns platform - exposes list, summarise and update, with no
 * create at all.
 *
 * So the resolver answers in CAPABILITIES, not connections. "ReturnGO is
 * connected" is true and useless; "ReturnGO cannot create a return" is the fact
 * that decides what happens next.
 */
import { describe, it, expect } from "vitest";
import {
  selectReturnProvider,
  buildReturnDirective,
  type ReturnProviderCapabilities,
} from "../services/return-provider.service";
import { detectReturnIntent } from "../services/customer-request-intents.service";

const caps = (over: Partial<ReturnProviderCapabilities>): ReturnProviderCapabilities => ({
  provider: "shopify",
  connected: true,
  supportsCreateReturn: false,
  supportsExchange: false,
  supportsRefund: false,
  supportsLabels: false,
  supportsStatus: false,
  supportsEvidenceUpload: false,
  supportsWebhookUpdates: false,
  reason: "",
  statusProviders: [],
  ...over,
});

const shopifyCapable = caps({ provider: "shopify", supportsCreateReturn: true, supportsStatus: true, reason: "ok" });
const shopifyReadOnly = caps({
  provider: "shopify", supportsCreateReturn: false, supportsStatus: true,
  reason: "Shopify is connected but the store has not granted write_returns, so it cannot open a return.",
});
const returngoConnected = caps({
  provider: "returngo", supportsCreateReturn: false, supportsStatus: true,
  reason: "ReturnGO is connected but its adapter has no create-return operation - only transaction reads and updates.",
});
const returngoAbsent = caps({ provider: "returngo", connected: false, reason: "ReturnGO is not connected." });
const returngoCapable = caps({ provider: "returngo", supportsCreateReturn: true, supportsStatus: true, reason: "ok" });

describe("choosing exactly one provider to create a return", () => {
  it("picks Shopify when it is the only one that can create", () => {
    const p = selectReturnProvider(shopifyCapable, returngoConnected, null);
    expect(p.provider).toBe("shopify");
    expect(p.supportsCreateReturn).toBe(true);
  });

  it("prefers ReturnGO when it too can create - the returns platform owns returns", () => {
    const p = selectReturnProvider(shopifyCapable, returngoCapable, null);
    expect(p.provider).toBe("returngo");
  });

  it("a CONNECTED ReturnGO that cannot create is not a return provider", () => {
    const p = selectReturnProvider(shopifyReadOnly, returngoConnected, null);
    expect(p.provider).toBe("none");
    expect(p.supportsCreateReturn).toBe(false);
  });

  it("read_returns without write_returns cannot open a return", () => {
    const p = selectReturnProvider(shopifyReadOnly, returngoAbsent, null);
    expect(p.provider).toBe("none");
    expect(p.reason).toContain("write_returns");
  });

  it("honours an explicit selection over the precedence", () => {
    const p = selectReturnProvider(shopifyCapable, returngoCapable, "shopify");
    expect(p.provider).toBe("shopify");
  });

  it("refuses rather than silently using the OTHER provider when the chosen one cannot", () => {
    const p = selectReturnProvider(shopifyCapable, returngoConnected, "returngo");
    expect(p.provider).toBe("none");
    expect(p.reason).toContain("returngo is selected");
  });

  it("still reports BOTH providers for status - neither is complete alone", () => {
    const p = selectReturnProvider(shopifyCapable, returngoConnected, null);
    expect(p.statusProviders).toEqual(["returngo", "shopify"]);
  });

  it("never returns two creation providers", () => {
    for (const explicit of [null, "shopify", "returngo"] as const) {
      const p = selectReturnProvider(shopifyCapable, returngoCapable, explicit);
      expect(["shopify", "returngo", "none"]).toContain(p.provider);
      expect(typeof p.provider).toBe("string");
    }
  });
});

describe("the return directive", () => {
  it("with Shopify selected, gates the claim on a real return id", () => {
    const d = buildReturnDirective(selectReturnProvider(shopifyCapable, returngoAbsent, null));
    expect(d).toContain("create_return");
    expect(d).toContain("Only after create_return returns a real return id");
    expect(d).toContain("do NOT open a second one for the same request");
  });

  it("with ReturnGO selected, forbids also creating a Shopify return", () => {
    const d = buildReturnDirective(selectReturnProvider(shopifyCapable, returngoCapable, "returngo"));
    expect(d).toContain("do NOT also create a Shopify return");
  });

  it("with no provider, forbids the exact lie scenario 21 produced", () => {
    const d = buildReturnDirective(selectReturnProvider(shopifyReadOnly, returngoConnected, null));
    expect(d).toContain("must NOT say a return, RMA or case was opened");
    expect(d).toContain(`must NOT say a request was "passed on"`);
    expect(d).toContain("A note or a tag on the order reaches nobody");
  });

  it("with no provider, requires the handoff to succeed BEFORE it is announced", () => {
    const d = buildReturnDirective(selectReturnProvider(shopifyReadOnly, returngoAbsent, null));
    expect(d).toContain("only AFTER the handoff tool has returned success");
    expect(d).toContain("order, item, quantity, reason");
  });

  it("explains WHY nothing can open a return, rather than just refusing", () => {
    const d = buildReturnDirective(selectReturnProvider(shopifyReadOnly, returngoConnected, null));
    expect(d).toContain("write_returns");
    expect(d).toContain("no create-return operation");
  });
});

describe("detecting a return request", () => {
  it("fires on returns and on the complaints that lead to one", () => {
    for (const s of [
      "אני רוצה להחזיר את המוצר",
      "המוצר הגיע פגום",
      "קיבלתי מוצר לא נכון",
      "I want to return this",
      "it arrived damaged",
      "you sent the wrong item",
    ]) {
      expect(detectReturnIntent(s), s).toBe(true);
    }
  });

  it("does not fire on an ordinary status question", () => {
    expect(detectReturnIntent("מתי ההזמנה מגיעה?")).toBe(false);
  });
});
