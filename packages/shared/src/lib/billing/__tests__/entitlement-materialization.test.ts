import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Proves the bridge WRITES, not just that it is declared.
 *
 * `materializeEntitlements` projects the commercial answer into
 * `tenant_features`. Capabilities whose gate reads a legacy key
 * (`shopify_live_chat`) rather than the canonical one
 * (`commerce.shopify_live_chat`) need BOTH rows written, or a plan can grant
 * or withhold the capability and the `requireFeature` guard protecting it will
 * never see the change - it keeps answering from `FEATURE_METADATA.defaultEnabled`.
 *
 * The declaration side (no typos, no collisions, defaults agree) is checked in
 * enforcement-contract.test.ts. This file checks the row actually lands.
 */

const upserts: Array<{ feature: string; enabled: boolean }> = [];
/** Voice is gated by COLUMNS on the tenant, so its projection lands here. */
const tenantUpdates: Array<Record<string, unknown>> = [];

const resolved = {
  tenantId: "t1",
  planKey: "foundation",
  planVersion: 1,
  unsubscribed: false,
  entries: new Map<string, any>(),
};

vi.mock("../../prisma", () => ({
  prisma: {
    tenantFeature: {
      upsert: async ({ where, create }: any) => {
        upserts.push({ feature: where.tenantId_feature.feature, enabled: create.enabled });
      },
    },
    tenant: {
      update: async ({ data }: any) => {
        tenantUpdates.push(data);
      },
    },
  },
}));

vi.mock("../../permissions", () => ({ invalidatePermissionsCache: () => {} }));

vi.mock("../entitlement-resolver", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, resolveEntitlements: async () => resolved };
});

import { materializeEntitlements } from "../entitlements";
import { FEATURE_CATALOG } from "../feature-catalog";

const BRIDGED = FEATURE_CATALOG.find((f) => f.materializesTo)!;

beforeEach(() => {
  upserts.length = 0;
  tenantUpdates.length = 0;
  resolved.entries = new Map();
});

const put = (key: string, value: unknown, valueType = "BOOLEAN") =>
  resolved.entries.set(key, { key, valueType, value, source: "PLAN_DEFAULT" });

describe("materializing a bridged capability", () => {
  it("writes the canonical row AND the legacy row the gate reads", async () => {
    put(BRIDGED.key, { bool: true });
    await materializeEntitlements("t1");

    const written = upserts.map((u) => u.feature);
    expect(written).toContain(BRIDGED.key);
    expect(written, `the ${BRIDGED.materializesTo} row is what requireFeature reads`)
      .toContain(BRIDGED.materializesTo);
  });

  it("carries the SAME answer to both rows", async () => {
    // If they could disagree, the gate and the console would each be able to
    // claim a different truth about the same capability.
    put(BRIDGED.key, { bool: false });
    await materializeEntitlements("t1");

    const canonical = upserts.find((u) => u.feature === BRIDGED.key);
    const legacy = upserts.find((u) => u.feature === BRIDGED.materializesTo);
    expect(canonical?.enabled).toBe(false);
    expect(legacy?.enabled).toBe(false);
  });

  it("withholding the capability turns the legacy row OFF", async () => {
    // The reason the bridge exists. A plan that does not sell this must
    // actually close the gate, not just record a false somewhere unread.
    put(BRIDGED.key, { bool: false });
    await materializeEntitlements("t1");
    expect(upserts.find((u) => u.feature === BRIDGED.materializesTo)?.enabled).toBe(false);
  });

  it("a COMPLIANCE_DENY reaches the legacy row too", async () => {
    // The deny is applied by `entitledIn`, which materialization routes
    // through. A deny that stopped at the canonical row would leave the
    // product still serving the capability.
    resolved.entries.set(BRIDGED.key, {
      key: BRIDGED.key, valueType: "BOOLEAN", value: { bool: true }, source: "COMPLIANCE_DENY",
    });
    await materializeEntitlements("t1");
    expect(upserts.find((u) => u.feature === BRIDGED.materializesTo)?.enabled).toBe(false);
    expect(upserts.find((u) => u.feature === BRIDGED.key)?.enabled).toBe(false);
  });
});

