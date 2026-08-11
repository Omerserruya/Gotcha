/**
 * Embedded Signup launcher logic.
 *
 * Each case is a way the connect flow could strand a customer: a popup that
 * never opens, one they close, a `postMessage` that arrives in pieces, or a
 * spoofed origin. None of these are reachable through a happy-path test, and
 * all of them have already happened at least once in this feature.
 */
import { describe, it, expect } from "vitest";
import {
  interpretSignupMessage,
  isMetaOrigin,
  mergeSignupAssets,
  outcomeMessageKey,
  readAuthCode,
} from "../whatsapp-signup-flow";

// ─── Origin checking ─────────────────────────────────────────

describe("isMetaOrigin", () => {
  it("accepts Facebook origins", () => {
    expect(isMetaOrigin("https://www.facebook.com")).toBe(true);
    expect(isMetaOrigin("https://web.facebook.com")).toBe(true);
    expect(isMetaOrigin("https://facebook.com")).toBe(true);
  });

  it("rejects lookalike hosts", () => {
    // A naive endsWith("facebook.com") accepts all of these, and this handler
    // receives every window message the page gets, including from extensions.
    expect(isMetaOrigin("https://evilfacebook.com")).toBe(false);
    expect(isMetaOrigin("https://facebook.com.attacker.test")).toBe(false);
    expect(isMetaOrigin("not-a-url")).toBe(false);
    expect(isMetaOrigin("")).toBe(false);
  });
});

// ─── Popup messages ──────────────────────────────────────────

describe("interpretSignupMessage", () => {
  it("reads the assets from a completion event", () => {
    const msg = interpretSignupMessage({
      type: "WA_EMBEDDED_SIGNUP",
      event: "FINISH",
      data: { business_id: "biz_1", waba_id: "waba_1", phone_number_id: "pn_1" },
    });
    expect(msg).toEqual({
      kind: "assets",
      assets: { businessPortfolioId: "biz_1", wabaIds: ["waba_1"] },
      event: "FINISH",
    });
  });

  it("reads the multi-account form", () => {
    const msg = interpretSignupMessage({
      type: "WA_EMBEDDED_SIGNUP",
      event: "FINISH",
      data: { business_id: "biz_1", waba_ids: ["w1", "w2"] },
    });
    expect(msg.kind).toBe("assets");
    if (msg.kind === "assets") expect(msg.assets.wabaIds).toEqual(["w1", "w2"]);
  });

  it("recognises the Business app completion event", () => {
    const msg = interpretSignupMessage({
      type: "WA_EMBEDDED_SIGNUP",
      event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      data: { waba_id: "waba_1" },
    });
    expect(msg.kind).toBe("assets");
  });

  it("reports cancellation with the abandoned step", () => {
    const msg = interpretSignupMessage({
      type: "WA_EMBEDDED_SIGNUP",
      event: "CANCEL",
      data: { current_step: "PHONE_NUMBER_SETUP" },
    });
    expect(msg).toEqual({ kind: "cancel", step: "PHONE_NUMBER_SETUP" });
  });

  it("parses the string form Meta sometimes posts", () => {
    const msg = interpretSignupMessage(
      JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: {} }),
    );
    expect(msg.kind).toBe("cancel");
  });

  it("ignores anything that is not ours", () => {
    expect(interpretSignupMessage("not json").kind).toBe("ignore");
    expect(interpretSignupMessage({ type: "SOMETHING_ELSE" }).kind).toBe("ignore");
    expect(interpretSignupMessage(null).kind).toBe("ignore");
    expect(interpretSignupMessage(undefined).kind).toBe("ignore");
  });

  it("treats an unknown completion event as assets, not as failure", () => {
    // Embedded Signup v2 is deprecated on 2026-10-15 and v4 may add events
    // this build has never seen. Treating an unrecognised one as a
    // cancellation would break the flow the day Meta ships it.
    const msg = interpretSignupMessage({
      type: "WA_EMBEDDED_SIGNUP",
      event: "FINISH_SOMETHING_NEW_IN_V4",
      data: { business_id: "biz_1" },
    });
    expect(msg.kind).toBe("assets");
  });
});

