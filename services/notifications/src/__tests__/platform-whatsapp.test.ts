/**
 * GOTCHA's own WhatsApp number, and the templates it may send.
 *
 * Two failures this guards, both of which would surface only as "WhatsApp
 * failed" from Meta:
 *
 *   * a template whose declared parameter count disagrees with its own text, in
 *     EITHER language - Meta answers a parameter mismatch generically, so the
 *     count has to be checked here where it is knowable
 *   * a platform alert sent from the merchant's customer-facing number, which is
 *     what happens the moment a caller treats "no platform number" as a reason
 *     to fall back
 *
 * Nothing here can be verified against a real WABA until one is provisioned.
 * These tests pin the shape and the guards; the send itself is untested against
 * Meta and that is stated rather than implied.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  PLATFORM_TEMPLATES,
  TEMPLATE_LOCALES,
  templateFor,
  getPlatformWhatsAppSender,
  whatsAppReadiness,
  buildComponents,
} from "../services/platform-whatsapp";

const ENV = { id: process.env.PLATFORM_WHATSAPP_PHONE_NUMBER_ID, token: process.env.PLATFORM_WHATSAPP_ACCESS_TOKEN };

beforeEach(() => {
  delete process.env.PLATFORM_WHATSAPP_PHONE_NUMBER_ID;
  delete process.env.PLATFORM_WHATSAPP_ACCESS_TOKEN;
});

afterEach(() => {
  if (ENV.id) process.env.PLATFORM_WHATSAPP_PHONE_NUMBER_ID = ENV.id;
  if (ENV.token) process.env.PLATFORM_WHATSAPP_ACCESS_TOKEN = ENV.token;
});

/** How many distinct `{{n}}` placeholders a body actually uses. */
function placeholders(body: string): number {
  return new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;
}

describe("the templates agree with themselves", () => {
  it("★ declares a parameter count matching its own text, in every language", () => {
    for (const [eventType, template] of Object.entries(PLATFORM_TEMPLATES)) {
      for (const locale of TEMPLATE_LOCALES) {
        expect(
          placeholders(template.body[locale]),
          `${eventType} (${locale}) has ${placeholders(template.body[locale])} placeholder(s) but declares ${template.parameterCount}`,
        ).toBe(template.parameterCount);
      }
    }
  });

  it("exists in both languages, non-empty", () => {
    // A missing Hebrew body would send English to a Hebrew recipient, or fail,
    // depending on what Meta has approved - neither discoverable from here.
    for (const [eventType, template] of Object.entries(PLATFORM_TEMPLATES)) {
      for (const locale of TEMPLATE_LOCALES) {
        expect(template.body[locale]?.trim(), `${eventType} (${locale})`).toBeTruthy();
      }
    }
  });

  it("uses a distinct Meta name per event", () => {
    const names = Object.values(PLATFORM_TEMPLATES).map((t) => t.name);
    // Two events sharing a name would silently send one event's wording for the
    // other, because Meta resolves by name alone.
    expect(new Set(names).size).toBe(names.length);
  });

  it("names templates in the gotcha_ namespace", () => {
    // The platform's templates live on GOTCHA's own WABA beside nothing else
    // today, but a merchant's templates will never collide with a prefixed name.
    for (const t of Object.values(PLATFORM_TEMPLATES)) {
      expect(t.name.startsWith("gotcha_")).toBe(true);
    }
  });
});

describe("the platform number is never substituted", () => {
  it("returns null when the deployment has no number", () => {
    // Null is the real answer. A caller must skip WhatsApp and say so, never
    // borrow the tenant's customer-facing channel.
    expect(getPlatformWhatsAppSender()).toBeNull();
  });

  it("returns null when only one half is configured", () => {
    process.env.PLATFORM_WHATSAPP_PHONE_NUMBER_ID = "123456";
    expect(getPlatformWhatsAppSender()).toBeNull();

    delete process.env.PLATFORM_WHATSAPP_PHONE_NUMBER_ID;
    process.env.PLATFORM_WHATSAPP_ACCESS_TOKEN = "tok";
    expect(getPlatformWhatsAppSender()).toBeNull();
  });

  it("ignores whitespace-only configuration", () => {
    process.env.PLATFORM_WHATSAPP_PHONE_NUMBER_ID = "   ";
    process.env.PLATFORM_WHATSAPP_ACCESS_TOKEN = "   ";
    expect(getPlatformWhatsAppSender()).toBeNull();
  });

  it("returns the sender when both halves are present", () => {
    process.env.PLATFORM_WHATSAPP_PHONE_NUMBER_ID = "123456";
    process.env.PLATFORM_WHATSAPP_ACCESS_TOKEN = "tok";
    expect(getPlatformWhatsAppSender()).toEqual({ externalId: "123456", accessToken: "tok" });
  });
});

describe("readiness distinguishes its two failures", () => {
  it("says no_platform_number when the event has a template but GOTCHA has no number", () => {
    const readiness = whatsAppReadiness("tool.approval_required");

    expect(readiness.ready).toBe(false);
    if (readiness.ready) return;
    // This is the state of the deployment today, and it is temporary.
    expect(readiness.reason).toBe("no_platform_number");
  });

  it("says no_template_for_event for an event nothing can carry", () => {
    process.env.PLATFORM_WHATSAPP_PHONE_NUMBER_ID = "123456";
    process.env.PLATFORM_WHATSAPP_ACCESS_TOKEN = "tok";

    const readiness = whatsAppReadiness("broadcast.completed");

    expect(readiness.ready).toBe(false);
    if (readiness.ready) return;
    // Permanent until somebody writes and submits a template. A different
    // sentence from the one above, which is why it is a reason and not a false.
    expect(readiness.reason).toBe("no_template_for_event");
  });

  it("is ready only when both halves are in place", () => {
    process.env.PLATFORM_WHATSAPP_PHONE_NUMBER_ID = "123456";
    process.env.PLATFORM_WHATSAPP_ACCESS_TOKEN = "tok";

    const readiness = whatsAppReadiness("credit.exhausted");

    expect(readiness.ready).toBe(true);
    if (!readiness.ready) return;
    expect(readiness.template.name).toBe("gotcha_credit_exhausted");
    expect(readiness.sender.externalId).toBe("123456");
  });

  it("has no template for an unknown event", () => {
    expect(templateFor("something.invented")).toBeNull();
  });
});

describe("components are built or refused, never sent wrong", () => {
  it("wraps body parameters in Meta's shape", () => {
    const template = PLATFORM_TEMPLATES["credit.threshold"]!;

    expect(buildComponents(template, ["90"])).toEqual([
      { type: "body", parameters: [{ type: "text", text: "90" }] },
    ]);
  });

  it("returns no components for a template that takes none", () => {
    const template = PLATFORM_TEMPLATES["credit.exhausted"]!;

    // An empty `components` array is omitted by the adapter, which is what Meta
    // expects for a parameterless template.
    expect(buildComponents(template, [])).toEqual([]);
  });

  it("★ throws on the wrong parameter count rather than letting Meta refuse it", () => {
    const template = PLATFORM_TEMPLATES["credit.threshold"]!;

    // Meta answers a mismatch generically, so the caller would learn only that
    // "WhatsApp failed". The count is knowable here, before the request.
    expect(() => buildComponents(template, [])).toThrow(/takes 1 parameter\(s\), received 0/);
    expect(() => buildComponents(template, ["90", "extra"])).toThrow(/received 2/);
  });
});
