/**
 * Automatic onboarding flow selection.
 *
 * Every case here maps to a way the previous single-number implementation
 * could hurt a real customer:
 *
 *   * connecting EVERY number on the WABA when they asked for one
 *   * routing a WhatsApp Business app number into a flow that ignores the app
 *   * re-registering an already-registered number and burning its 72-hour
 *     registration budget on a PIN prompt nobody needed
 *   * offering "move completely to GOTCHA" for a number Meta will not migrate
 *   * reporting a number connected while its webhooks belong to someone else
 */
import { describe, it, expect } from "vitest";
import {
  selectFlow,
  evaluateMigration,
  businessAppOptions,
  classifyNumber,
  type InspectedNumber,
  type InspectedWaba,
  type MetaInspection,
} from "../whatsapp";

// ─── Fixtures ────────────────────────────────────────────────

function number(overrides: Partial<InspectedNumber> = {}): InspectedNumber {
  return {
    phoneNumberId: "pn_1",
    displayPhoneNumber: "+972 50-000-0000",
    verifiedName: "Test Business",
    wabaId: "waba_1",
    platformType: "CLOUD_API",
    isOnBizApp: false,
    status: "CONNECTED",
    codeVerificationStatus: "VERIFIED",
    nameStatus: "APPROVED",
    qualityRating: "GREEN",
    kind: "CLOUD_API",
    webhookSubscribed: true,
    connectedToThisTenant: false,
    connectedToAnotherTenant: false,
    blockers: [],
    ...overrides,
  };
}

function waba(overrides: Partial<InspectedWaba> = {}): InspectedWaba {
  return {
    wabaId: "waba_1",
    name: "Test WABA",
    accountReviewStatus: "APPROVED",
    businessVerificationStatus: "verified",
    readable: true,
    appSubscribed: true,
    hasPaymentMethod: true,
    numberIds: ["pn_1"],
    ...overrides,
  };
}

function inspection(overrides: Partial<MetaInspection> = {}): MetaInspection {
  return {
    inspectedAt: "2026-08-05T00:00:00.000Z",
    grantedScopes: [
      "whatsapp_business_management",
      "whatsapp_business_messaging",
      "business_management",
    ],
    missingPermissions: [],
    degraded: false,
    degradedReasons: [],
    portfolios: [],
    wabas: [waba()],
    numbers: [number()],
    errors: [],
    ...overrides,
  };
}

// ─── classifyNumber ──────────────────────────────────────────

describe("classifyNumber", () => {
  it("treats CLOUD_API + is_on_biz_app as Coexistence, not plain Cloud API", () => {
    // The two states are indistinguishable on platform_type alone, which is
    // why is_on_biz_app has to be requested explicitly from Meta.
    expect(classifyNumber({ id: "x", platform_type: "CLOUD_API", is_on_biz_app: true })).toBe(
      "COEXISTENCE",
    );
    expect(classifyNumber({ id: "x", platform_type: "CLOUD_API" })).toBe("CLOUD_API");
  });

  it("does not read a missing is_on_biz_app as false", () => {
    // Meta omits the field where it does not apply. Undefined is "not
    // applicable", and conflating it with false would misclassify.
    expect(classifyNumber({ id: "x", platform_type: "CLOUD_API", is_on_biz_app: undefined })).toBe(
      "CLOUD_API",
    );
  });

  it("treats an absent platform_type as an unregistered number", () => {
    expect(classifyNumber({ id: "x" })).toBe("UNREGISTERED");
    expect(classifyNumber({ id: "x", platform_type: "NOT_APPLICABLE" })).toBe("UNREGISTERED");
  });
});

// ─── Scenario routing ────────────────────────────────────────

