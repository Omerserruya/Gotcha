/**
 * Meta's word that our app lost a business's WhatsApp account (2026-11-22).
 *
 * The shape is the one a real PARTNER_REMOVED delivery had:
 *   entry[0].id, changes[0].field "account_update",
 *   value { event, waba_info: { waba_id, owner_business_id },
 *           disconnection_info: { reason, initiated_by } }
 * and on that delivery entry.id was NOT the business's WABA. So the WABA comes
 * from value.waba_info.waba_id and from nowhere else.
 */
import { describe, it, expect } from "vitest";
import { whatsappAccessRemoval, WHATSAPP_ACCESS_REMOVAL_EVENTS } from "../whatsapp/access-removal";

const value = (event: string, over: Record<string, unknown> = {}) => ({
  event,
  waba_info: { waba_id: "200000000000002", owner_business_id: "300000000000003" },
  disconnection_info: { reason: "ACCOUNT_DISCONNECTED", initiated_by: "USER" },
  ...over,
});

describe("whatsappAccessRemoval", () => {
  it("the two events that mean it, and only those two", () => {
    expect([...WHATSAPP_ACCESS_REMOVAL_EVENTS]).toEqual(["PARTNER_REMOVED", "PARTNER_APP_UNINSTALLED"]);
  });

  it("★ PARTNER_REMOVED: the WABA named inside the value", () => {
    expect(whatsappAccessRemoval(value("PARTNER_REMOVED"))).toEqual({ wabaId: "200000000000002", event: "PARTNER_REMOVED" });
  });

  it("★ PARTNER_APP_UNINSTALLED the same", () => {
    expect(whatsappAccessRemoval(value("PARTNER_APP_UNINSTALLED"))).toEqual({ wabaId: "200000000000002", event: "PARTNER_APP_UNINSTALLED" });
  });

  it("a numeric id is read as its digits", () => {
    expect(whatsappAccessRemoval(value("PARTNER_REMOVED", { waba_info: { waba_id: 200000000000002 } }))).toEqual({ wabaId: "200000000000002", event: "PARTNER_REMOVED" });
  });

  it.each([
    ["PARTNER_ADDED"], ["PARTNER_APP_INSTALLED"], ["ACCOUNT_VIOLATION"], ["DISABLED_UPDATE"], ["ACCOUNT_RESTRICTION"], ["VERIFIED_ACCOUNT"],
    ["partner_removed"], ["PARTNER_REMOVED "], [""], [undefined], [null], [7],
  ])("event %j is not a removal", (event) => {
    expect(whatsappAccessRemoval(value(event as any))).toBeNull();
  });

  it.each([
    ["no waba_info at all", { waba_info: undefined }],
    ["a null waba_info", { waba_info: null }],
    ["an empty waba_id", { waba_info: { waba_id: "" } }],
    ["a blank waba_id", { waba_info: { waba_id: "   " } }],
    ["a waba_id that is an object", { waba_info: { waba_id: { id: "200000000000002" } } }],
    ["only the owner's business id", { waba_info: { owner_business_id: "300000000000003" } }],
  ])("a removal with %s names no WABA, so it is nothing", (_name, over) => {
    expect(whatsappAccessRemoval(value("PARTNER_REMOVED", over))).toBeNull();
  });

  it.each([[null], [undefined], ["PARTNER_REMOVED"], [42], [[]]])("%j is nothing", (v) => {
    expect(whatsappAccessRemoval(v)).toBeNull();
  });
});