// ─── Asset merging ───────────────────────────────────────────

describe("mergeSignupAssets", () => {
  it("keeps the portfolio id when a later event omits it", () => {
    // THE bug this function exists to prevent. `business_id` is the only
    // source of the business portfolio id; losing it silently downgrades the
    // whole inspection while everything still looks like it worked.
    const merged = mergeSignupAssets(
      { businessPortfolioId: "biz_1", wabaIds: ["w1"] },
      { wabaIds: ["w2"] },
    );
    expect(merged.businessPortfolioId).toBe("biz_1");
    expect(merged.wabaIds).toEqual(["w2"]);
  });

  it("keeps known WABAs when a later event has none", () => {
    const merged = mergeSignupAssets({ wabaIds: ["w1"] }, { businessPortfolioId: "biz_2" });
    expect(merged.wabaIds).toEqual(["w1"]);
    expect(merged.businessPortfolioId).toBe("biz_2");
  });

  it("takes new values over old ones", () => {
    const merged = mergeSignupAssets(
      { businessPortfolioId: "old", wabaIds: ["old"] },
      { businessPortfolioId: "new", wabaIds: ["new"] },
    );
    expect(merged).toEqual({ businessPortfolioId: "new", wabaIds: ["new"] });
  });
});

// ─── Login response ──────────────────────────────────────────

describe("readAuthCode", () => {
  it("reads the code from a successful login", () => {
    expect(readAuthCode({ authResponse: { code: "AQD123" } })).toBe("AQD123");
  });

  it("returns null when the customer closed or declined the popup", () => {
    // A normal outcome, not an error. The panel must return to idle rather
    // than showing a failure or hanging on "Opening WhatsApp...".
    expect(readAuthCode({ status: "unknown" })).toBeNull();
    expect(readAuthCode({ authResponse: null })).toBeNull();
    expect(readAuthCode({ authResponse: { code: "" } })).toBeNull();
    expect(readAuthCode(undefined)).toBeNull();
    expect(readAuthCode(null)).toBeNull();
  });
});

// ─── Outcome copy ────────────────────────────────────────────

describe("outcomeMessageKey", () => {
  it("maps every reason the server can return", () => {
    expect(outcomeMessageKey("NO_CANDIDATES")).toBe("whatsappNumbers.outcome.noCandidates");
    expect(outcomeMessageKey("ALL_ALREADY_CONNECTED")).toBe(
      "whatsappNumbers.outcome.allAlreadyConnected",
    );
    expect(outcomeMessageKey("ALL_BLOCKED")).toBe("whatsappNumbers.outcome.allBlocked");
  });

  it("falls back to a real key for a reason it does not know", () => {
    // Never render a raw enum at a customer, even if the server adds a reason
    // this build has not seen.
    expect(outcomeMessageKey("SOMETHING_NEW")).toBe("whatsappNumbers.outcome.unknown");
  });
});

// ─── The copy exists in both locales ─────────────────────────

describe("outcome copy is translated", () => {
  it("has an English and Hebrew string for every key the logic can produce", async () => {
    const en = (await import("../../i18n/en.json")).default as any;
    const he = (await import("../../i18n/he.json")).default as any;
    const reasons = [
      "NO_CANDIDATES",
      "ALL_ALREADY_CONNECTED",
      "ALL_BLOCKED",
      "SOMETHING_NEW",
    ];
    for (const reason of reasons) {
      const key = outcomeMessageKey(reason);
      const leaf = key.split(".").reduce<any>((acc, k) => acc?.[k], en);
      const leafHe = key.split(".").reduce<any>((acc, k) => acc?.[k], he);
      expect(typeof leaf, `${key} missing in en`).toBe("string");
      expect(typeof leafHe, `${key} missing in he`).toBe("string");
    }
  });
});