describe("selectFlow scenarios", () => {
  it("A: no numbers at all means create one", () => {
    const d = selectFlow({ inspection: inspection({ numbers: [], wabas: [] }) });
    expect(d.scenario).toBe("NEW_NUMBER");
    expect(d.automatedSteps).toContain("REGISTER_NUMBER");
    expect(d.customerAction).toBe("VERIFICATION_CODE");
  });

  it("A: a number that exists but was never registered still needs registering", () => {
    const n = number({ kind: "UNREGISTERED", platformType: "NOT_APPLICABLE" });
    const d = selectFlow({ inspection: inspection({ numbers: [n] }) });
    expect(d.scenario).toBe("NEW_NUMBER");
    expect(d.automatedSteps).toContain("REGISTER_NUMBER");
  });

  it("B: a Business app number goes to Coexistence and is NOT re-registered", () => {
    // Meta: "skip the phone number registration step, as the number is
    // already registered." Registering would spend one of ten calls in the
    // customer's 72-hour window to achieve nothing.
    const n = number({ kind: "COEXISTENCE", isOnBizApp: true });
    const d = selectFlow({ inspection: inspection({ numbers: [n] }) });
    expect(d.scenario).toBe("COEXISTENCE");
    expect(d.automatedSteps).not.toContain("REGISTER_NUMBER");
    expect(d.customerAction).toBe("BUSINESS_APP_CONFIRMATION");
  });

  it("B is checked before C, because a Coexistence number is also CLOUD_API", () => {
    // If the plain Cloud API branch ran first, every Business app customer
    // would be routed into a flow that never mentions their app.
    const n = number({ kind: "COEXISTENCE", isOnBizApp: true, platformType: "CLOUD_API" });
    expect(selectFlow({ inspection: inspection({ numbers: [n] }) }).scenario).toBe("COEXISTENCE");
  });

  it("C: an existing Cloud API number is reused, never re-registered", () => {
    const d = selectFlow({ inspection: inspection() });
    expect(d.scenario).toBe("EXISTING_CLOUD_API");
    expect(d.automatedSteps).not.toContain("REGISTER_NUMBER");
    // No PIN prompt: the number is already registered, so asking for a
    // two-step PIN would be friction with no purpose.
    expect(d.customerAction).toBeNull();
  });

  it("D: a number already connected here is revalidated, not re-onboarded", () => {
    const n = number({ connectedToThisTenant: true });
    const d = selectFlow({ inspection: inspection({ numbers: [n] }) });
    expect(d.scenario).toBe("RECONNECT");
    expect(d.automatedSteps).not.toContain("REGISTER_NUMBER");
  });
});

// ─── The multi-number rule ───────────────────────────────────

describe("multi-number safety", () => {
  it("refuses to guess when several numbers could be meant", () => {
    // This is the whole bug: the old route looped over every number on the
    // WABA and rebound all of them. Refusing to choose is the fix.
    const inspect = inspection({
      numbers: [number({ phoneNumberId: "pn_1" }), number({ phoneNumberId: "pn_2" })],
    });
    const d = selectFlow({ inspection: inspect });
    expect(d.scenario).toBe("BLOCKED");
    expect(d.blockers[0].code).toBe("CHOICE_REQUIRED");
  });

  it("decides for the one number it was actually asked about", () => {
    const inspect = inspection({
      numbers: [
        number({ phoneNumberId: "pn_1", connectedToThisTenant: true }),
        number({ phoneNumberId: "pn_2", kind: "COEXISTENCE", isOnBizApp: true }),
      ],
    });
    const d = selectFlow({ inspection: inspect, targetPhoneNumberId: "pn_2" });
    expect(d.scenario).toBe("COEXISTENCE");
    expect(d.phoneNumberId).toBe("pn_2");
  });

  it("picks the single unconnected number when the rest are already ours", () => {
    const inspect = inspection({
      numbers: [
        number({ phoneNumberId: "pn_1", connectedToThisTenant: true }),
        number({ phoneNumberId: "pn_2" }),
      ],
    });
    expect(selectFlow({ inspection: inspect }).phoneNumberId).toBe("pn_2");
  });
});

// ─── Blocking ────────────────────────────────────────────────

describe("blocking", () => {
  it("blocks when a required permission is missing, before touching anything", () => {
    const d = selectFlow({
      inspection: inspection({ missingPermissions: ["whatsapp_business_management"] }),
    });
    expect(d.scenario).toBe("BLOCKED");
    expect(d.automatedSteps).toEqual([]);
  });

  it("does not block merely because the optional permission is missing", () => {
    // business_management degrades the sweep; it must not stop onboarding.
    const d = selectFlow({
      inspection: inspection({ missingPermissions: ["business_management"], degraded: true }),
    });
    expect(d.scenario).toBe("EXISTING_CLOUD_API");
  });

  it("blocks a number that belongs to another workspace", () => {
    const n = number({
      connectedToAnotherTenant: true,
      blockers: [
        { code: "CONNECTED_ELSEWHERE", message: "Connected elsewhere.", customerActionable: true },
      ],
    });
    expect(selectFlow({ inspection: inspection({ numbers: [n] }) }).scenario).toBe("BLOCKED");
  });

  it("blocks a number whose webhooks another platform already owns", () => {
    // Subscribing anyway would produce a channel that looks connected while
    // every inbound message goes to the other platform.
    const n = number({
      webhookOverrideUri: "https://other-platform.example/webhook",
      blockers: [
        { code: "WEBHOOK_OVERRIDDEN", message: "Another platform owns this.", customerActionable: true },
      ],
    });
    expect(selectFlow({ inspection: inspection({ numbers: [n] }) }).scenario).toBe("BLOCKED");
  });

  it("blocks rather than guesses on an unrecognised platform_type", () => {
    const n = number({ kind: "UNKNOWN", platformType: "SOMETHING_META_SHIPPED_LATER" });
    const d = selectFlow({ inspection: inspection({ numbers: [n] }) });
    expect(d.scenario).toBe("BLOCKED");
  });
});

// ─── Migration ───────────────────────────────────────────────

