/**
 * ★ What a hand mark did to its sender (2026-11-22): `senderRule` in the answer of
 * PUT /api/conversations/:id/relevance. The inbox draws a line under the mark only when the answer says
 * "applied" or "lifted", and the line promises something about the person's later conversations, so the field
 * is present only where the ai's sender rule really reads the mark:
 *   - "applied": a personal mark on a relevance channel that is not email
 *   - "lifted": a business mark while the sender's newest hand mark was personal
 *   - absent: email, a channel with no relevance filter, a channel account whose filter is off, a sender with no
 *     id, a first business mark, a failed read
 * Through the real router: the body is what the inbox reads, with the field beside `data`, never inside it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { readFileSync } from "fs";
import { join } from "path";

const H = vi.hoisted(() => ({
  viewer: { userId: "u9", role: "ADMIN", departmentId: undefined as string | undefined },
  rows: [] as any[],
  events: [] as any[],
  /** The reads of the sender's newest hand mark, as the service asked for them. */
  markReads: [] as any[],
  failMarkRead: false,
}));

function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (k === "OR") return (v as any[]).some((w) => matches(row, w));
    if (k === "AND") return (v as any[]).every((w) => matches(row, w));
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(row[k]);
      if ("not" in v) return v.not === null ? row[k] != null : row[k] !== v.not;
      return true;
    }
    return (row[k] ?? null) === v;
  });
}

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { ...H.viewer }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requireRole: () => (_q: any, _s: any, n: any) => n(),
    publishEvent: async (e: any) => { H.events.push(e); },
    prisma: {
      conversation: {
        // The shared client reads live conversations only, unless the caller names an origin.
        findFirst: async (a: any) => {
          const byMark = a.where?.relevanceSource === "override";
          if (byMark) {
            H.markReads.push(a);
            if (H.failMarkRead) throw new Error("connection lost");
          }
          const live = (r: any) => "origin" in (a.where ?? {}) || (r.origin ?? "LIVE") === "LIVE";
          const found = H.rows.filter((r) => live(r) && matches(r, a.where));
          if (a.orderBy?.relevanceOverriddenAt === "desc") found.sort((x, y) => +y.relevanceOverriddenAt - +x.relevanceOverriddenAt);
          if (!found[0]) return null;
          // Like the real client: only the columns the caller selected come back.
          return a.select ? Object.fromEntries(Object.keys(a.select).filter((k) => a.select[k]).map((k) => [k, found[0][k]])) : { ...found[0] };
        },
        update: async (a: any) => { const r = H.rows.find((x) => x.id === a.where.id); Object.assign(r, a.data); return { ...r }; },
      },
    },
  };
});
// socket.io is not installed in every checkout; nothing here emits.
vi.mock("../lib/socket", () => ({ getIO: () => null }));
vi.mock("../services/message.service", () => ({ create: vi.fn() }));

import router from "../routes/conversations";
import { senderIds, senderRuleReads, senderRuleEffect } from "../lib/relevance-sender-rule";

const app = express();
app.use(express.json());
app.use("/api/conversations", router);

const PHONE = "972501234567";
const conv = (id: string, o: any = {}) => ({
  id, tenantId: "T", status: "OPEN", channel: "WHATSAPP", customerExternalId: PHONE, assignedAgentId: null, departmentId: null,
  channelAccountId: "acc1", channelAccount: { relevanceFilterEnabled: true }, origin: "LIVE",
  relevanceCategory: null, relevanceSource: null, relevanceOverriddenBy: null, relevanceOverriddenAt: null, ...o,
});
/** A mark a person made earlier, `minutesAgo` before now. */
const marked = (category: "personal" | "business", minutesAgo: number) => ({
  relevanceCategory: category, relevanceSource: "override", relevanceOverriddenBy: "u1", relevanceOverriddenAt: new Date(Date.now() - minutesAgo * 60_000),
});
/** A conversation the ai's sender rule labelled personal when it came in. */
const byRule = { relevanceCategory: "personal", relevanceSource: "sender", relevanceConfidence: 1 };
const mark = (id: string, category: string) => request(app).put(`/api/conversations/${id}/relevance`).send({ category });

beforeEach(() => { H.rows = []; H.events = []; H.markReads = []; H.failMarkRead = false; });

