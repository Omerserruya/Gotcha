/**
 * What the number card actually tells a customer.
 *
 * A merchant connected a number and was shown this, in Meta's English, as one
 * flat list of equal-weight ticks and crosses:
 *
 *   ✓ Connected to WhatsApp        ✕ Messaging enabled
 *   ✓ Receiving incoming messages  ✓ Number verified
 *   ? Quality rating               ✕ Phone number (not linked)
 *   ✕ Phone number (SIP)           ✕ WhatsApp account (payment method)
 *   ! Business verification
 *
 * Their words: "that looks not user friendly at all + i dont get what to do."
 * Fair. Two of those crosses are about SIP calling, which this product does not
 * offer and no customer can act on. One of them - the number was never
 * registered - is the entire reason nothing sends, and it looked exactly like
 * the other four.
 *
 * The fixture below is that customer's real production snapshot.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@chatcenter/shared", () => ({
  prisma: {},
  decryptCredentials: () => null,
}));

import { buildHealthReport } from "../services/whatsapp/health.service";

const SNAPSHOT = {
  can_send_message: "BLOCKED",
  entities: [
    {
      id: "1292013250655408",
      entity_type: "PHONE_NUMBER",
      can_send_message: "BLOCKED",
      errors: [
        {
          error_code: 141000,
          error_description:
            "The phone number you are trying to send messages from is not linked to your WhatsApp account.",
          possible_solution: "Register and finish the OTP authentication process for your phone number.",
        },
        {
          error_code: 138024,
          error_description: "WhatsApp Business calling cannot use SIP because it is not enabled",
          possible_solution: "Configure SIP using {PHONE_NUMBER_ID}/settings API",
        },
      ],
    },
    {
      id: "2223476021776931",
      entity_type: "WABA",
      can_send_message: "BLOCKED",
      errors: [
        {
          error_code: 141006,
          error_description:
            "There is an error with the payment method. This will block business initiated conversations.",
          possible_solution: "Please add a new payment method to the account.",
        },
      ],
    },
    {
      id: "1551544506613779",
      entity_type: "APP",
      can_send_message: "AVAILABLE",
      errors: [
        {
          error_code: 138025,
          error_description: "This app cannot use SIP for WhatsApp Business calling",
          possible_solution: "Configure SIP server using {PHONE_NUMBER_ID}/settings API",
        },
      ],
    },
  ],
};

const ROW = {
  id: "n1",
  phoneNumberId: "1292013250655408",
  displayPhoneNumber: "+972 3-382-2781",
  verifiedName: "Gotcha App",
  state: "DEGRADED",
  pendingAction: null,
  messagingStatus: "PENDING",
  codeVerificationStatus: "VERIFIED",
  qualityRating: "UNKNOWN",
  webhookSubscribed: true,
  webhookOverrideUri: null,
  canSendMessage: "BLOCKED",
  healthSnapshot: SNAPSHOT,
  lastError: null,
  lastHealthCheck: new Date(),
} as never;

describe("the number card, on a real blocked number", () => {
  const report = buildHealthReport(ROW);

  it("names the one thing the customer can actually clear from here", () => {
    // DEGRADED with no pendingAction: keying the finish-setup box on
    // pendingAction alone left this customer with no button at all.
    expect(report.needsRegistration).toBe(true);
  });

  it("does not show SIP calling problems to anyone", () => {
    const sip = report.checks.filter((c) => /SIP/i.test(`${c.detail ?? ""}${c.metaSolution ?? ""}`));
    expect(sip).toEqual([]);
  });

  it("separates what stops messages from what is merely worth knowing", () => {
    const blocking = report.checks.filter((c) => c.status !== "PASS" && c.blocking);
    const advisory = report.checks.filter((c) => c.status !== "PASS" && !c.blocking);

    // The registration failure is blocking; it is why nothing sends.
    expect(blocking.some((c) => c.id === "REGISTRATION")).toBe(true);
    // Quality rating is unknown, not broken - it must not sit next to it.
    expect(advisory.some((c) => c.id === "QUALITY")).toBe(true);
    expect(blocking.some((c) => c.id === "QUALITY")).toBe(false);
  });

  it("does not claim messages are arriving on a number that was never registered", () => {
    // The webhook subscription exists, but WhatsApp delivers nothing for an
    // unregistered number - so "Receiving incoming messages ✓" was a lie that
    // sent a customer looking for their messages in the inbox.
    const webhooks = report.checks.find((c) => c.id === "WEBHOOKS");
    expect(webhooks?.status).toBe("FAIL");
    expect(webhooks?.detail).toMatch(/registration/i);
    expect(report.ready).toBe(false);
  });

  it("keeps Meta's own wording for the problems only Meta can resolve", () => {
    const payment = report.checks.find((c) => c.metaErrorCode === 141006);
    expect(payment?.metaSolution).toContain("payment method");
  });
});
