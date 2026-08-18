import { describe, it, expect, vi } from "vitest";
import { selectFlow } from "../whatsapp/flow-selector";

/**
 * The call that actually starts a Coexistence history sync.
 *
 * Meta requires `POST /<PHONE_NUMBER_ID>/smb_app_data` with
 * `sync_type: history`. Subscribing to the `history` webhook field only says
 * WHERE to deliver - it asks for nothing.
 *
 * We had the subscription and never made the call, so the entire historical
 * import could not fire for anyone. It was invisible: the field was subscribed,
 * the number connected, every pipeline step reported SUCCESS, and no history
 * arrived. These tests exist so that combination can never be reached again.
 *
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/
 */

function coexistenceInspection() {
  return {
    numbers: [
      {
        phoneNumberId: "PN_1",
        displayPhoneNumber: "+972 55-263-3304",
        verifiedName: "Test",
        wabaId: "WABA_1",
        platformType: "CLOUD_API",
        isOnBizApp: true,
        kind: "COEXISTENCE" as const,
        status: "CONNECTED",
        webhookSubscribed: true,
        connectedToThisTenant: false,
        connectedToAnotherTenant: false,
        blockers: [],
      },
    ],
    wabas: [{ wabaId: "WABA_1", appSubscribed: true }],
    missingPermissions: [],
    degraded: false,
    degradedReasons: [],
  } as any;
}

describe("the Coexistence pipeline asks Meta for the history", () => {
  it("includes REQUEST_HISTORY_SYNC in the automated steps", () => {
    const decision = selectFlow({
      inspection: coexistenceInspection(),
      targetPhoneNumberId: "PN_1",
    });
    expect(decision.scenario).toBe("COEXISTENCE");
    expect(decision.automatedSteps).toContain("REQUEST_HISTORY_SYNC");
  });

  it("runs it LAST", () => {
    // Once-only per onboarding and unrepeatable without the customer
    // offboarding, so it must not fire on a run that is about to fail for an
    // unrelated reason.
    const decision = selectFlow({
      inspection: coexistenceInspection(),
      targetPhoneNumberId: "PN_1",
    });
    const steps = decision.automatedSteps;
    expect(steps[steps.length - 1]).toBe("REQUEST_HISTORY_SYNC");
  });

  it("does NOT ask for history on a number that was never on the Business app", () => {
    // Meta rejects it, and a number with no Business app has no history.
    const inspection = coexistenceInspection();
    inspection.numbers[0].isOnBizApp = false;
    inspection.numbers[0].kind = "CLOUD_API";
    const decision = selectFlow({ inspection, targetPhoneNumberId: "PN_1" });
    expect(decision.automatedSteps).not.toContain("REQUEST_HISTORY_SYNC");
  });
});

describe("the Graph client sends exactly what Meta documents", () => {
  it("posts to smb_app_data with the documented body", async () => {
    const { MetaWhatsAppClient } = await import("../whatsapp/meta-client");
    const calls: any[] = [];
    const client = new MetaWhatsAppClient({ accessToken: "t" });
    (client as any).http = {
      request: async (cfg: any) => {
        calls.push(cfg);
        return { status: 200, data: { success: true } };
      },
    };

    const res = await client.requestSmbSync("PN_1", "history");
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("post");
    expect(calls[0].url).toMatch(/\/PN_1\/smb_app_data$/);
    // The body is the whole contract. A wrong sync_type is accepted by Meta
    // and simply does nothing.
    expect(calls[0].data).toEqual({ messaging_product: "whatsapp", sync_type: "history" });
  });

  it("sends smb_app_state_sync for contacts", async () => {
    const { MetaWhatsAppClient } = await import("../whatsapp/meta-client");
    const calls: any[] = [];
    const client = new MetaWhatsAppClient({ accessToken: "t" });
    (client as any).http = {
      request: async (cfg: any) => {
        calls.push(cfg);
        return { status: 200, data: { success: true } };
      },
    };
    await client.requestSmbSync("PN_1", "smb_app_state_sync");
    expect(calls[0].data).toEqual({
      messaging_product: "whatsapp",
      sync_type: "smb_app_state_sync",
    });
  });

  it("reports a refusal instead of throwing, so onboarding survives it", async () => {
    // The number works either way. Losing the history import is an onboarding
    // bonus; losing the connection would be the channel.
    const { MetaWhatsAppClient } = await import("../whatsapp/meta-client");
    const client = new MetaWhatsAppClient({ accessToken: "t" });
    (client as any).http = {
      request: async () => {
        const err: any = new Error("boom");
        err.response = { status: 400, data: { error: { code: 100, message: "bad" } } };
        throw err;
      },
    };
    const res = await client.requestSmbSync("PN_1", "history");
    expect(res.ok).toBe(false);
  });

  it("logs every Graph call, including the failures", async () => {
    // The defect was invisible because we only logged the steps we DID run.
    const { MetaWhatsAppClient } = await import("../whatsapp/meta-client");
    const logged: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((m) => void logged.push(String(m)));
    const err = vi.spyOn(console, "error").mockImplementation((m) => void logged.push(String(m)));
    try {
      const client = new MetaWhatsAppClient({ accessToken: "t" });
      (client as any).http = { request: async () => ({ status: 200, data: { success: true } }) };
      await client.requestSmbSync("PN_1", "history");
      expect(logged.some((l) => l.includes("[meta-graph]") && l.includes("smb_app_data"))).toBe(true);
      // The token must never reach a log line.
      expect(logged.join("\n")).not.toContain("Bearer");
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
});
