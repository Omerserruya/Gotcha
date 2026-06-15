import { describe, it, expect } from "vitest";
import {
  getCrmConnector,
  getMessagingConnector,
  registerCrmConnector,
  registerMessagingConnector,
  CrmConnector,
  MessagingConnector,
} from "../services/connectors/types";

describe("connector registry", () => {
  it("default CRM connector refuses with explicit error (no fake success)", async () => {
    // Per OMC_EXECUTION_MAP: no fake success is allowed. The default CRM
    // connector is "unconfigured" and returns ok:false with a clear error
    // so callers must register a real connector before CRM actions can ship.
    const c = getCrmConnector();
    expect(c).not.toBeNull();
    const r = await c!.updateContact("t1", { contactId: "c1", fields: { tier: "vip" } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no CRM connector/i);
  });

  it("default messaging connector is the real queue-backed implementation", async () => {
    // The default messaging connector enqueues to outgoingMessageQueue - a
    // real side effect. Without a DB it naturally fails; we only assert the
    // connector is registered and has the expected name so tests that do
    // provide a DB exercise the real path.
    const c = getMessagingConnector();
    expect(c).not.toBeNull();
    expect(c!.name).toBe("outgoing-queue");
  });

  it("named lookup returns null for unknown connector", () => {
    expect(getCrmConnector("nope")).toBeNull();
    expect(getMessagingConnector("nope")).toBeNull();
  });

  it("custom connector registration is retrievable by name", async () => {
    const fake: CrmConnector = {
      name: "hubspot-fake",
      async updateContact() {
        return { ok: true, externalId: "hs_1" };
      },
      async createTicket() {
        return { ok: true, externalId: "hs_tkt_1" };
      },
    };
    registerCrmConnector(fake);
    const r = await getCrmConnector("hubspot-fake")!.updateContact("t1", {
      contactId: "c1",
      fields: {},
    });
    expect(r.externalId).toBe("hs_1");

    const msg: MessagingConnector = {
      name: "twilio-fake",
      async send() {
        return { ok: true, messageId: "sm_1" };
      },
    };
    registerMessagingConnector(msg);
    const s = await getMessagingConnector("twilio-fake")!.send("t1", {
      contactId: "c1",
      channel: "sms",
      body: "hi",
    });
    expect(s.messageId).toBe("sm_1");
  });
});