describe("materializing an unbridged capability", () => {
  it("writes only its own row", async () => {
    const plain = FEATURE_CATALOG.find(
      (f) => !f.materializesTo && f.entitlementType === "BOOLEAN",
    )!;
    put(plain.key, { bool: true });
    await materializeEntitlements("t1");
    expect(upserts.map((u) => u.feature)).toEqual([plain.key]);
  });

  it("skips non-BOOLEAN entitlements entirely", async () => {
    // Limits are read by `resolveLimit`, not by the feature gate. Writing a
    // count into a boolean row would read as "enabled" for any limit above 0
    // - and, worse, as enabled for a limit of 0.
    put("limit:users", { count: 0 }, "COUNTER");
    await materializeEntitlements("t1");
    expect(upserts).toEqual([]);
  });
});

/**
 * Voice is the case where the gate is not a TenantFeature row at all: it is
 * three booleans on the tenant that predate entitlements, and that only a
 * SYSTEM_ADMIN could set. Selling voice therefore took two unrelated acts -
 * grant the feature area, then remember to flip the flags - and a POC with
 * voice selected showed a Voice option that refused to open. The license is now
 * canonical; these pin that it actually reaches the columns.
 */
describe("materializing the voice license", () => {
  it("switches the tenant's voice columns on when the license is granted", async () => {
    put("voice", { bool: true });
    await materializeEntitlements("t1");
    expect(tenantUpdates).toEqual([
      { voiceCopilotEnabled: true, voiceInboxUiEnabled: true, voiceIncomingEnabled: true },
    ]);
  });

  it("switches them off when the license is withheld", async () => {
    put("voice", { bool: false });
    await materializeEntitlements("t1");
    expect(tenantUpdates).toEqual([
      { voiceCopilotEnabled: false, voiceInboxUiEnabled: false, voiceIncomingEnabled: false },
    ]);
  });

  it("leaves the columns alone when no voice decision has been recorded", async () => {
    // License semantics are default-ALLOW, and voice costs real telephony
    // money: "nobody has decided" must never read as "yes".
    put("communication.omnichannel", { bool: true });
    await materializeEntitlements("t1");
    expect(tenantUpdates).toEqual([]);
  });

  it("entitles the VOICE plan features, which is the gate that returned 402", async () => {
    // POST /voice-channels mounts requireEntitlement("voice.call_pilot"), and
    // that key defaults to FALSE - so a customer sold a voice POC met a 402 the
    // moment they submitted their Twilio credentials.
    put("voice", { bool: true });
    await materializeEntitlements("t1");
    const voiceRows = upserts.filter((u) => u.feature.startsWith("voice."));
    expect(voiceRows.length).toBeGreaterThan(0);
    expect(voiceRows.map((u) => u.feature)).toContain("voice.call_pilot");
    expect(voiceRows.every((u) => u.enabled)).toBe(true);
  });

  it("does not overrule an explicit decision about one voice capability", async () => {
    put("voice", { bool: true });
    put("voice.inbound", { bool: false });
    await materializeEntitlements("t1");
    const inbound = upserts.filter((u) => u.feature === "voice.inbound");
    // Written once, by the entry's own branch, with the explicit answer.
    expect(inbound).toEqual([{ feature: "voice.inbound", enabled: false }]);
  });

  it("is a grantable license key, not an unsellable unknown", async () => {
    const { ALL_LICENSE_KEYS } = await import("../../permission-catalog");
    const { isUnsellable } = await import("../feature-catalog");
    expect(ALL_LICENSE_KEYS).toContain("voice");
    expect(isUnsellable("voice")).toBe(false);
  });
});