describe("★ senderRule: what a hand mark did to its sender", () => {
  it("★ applied: a personal mark on WhatsApp, Instagram and Messenger", async () => {
    H.rows = [conv("wa"), conv("ig", { channel: "INSTAGRAM", customerExternalId: "17841400000000000" }), conv("fb", { channel: "MESSENGER", customerExternalId: "psid-ab12" })];
    for (const id of ["wa", "ig", "fb"]) {
      const res = await mark(id, "personal");
      expect(res.status).toBe(200);
      // Beside `data`, where the inbox reads it; the relevance object itself is as it was.
      expect(res.body).toEqual({ data: expect.objectContaining({ category: "personal", source: "override", overriddenBy: "u9" }), senderRule: "applied" });
      expect(res.body.data).not.toHaveProperty("senderRule");
    }
    // A personal mark asks nothing about earlier marks.
    expect(H.markReads).toHaveLength(0);
    // A conversation with no channel account counts as filter on, as it does for the classifier.
    H.rows = [conv("no-account", { channelAccountId: null, channelAccount: null })];
    expect((await mark("no-account", "personal")).body.senderRule).toBe("applied");
  });

  it("★ lifted: 'this is business' on a conversation the rule labelled, after a hand-marked personal one", async () => {
    H.rows = [conv("first", marked("personal", 60)), conv("second", byRule)];
    const res = await mark("second", "business");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: expect.objectContaining({ category: "business", source: "override", overriddenBy: "u9" }), senderRule: "lifted" });
    // One read, of this sender on this channel in this tenant, newest hand mark first.
    expect(H.markReads).toHaveLength(1);
    expect(H.markReads[0].where).toMatchObject({ tenantId: "T", channel: "WHATSAPP", customerExternalId: { in: [PHONE, `+${PHONE}`] }, relevanceSource: "override", relevanceOverriddenAt: { not: null } });
    expect(H.markReads[0].orderBy).toEqual({ relevanceOverriddenAt: "desc" });
    // The mark just made is now the sender's newest: a second "business" lifts nothing.
    expect((await mark("first", "business")).body).not.toHaveProperty("senderRule");
  });

  it("★ lifted: the same number stored with and without '+', and taking back the personal mark itself", async () => {
    H.rows = [conv("plus", { customerExternalId: `+${PHONE}`, ...marked("personal", 30) }), conv("bare", byRule)];
    expect((await mark("bare", "business")).body.senderRule).toBe("lifted");
    // One conversation, marked personal and then business by the person: the sender is no longer excluded.
    H.rows = [conv("only", marked("personal", 5))];
    expect((await mark("only", "business")).body.senderRule).toBe("lifted");
  });

  it("★ absent on email: the rule stays out of it, for a personal mark and for a business one", async () => {
    for (const channel of ["GMAIL", "OUTLOOK", "EMAIL"]) {
      H.rows = [conv("m1", { channel, customerExternalId: "forms@shop.example" }), conv("m2", { channel, customerExternalId: "forms@shop.example", ...marked("personal", 10) })];
      const personal = await mark("m1", "personal");
      expect(personal.status).toBe(200);
      expect(personal.body).toEqual({ data: expect.objectContaining({ category: "personal" }) });
      expect(Object.keys(personal.body)).toEqual(["data"]);
      // A personal mark on the same address exists, and a business mark still says nothing.
      expect(Object.keys((await mark("m1", "business")).body)).toEqual(["data"]);
    }
    expect(H.markReads).toHaveLength(0);
  });

  it("★ absent on a first business mark, and on a business mark that ends nothing", async () => {
    // No mark on this sender before.
    H.rows = [conv("fresh", { relevanceCategory: "unclear", relevanceSource: "model" })];
    const res = await mark("fresh", "business");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["data"]);
    expect(res.body.data).toMatchObject({ category: "business", source: "override" });
    expect(H.markReads).toHaveLength(1);
    // The sender's newest mark is already "business" (an older personal one was taken back before).
    H.rows = [conv("old", marked("personal", 120)), conv("newer", marked("business", 60)), conv("now", byRule)];
    expect(Object.keys((await mark("now", "business")).body)).toEqual(["data"]);
    // "Personal" by the classifier is not a person's mark.
    H.rows = [conv("model", { relevanceCategory: "personal", relevanceSource: "model", relevanceConfidence: 0.9, relevanceOverriddenAt: null }), conv("b")];
    expect(Object.keys((await mark("b", "business")).body)).toEqual(["data"]);
    // A personal mark on another sender, on another channel, in another tenant, or on imported history.
    H.rows = [
      conv("other-sender", { customerExternalId: "972509999999", ...marked("personal", 10) }),
      conv("other-channel", { channel: "INSTAGRAM", ...marked("personal", 10) }),
      conv("other-tenant", { tenantId: "OTHER", ...marked("personal", 10) }),
      conv("imported", { origin: "HISTORICAL", ...marked("personal", 10) }),
      conv("mine"),
    ];
    expect(Object.keys((await mark("mine", "business")).body)).toEqual(["data"]);
  });

  it("★ absent on another channel: a site chat, a store chat, voice and Slack are never filtered", async () => {
    for (const channel of ["WEBCHAT", "SHOPIFY_CHAT", "VOICE", "SLACK"]) {
      H.rows = [conv("c1", { channel }), conv("c2", { channel, ...marked("personal", 10) })];
      expect(Object.keys((await mark("c1", "personal")).body)).toEqual(["data"]);
      expect(Object.keys((await mark("c1", "business")).body)).toEqual(["data"]);
    }
    expect(H.markReads).toHaveLength(0);
  });

  it("absent when the channel account's filter is off, and when the conversation has no sender id", async () => {
    const off = { channelAccount: { relevanceFilterEnabled: false } };
    H.rows = [conv("off1", off), conv("off2", { ...off, ...marked("personal", 10) })];
    expect(Object.keys((await mark("off1", "personal")).body)).toEqual(["data"]);
    expect(Object.keys((await mark("off1", "business")).body)).toEqual(["data"]);
    H.rows = [conv("no-id", { customerExternalId: "" })];
    expect(Object.keys((await mark("no-id", "personal")).body)).toEqual(["data"]);
    expect(H.markReads).toHaveLength(0);
  });

  it("a failed read of the earlier marks is no claim: the mark is saved and the field is absent", async () => {
    H.rows = [conv("first", marked("personal", 60)), conv("second", byRule)];
    H.failMarkRead = true;
    const res = await mark("second", "business");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: expect.objectContaining({ category: "business", source: "override" }) });
    expect(H.rows.find((r) => r.id === "second")).toMatchObject({ relevanceCategory: "business", relevanceSource: "override", relevanceOverriddenBy: "u9" });
  });

  it("the answers that are not a mark carry no field, and the live event is the relevance object alone", async () => {
    H.rows = [conv("wa")];
    const missing = await mark("nope", "personal");
    expect(missing.status).toBe(404);
    expect(missing.body).not.toHaveProperty("senderRule");
    const bad = await mark("wa", "notice");
    expect(bad.status).toBe(400);
    expect(bad.body).not.toHaveProperty("senderRule");
    expect(H.events).toHaveLength(0);
    await mark("wa", "personal");
    expect(H.events).toHaveLength(1);
    expect(H.events[0]).toMatchObject({ event: "conversation:updated", tenantId: "T" });
    expect(Object.keys(H.events[0].data).sort()).toEqual(["id", "relevance"]);
  });
});

