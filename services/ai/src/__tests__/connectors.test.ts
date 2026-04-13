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
  it("default stub CRM connector is registered and returns ok", async () => {
    const c = getCrmConnector();
    expect(c).not.toBeNull();
    const r = await c!.updateContact("t1", { contactId: "c1", fields: { tier: "vip" } });
    expect(r.ok).toBe(true);
  });

  it("default stub messaging connector sends successfully", async () => {
    const c = getMessagingConnector();
    expect(c).not.toBeNull();
    const r = await c!.send("t1", { contactId: "c1", channel: "whatsapp", body: "hi" });
    expect(r.ok).toBe(true);
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
