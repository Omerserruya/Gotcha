/**
 * Disconnecting one WhatsApp number must never affect another.
 *
 * This is the highest-consequence claim the multi-number architecture makes,
 * and it is not obviously true. Meta subscribes webhooks **per WABA, not per
 * number**, so the natural implementation of "disconnect" - unsubscribe our app
 * - silently silences every OTHER number the tenant has on that same account.
 *
 * That bug is invisible in any test where a tenant has one number, which is
 * exactly the shape of every test that existed before this project. So it gets
 * its own file.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── In-memory stand-ins ─────────────────────────────────────

type Row = Record<string, any>;

const state = {
  numbers: [] as Row[],
  channels: [] as Row[],
  events: [] as Row[],
  /** WABA ids our app was told to unsubscribe from. The thing under test. */
  unsubscribed: [] as string[],
  subscribed: [] as string[],
  /** Numbers deregistered at Meta. Must stay empty; see the test below. */
  deregistered: [] as string[],
};

function matches(row: Row, where: Record<string, any> = {}): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("not" in v && row[k] === (v as any).not) return false;
      if ("notIn" in v && (v as any).notIn.includes(row[k])) return false;
      if ("in" in v && !(v as any).in.includes(row[k])) return false;
      continue;
    }
    if (row[k] !== v) return false;
  }
  return true;
}

const mocks = vi.hoisted(() => {
  return {
    prismaMock: {} as any,
    clientMock: {} as any,
  };
});

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: mocks.prismaMock,
    // The token is stored encrypted per channel row. Returning a usable token
    // keeps the code path identical to production.
    decryptCredentials: () => ({ accessToken: "test-business-token" }),
    getRedis: () => ({ del: async () => 1, get: async () => null, set: async () => "OK" }),
    MetaWhatsAppClient: class {
      async unsubscribeApp(wabaId: string) {
        state.unsubscribed.push(wabaId);
        return { ok: true as const, value: { success: true } };
      }
      async subscribeApp(wabaId: string) {
        state.subscribed.push(wabaId);
        return { ok: true as const, value: { success: true } };
      }
      async deregister(phoneNumberId: string) {
        state.deregistered.push(phoneNumberId);
        return { ok: true as const, value: { success: true } };
      }
      async listSubscribedApps() {
        return { ok: true as const, value: [{ whatsapp_business_api_data: { id: "app_1" } }] };
      }
      async getPhoneNumber() {
        return { ok: true as const, value: { id: "pn", status: "CONNECTED" } };
      }
      async getHealthStatus() {
        return { ok: true as const, value: { can_send_message: "AVAILABLE" } };
      }
    },
  };
});

import { disconnectNumber } from "../services/whatsapp/health.service";
import { onboardNumber } from "../services/whatsapp/onboarding.service";

// ─── Wiring ──────────────────────────────────────────────────

beforeEach(() => {
  state.numbers = [];
  state.channels = [];
  state.events = [];
  state.unsubscribed = [];
  state.subscribed = [];
  state.deregistered = [];

  mocks.prismaMock.whatsAppNumber = {
    findFirst: async ({ where }: any) => state.numbers.find((n) => matches(n, where)) ?? null,
    findUnique: async ({ where }: any) => state.numbers.find((n) => matches(n, where)) ?? null,
    findUniqueOrThrow: async ({ where }: any) => {
      const hit = state.numbers.find((n) => matches(n, where));
      if (!hit) throw new Error("not found");
      return hit;
    },
    count: async ({ where }: any) => state.numbers.filter((n) => matches(n, where)).length,
    update: async ({ where, data }: any) => {
      const hit = state.numbers.find((n) => matches(n, where));
      if (!hit) throw new Error("update on a row that does not exist");
      Object.assign(hit, data);
      return hit;
    },
  };
  mocks.prismaMock.channelAccount = {
    findUnique: async ({ where }: any) => state.channels.find((c) => matches(c, where)) ?? null,
    update: async ({ where, data }: any) => {
      const hit = state.channels.find((c) => matches(c, where));
      if (!hit) throw new Error("update on a row that does not exist");
      Object.assign(hit, data);
      return hit;
    },
  };
  mocks.prismaMock.whatsAppNumberEvent = {
    create: async ({ data }: any) => {
      state.events.push(data);
      return data;
    },
    findFirst: async ({ where }: any) =>
      state.events.find((e) => matches(e, where)) ?? null,
  };

  // Upsert keyed by the Meta phone number id. Modelled faithfully because the
  // no-duplicates guarantee rests entirely on that key being unique.
  mocks.prismaMock.whatsAppNumber.upsert = async ({ where, create, update }: any) => {
    const existing = state.numbers.find((n) => matches(n, where));
    if (existing) {
      Object.assign(existing, update);
      return existing;
    }
    const row = { id: `num_${state.numbers.length + 1}`, ...create };
    state.numbers.push(row);
    return row;
  };
  mocks.prismaMock.channelAccount.create = async ({ data }: any) => {
    const row = { id: `ch_${state.channels.length + 1}`, ...data };
    state.channels.push(row);
    return row;
  };

  process.env.META_APP_ID = "app_1";
});