describe("the decision, piece by piece", () => {
  it("senderIds: a number with and without '+', any other id as it is, nothing for an empty one", () => {
    expect(senderIds("972501234567")).toEqual(["972501234567", "+972501234567"]);
    expect(senderIds("+972501234567")).toEqual(["972501234567", "+972501234567"]);
    expect(senderIds(" psid-ab12 ")).toEqual(["psid-ab12"]);
    expect(senderIds("")).toEqual([]);
    expect(senderIds(null)).toEqual([]);
    expect(senderIds("+")).toEqual([]);
  });

  it("senderRuleReads and senderRuleEffect", () => {
    const wa = { channel: "WHATSAPP", customerExternalId: "9725" };
    expect(senderRuleReads(wa)).toBe(true);
    expect(senderRuleReads({ ...wa, channel: "whatsapp" })).toBe(true);
    expect(senderRuleReads({ ...wa, channelAccount: null })).toBe(true);
    expect(senderRuleReads({ ...wa, channelAccount: { relevanceFilterEnabled: false } })).toBe(false);
    expect(senderRuleReads({ ...wa, channel: "gmail" })).toBe(false);
    expect(senderRuleReads({ ...wa, channel: "WEBCHAT" })).toBe(false);
    expect(senderRuleReads({ ...wa, customerExternalId: " " })).toBe(false);
    expect(senderRuleEffect("personal", true, null)).toBe("applied");
    expect(senderRuleEffect("personal", true, "personal")).toBe("applied");
    expect(senderRuleEffect("business", true, "personal")).toBe("lifted");
    expect(senderRuleEffect("business", true, "business")).toBeUndefined();
    expect(senderRuleEffect("business", true, null)).toBeUndefined();
    expect(senderRuleEffect("personal", false, null)).toBeUndefined();
    expect(senderRuleEffect("business", false, "personal")).toBeUndefined();
  });

  it("the rule this mirrors is still the ai's rule: same email channels, same read, same decision", () => {
    const ai = readFileSync(join(__dirname, "../../../ai/src/services/conversation-relevance.service.ts"), "utf8");
    const here = readFileSync(join(__dirname, "../lib/relevance-sender-rule.ts"), "utf8");
    const email = "const EMAIL_CHANNEL = /^(?:EMAIL|GMAIL|OUTLOOK)$/i;";
    expect(ai).toContain(email);
    expect(here).toContain(email);
    // The sender's ids: the same three lines in both.
    const idLines = ['const bare = raw.replace(/^\\+/, "");', "if (!bare) return [];", "return /^\\d+$/.test(bare) ? [bare, `+${bare}`] : [raw];"];
    for (const line of idLines) { expect(ai).toContain(line); expect(here).toContain(line); }
    // The read: hand marks only, the newest decides, and only "personal" arms the rule.
    expect(ai).toContain('relevanceSource: "override", relevanceOverriddenAt: { not: null }');
    expect(ai).toContain('orderBy: { relevanceOverriddenAt: "desc" }');
    // A person's newest mark decides both ways (the import's personal mark counts only when no person
    // ever marked the sender, 2026-11-22: it never lifts or applies anything a person decided).
    expect(ai).toContain('if (newest) return newest.relevanceCategory === "personal";');
    expect(ai).toContain("EMAIL_CHANNEL.test(c.channel)) return false;");
  });
});