describe("evaluateMigration", () => {
  const source = waba({ wabaId: "waba_src" });
  const destination = waba({ wabaId: "waba_dst" });

  it("offers migration when every documented prerequisite holds", () => {
    const offer = evaluateMigration(number({ wabaId: "waba_src" }), source, destination);
    expect(offer).not.toBeNull();
    expect(offer!.verified.length).toBeGreaterThan(4);
  });

  it("never offers migration for a WhatsApp Business app number", () => {
    // Meta: "Business phone numbers in use with the WhatsApp Business App
    // cannot be migrated using this process." Absolute.
    const n = number({ wabaId: "waba_src", isOnBizApp: true, kind: "COEXISTENCE" });
    expect(evaluateMigration(n, source, destination)).toBeNull();
  });

  it.each([
    ["display name not approved", { nameStatus: "PENDING_REVIEW" }, {}, {}],
    ["source not verified", {}, { businessVerificationStatus: "not_verified" }, {}],
    ["source not review-approved", {}, { accountReviewStatus: "PENDING" }, {}],
    ["destination not verified", {}, {}, { businessVerificationStatus: "not_verified" }],
    ["destination has no payment method", {}, {}, { hasPaymentMethod: false }],
    ["destination has no webhook subscriber", {}, {}, { appSubscribed: false }],
  ])("withholds the migration option when %s", (_label, numPatch, srcPatch, dstPatch) => {
    // Any single unmet prerequisite hides the option entirely. A migration
    // that fails halfway leaves the number verified against a WABA it no
    // longer belongs to, which is worse than never starting.
    const offer = evaluateMigration(
      number({ wabaId: "waba_src", ...(numPatch as object) }),
      waba({ wabaId: "waba_src", ...(srcPatch as object) }),
      waba({ wabaId: "waba_dst", ...(dstPatch as object) }),
    );
    expect(offer).toBeNull();
  });

  it("does not offer to migrate a number to the account it is already on", () => {
    expect(evaluateMigration(number(), source, source)).toBeNull();
  });

  it("does not attach a migration offer unless a destination was asked for", () => {
    expect(selectFlow({ inspection: inspection() }).migrationOffer).toBeUndefined();
  });
});

// ─── Phase 6: the Business app choice ────────────────────────

describe("businessAppOptions", () => {
  const opts = businessAppOptions();

  it("recommends keeping the WhatsApp Business app", () => {
    expect(opts.keepUsingBusinessApp.recommended).toBe(true);
  });

  it("does not offer full migration, because Meta publishes no API for it", () => {
    // The documented path is deleting the WhatsApp account by hand, which
    // permanently erases message history. Meta itself recommends Coexistence.
    expect(opts.fullMigration.available).toBe(false);
    expect(opts.fullMigration.reason).toMatch(/deleting the account/i);
  });

  it("states the throughput ceiling up front rather than after connecting", () => {
    expect(opts.keepUsingBusinessApp.throughputNote).toMatch(/20 messages per second/);
  });

  it("lists what will not come across, so nobody discovers it later", () => {
    const text = opts.keepUsingBusinessApp.limitations.join(" ").toLowerCase();
    expect(text).toMatch(/group chats/);
    expect(text).toMatch(/voice and video calls/);
  });
});

// ─── Customer-facing language ────────────────────────────────

describe("customer-facing copy", () => {
  const jargon = [
    "WABA",
    "phone number id",
    "business token",
    "business portfolio",
    "graph api",
    "platform_type",
    "access token",
  ];

  it("never leaks Meta vocabulary into a customer message", () => {
    // Phase 5: the customer should never need to understand any of these.
    const scenarios = [
      selectFlow({ inspection: inspection({ numbers: [], wabas: [] }) }),
      selectFlow({ inspection: inspection() }),
      selectFlow({
        inspection: inspection({ numbers: [number({ kind: "COEXISTENCE", isOnBizApp: true })] }),
      }),
      selectFlow({ inspection: inspection({ numbers: [number({ connectedToThisTenant: true })] }) }),
      selectFlow({ inspection: inspection({ missingPermissions: ["whatsapp_business_messaging"] }) }),
    ];
    for (const d of scenarios) {
      const lower = d.customerMessage.toLowerCase();
      for (const term of jargon) {
        expect(lower, `"${d.scenario}" leaked "${term}"`).not.toContain(term.toLowerCase());
      }
    }
  });

  it("keeps the em dash out of customer copy", () => {
    // Repo-wide rule: an em dash in product copy reads as AI-written.
    const messages = [
      selectFlow({ inspection: inspection() }).customerMessage,
      selectFlow({
        inspection: inspection({ numbers: [number({ kind: "COEXISTENCE", isOnBizApp: true })] }),
      }).customerMessage,
      businessAppOptions().keepUsingBusinessApp.description,
      businessAppOptions().fullMigration.reason,
    ];
    for (const m of messages) {
      expect(m).not.toMatch(/[—–]/);
    }
  });
});