/** One connected number, plus the channel row that carries its token. */
function seedNumber(opts: { id: string; wabaId: string; tenantId?: string; state?: string }) {
  const tenantId = opts.tenantId ?? "tenant_a";
  const channelId = `ch_${opts.id}`;
  state.channels.push({ id: channelId, tenantId, credentials: "enc", connectionStatus: "CONNECTED" });
  state.numbers.push({
    id: opts.id,
    tenantId,
    channelAccountId: channelId,
    phoneNumberId: `pn_${opts.id}`,
    wabaId: opts.wabaId,
    state: opts.state ?? "CONNECTED",
    webhookSubscribed: true,
  });
}

// ─── The cases ───────────────────────────────────────────────

describe("disconnecting one number", () => {
  it("leaves the WABA subscription alone when a sibling still needs it", async () => {
    // Two numbers, ONE WhatsApp account. This is the ordinary shape for a
    // business with a sales line and a support line.
    seedNumber({ id: "sales", wabaId: "waba_1" });
    seedNumber({ id: "support", wabaId: "waba_1" });

    const result = await disconnectNumber("sales", "tenant_a");

    expect(result.succeeded).toBe(true);
    // The critical assertion: no unsubscribe call was made, because doing so
    // would stop the support number receiving messages too.
    expect(state.unsubscribed).toEqual([]);
    expect(result.webhooksPreserved).toBe(true);
  });

  it("keeps the sibling fully connected and still receiving", async () => {
    seedNumber({ id: "sales", wabaId: "waba_1" });
    seedNumber({ id: "support", wabaId: "waba_1" });

    await disconnectNumber("sales", "tenant_a");

    const support = state.numbers.find((n) => n.id === "support")!;
    expect(support.state).toBe("CONNECTED");
    expect(support.webhookSubscribed).toBe(true);

    const supportChannel = state.channels.find((c) => c.id === "ch_support")!;
    expect(supportChannel.connectionStatus).toBe("CONNECTED");
    expect(supportChannel.isActive).not.toBe(false);
  });

  it("tells the customer their other numbers are unaffected", async () => {
    // Someone who is not sure their other numbers are safe simply never
    // removes anything, so saying it is part of the behaviour.
    seedNumber({ id: "sales", wabaId: "waba_1" });
    seedNumber({ id: "support", wabaId: "waba_1" });

    const result = await disconnectNumber("sales", "tenant_a");
    expect(result.message).toMatch(/other WhatsApp numbers are unaffected/i);
  });

  it("unsubscribes only when it is the last live number on that account", async () => {
    seedNumber({ id: "only", wabaId: "waba_1" });

    await disconnectNumber("only", "tenant_a");

    expect(state.unsubscribed).toEqual(["waba_1"]);
  });

  it("counts an already-disconnected sibling as gone, not as a reason to stay", async () => {
    // A previously removed number must not pin the subscription open forever.
    seedNumber({ id: "old", wabaId: "waba_1", state: "DISCONNECTED" });
    seedNumber({ id: "current", wabaId: "waba_1" });

    await disconnectNumber("current", "tenant_a");

    expect(state.unsubscribed).toEqual(["waba_1"]);
  });

  it("ignores numbers on a different WhatsApp account when deciding", async () => {
    // A sibling on ANOTHER WABA has its own subscription and is irrelevant to
    // this one. Counting it would leave a dead subscription behind.
    seedNumber({ id: "il", wabaId: "waba_il" });
    seedNumber({ id: "uk", wabaId: "waba_uk" });

    await disconnectNumber("il", "tenant_a");

    expect(state.unsubscribed).toEqual(["waba_il"]);
  });

  it("never deregisters the number", async () => {
    // Deregistering frees the number for the WhatsApp Business app but throws
    // away its Cloud API registration, and re-registering demands the two-step
    // PIN again. That is a destructive, hard-to-reverse act and belongs to a
    // customer decision, not to clicking Remove.
    seedNumber({ id: "only", wabaId: "waba_1" });

    await disconnectNumber("only", "tenant_a");

    expect(state.deregistered).toEqual([]);
  });

  it("marks only the removed number disconnected", async () => {
    seedNumber({ id: "sales", wabaId: "waba_1" });
    seedNumber({ id: "support", wabaId: "waba_1" });

    await disconnectNumber("sales", "tenant_a");

    expect(state.numbers.find((n) => n.id === "sales")!.state).toBe("DISCONNECTED");
    expect(state.numbers.find((n) => n.id === "support")!.state).toBe("CONNECTED");
  });

  it("refuses to disconnect a number belonging to another workspace", async () => {
    // The ownership filter is in the query itself, so this is impossible
    // rather than merely guarded against.
    seedNumber({ id: "theirs", wabaId: "waba_1", tenantId: "tenant_b" });

    const result = await disconnectNumber("theirs", "tenant_a");

    expect(result.succeeded).toBe(false);
    expect(state.unsubscribed).toEqual([]);
    expect(state.numbers[0].state).toBe("CONNECTED");
  });

  it("leaves a sibling's stored credentials untouched", async () => {
    // Tokens are stored per number precisely so revoking one cannot reach
    // another's ability to send.
    seedNumber({ id: "sales", wabaId: "waba_1" });
    seedNumber({ id: "support", wabaId: "waba_1" });

    await disconnectNumber("sales", "tenant_a");

    expect(state.channels.find((c) => c.id === "ch_support")!.credentials).toBe("enc");
  });

  it("records why the subscription was left in place", async () => {
    // Someone debugging "why is this WABA still subscribed" needs the answer
    // in the audit trail, not in a code comment.
    seedNumber({ id: "sales", wabaId: "waba_1" });
    seedNumber({ id: "support", wabaId: "waba_1" });

    await disconnectNumber("sales", "tenant_a");

    const skipped = state.events.find((e) => e.step === "UNSUBSCRIBE_WEBHOOKS");
    expect(skipped?.outcome).toBe("SKIPPED");
    expect(skipped?.message).toMatch(/other connected number/i);
  });
});

// ─── Onboarding the same number twice ────────────────────────

describe("onboarding is idempotent per number", () => {
  const decision: any = {
    scenario: "EXISTING_CLOUD_API",
    phoneNumberId: "pn_new",
    wabaId: "waba_1",
    reason: "test",
    customerMessage: "test",
    // Only the steps that touch persistence; registration and health are
    // covered elsewhere and would need more of Meta stubbed.
    automatedSteps: ["SUBSCRIBE_WEBHOOKS"],
    customerAction: null,
    blockers: [],
  };

  const inspection: any = {
    numbers: [
      {
        phoneNumberId: "pn_new",
        displayPhoneNumber: "+972 50-111-1111",
        verifiedName: "Sales",
        kind: "CLOUD_API",
        isOnBizApp: false,
      },
    ],
  };

  function input() {
    return {
      tenantId: "tenant_a",
      userId: "user_1",
      accessToken: "tok",
      phoneNumberId: "pn_new",
      wabaId: "waba_1",
      decision,
      inspection,
    };
  }

  it("creates one lifecycle row no matter how many times it runs", async () => {
    // A customer who clicks Connect twice, or relaunches after a wobble, must
    // not end up with two records for one number. The unique key on
    // phone_number_id is what guarantees it; this proves the code relies on it.
    await onboardNumber(input() as any);
    await onboardNumber(input() as any);

    expect(state.numbers.filter((n) => n.phoneNumberId === "pn_new")).toHaveLength(1);
  });

  it("does not disturb a number that was already connected", async () => {
    seedNumber({ id: "existing", wabaId: "waba_9" });

    await onboardNumber(input() as any);

    const existing = state.numbers.find((n) => n.id === "existing")!;
    expect(existing.state).toBe("CONNECTED");
    expect(existing.wabaId).toBe("waba_9");
    expect(state.unsubscribed).toEqual([]);
  });
});
