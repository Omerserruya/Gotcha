/**
 * The conversation relevance classifier (2026-11-17): generic, a fast path then ONE small model call,
 * platform-paid. No tenant-specific words: the samples are invented and the business is a fixture.
 */
import { describe, it, expect, vi } from "vitest";
vi.mock("../services/ai.service", async (orig) => ({ ...(await orig<any>()), getDefaultModel: () => "test-model" }));
import { classifyConversation, fastRelevance, parseRelevance, relevancePrompt, shouldReclassify, SILENCING, teamIdentityOf, autoReply, firstMover, type RelevanceInput } from "../services/conversation-relevance.service";
import { platformPaidScope, laneFeature } from "../services/ai.service";
import { dryRunReport, parseDryArgs, type DryRow } from "../scripts/classify-dry-run";

const biz = { organizationName: "Demo Bakery", industry: "food", businessDescription: "Bakes and delivers cakes to order", whatWeSell: "cakes, pastries" };
const wa = (msgs: Array<[string, string]>, first: "INBOUND" | "OUTBOUND" = "INBOUND"): RelevanceInput => ({
  channel: "WHATSAPP", customerExternalId: "972500000000", firstDirection: first,
  messages: msgs.map(([d, b]) => ({ direction: d, body: b })),
});

describe("conversation relevance", () => {
  it("★ the fast path: a bulk list is marketing, a no-reply sender is a notice, with no model call", async () => {
    const gen = vi.fn();
    const list = await classifyConversation("t1", biz, { channel: "EMAIL", customerExternalId: "news@brand.example", firstDirection: "INBOUND", messages: [{ direction: "INBOUND", body: "Our autumn sale", metadata: { email: { bulk: "list" } } }] }, { generate: gen as any });
    expect(list).toMatchObject({ category: "marketing", source: "fast" });
    const nr = await classifyConversation("t1", biz, { channel: "EMAIL", customerExternalId: "no-reply@billing.example", firstDirection: "INBOUND", messages: [{ direction: "INBOUND", body: "Your receipt for October" }] }, { generate: gen as any });
    expect(nr).toMatchObject({ category: "notice", source: "fast" });
    expect(gen).not.toHaveBeenCalled();
    // A person's WhatsApp message never takes the fast path.
    expect(fastRelevance(wa([["INBOUND", "do you have a chocolate cake for Friday?"]]))).toBeNull();
  });

  it("★ one model call, platform-paid with the _classify suffix, JSON read back", async () => {
    let lane = "";
    const gen = vi.fn(async (p: any) => { lane = laneFeature("conversation_relevance"); expect(p.responseFormat).toEqual({ type: "json_object" }); return { content: '{"category":"personal","confidence":0.91,"reason":"a friend arranging dinner"}' } as any; });
    const r = await classifyConversation("t1", biz, wa([["INBOUND", "dinner at 8 tonight?"]]), { generate: gen as any });
    expect(gen).toHaveBeenCalledTimes(1);
    expect(lane).toBe("conversation_relevance_classify");
    expect(r).toMatchObject({ category: "personal", confidence: 0.91, source: "model" });
    // Outside the classifier, nothing is marked.
    expect(laneFeature("conversation_relevance")).toBe("conversation_relevance");
    expect(platformPaidScope.getStore()).toBeUndefined();
  });

  it("★ the prompt carries the business, who wrote first, and at most 8 messages, no more", () => {
    const msgs: Array<[string, string]> = Array.from({ length: 12 }, (_, i) => [i % 2 ? "OUTBOUND" : "INBOUND", `m${i}`]);
    const [sys, user] = relevancePrompt(biz, wa(msgs, "OUTBOUND"));
    expect(sys.content).toMatch(/reply_to_outbound/);
    expect(user.content).toMatch(/Demo Bakery/);
    expect(user.content).toMatch(/cakes, pastries/);
    expect(user.content).toMatch(/Who wrote first: the business/);
    expect(user.content).not.toMatch(/\bm3\b/);
    expect(user.content).toMatch(/\bm4\b[\s\S]*\bm11\b/);
    const mail = relevancePrompt(biz, { channel: "EMAIL", customerExternalId: "a@b.example", firstDirection: "INBOUND", subject: "Order 12", messages: [{ direction: "INBOUND", body: "hi" }] })[1].content;
    expect(mail).toMatch(/Subject: Order 12/);
  });

  it("★ the model's answer is read defensively", () => {
    expect(parseRelevance("not json")).toEqual({ category: "unclear", confidence: 0, reason: "" });
    expect(parseRelevance('{"category":"spam","confidence":0.99}').category).toBe("unclear");
    expect(parseRelevance('{"category":"spam","confidence":0.99}').confidence).toBe(0);
    expect(parseRelevance('```json\n{"category":"business","confidence":7}\n```')).toMatchObject({ category: "business", confidence: 1 });
  });

  it("★ no inbound yet: unclear, no model call", async () => {
    const gen = vi.fn();
    expect(await classifyConversation("t1", biz, wa([["OUTBOUND", "hello from the bakery"]], "OUTBOUND"), { generate: gen as any })).toMatchObject({ category: "unclear", confidence: 0 });
    expect(gen).not.toHaveBeenCalled();
  });

  it("★ reclassify only after a new inbound, when old or unsure; never over an override", () => {
    const now = new Date("2026-11-17T12:00:00Z");
    const at = "2026-11-17T11:00:00Z";
    const later = new Date("2026-11-17T11:30:00Z");
    expect(shouldReclassify(null, later, now)).toBe(true);
    expect(shouldReclassify({ classifiedAt: at, confidence: 0.95 }, later, now)).toBe(false);
    expect(shouldReclassify({ classifiedAt: at, confidence: 0.5 }, later, now)).toBe(true);
    expect(shouldReclassify({ classifiedAt: at, confidence: 0.5 }, new Date("2026-11-17T10:00:00Z"), now)).toBe(false);
    expect(shouldReclassify({ classifiedAt: "2026-11-16T00:00:00Z", confidence: 0.95 }, later, now)).toBe(true);
    expect(shouldReclassify({ classifiedAt: at, confidence: 0.1, overriddenBy: "u1" }, later, now)).toBe(false);
    // Unclear never silences: the AI answers as today.
    expect([...SILENCING].sort()).toEqual(["auto_reply", "internal", "marketing", "notice", "personal"]);
  });

  it("★ the dry-run report: counts, samples capped at 15, and the low-confidence silencing list", () => {
    const row = (i: number, category: any, confidence: number): DryRow => ({ conversationId: `c${i}`, channel: i % 2 ? "EMAIL" : "WHATSAPP", firstWriter: "contact", line: `line | ${i}`, label: { category, confidence, reason: "r", source: "model", classifiedAt: "" } });
    const rows = [...Array.from({ length: 20 }, (_, i) => row(i, "business", 0.9)), row(20, "personal", 0.6), row(21, "notice", 0.9), row(22, "marketing", 0.84)];
    const md = dryRunReport("t1", 60, rows);
    expect(md).toMatch(/\| business \| 20 \|/);
    expect((md.split("## Samples: business")[1].split("##")[0].match(/^\| c\d+/gm) ?? []).length).toBe(15);
    const review = md.split("Would silence the AI")[1];
    expect(review).toMatch(/\(2\)/);
    expect(review).toMatch(/c20/);
    expect(review).toMatch(/c22/);
    expect(review).not.toMatch(/c21/);
    expect(md).toMatch(/line \\\| 20/);
    expect(md.endsWith("\n")).toBe(true);
  });

  it("parses the dry-run arguments", () => {
    expect(parseDryArgs(["--tenant", "t1"])).toEqual({ tenant: "t1", days: 60, out: "/tmp/classify-t1.md", limit: 2000 });
    expect(parseDryArgs(["--tenant", "t1", "--days", "900", "--out", "/x.md"]).days).toBe(365);
    expect(() => parseDryArgs([])).toThrow(/usage/);
  });

  describe("dry run 2026-11-17 fixes", () => {
    const at = (s: number) => new Date(Date.UTC(2026, 10, 17, 10, 0, s));
    it("★ an auto-reply to the business's message: auto_reply, no model call", async () => {
      const gen = vi.fn();
      const c: RelevanceInput = { channel: "WHATSAPP", customerExternalId: "972500000001", firstDirection: "OUTBOUND", messages: [
        { direction: "OUTBOUND", body: "היי, רציתי להציע לכם שירות", createdAt: at(0) },
        { direction: "INBOUND", body: "תודה שפנית אלינו! שעות הפעילות שלנו א-ה 9:00-17:00", createdAt: at(4) },
      ] };
      expect(await classifyConversation("t1", biz, c, { generate: gen as any })).toMatchObject({ category: "auto_reply", source: "fast" });
      expect(gen).not.toHaveBeenCalled();
      expect(autoReply({ ...c, messages: [c.messages[0], { direction: "INBOUND", body: "הגעתם לסטודיו, כרגע אנחנו לא פנויים", createdAt: at(3) }] })).toBe(true);
      // The contact wrote first with a machine's greeting: the shape alone (dry run 2, an away message).
      expect(autoReply({ ...c, firstDirection: "INBOUND", messages: [{ direction: "INBOUND", body: "היי, הגעתם לסטודיו לעיצוב. תודה שפנית אלינו! כרגע אנחנו לא פנויים", createdAt: at(1) }] })).toBe(true);
      // A short line or a question with the shape is a customer asking.
      expect(autoReply({ ...c, firstDirection: "INBOUND", messages: [{ direction: "INBOUND", body: "מה שעות הפעילות שלכם?", createdAt: at(1) }] })).toBe(false);
      expect(autoReply({ ...c, firstDirection: "INBOUND", messages: [{ direction: "INBOUND", body: "שעות הפעילות", createdAt: at(1) }] })).toBe(false);
      // A person who wrote after the greeting is not an auto-reply.
      expect(autoReply({ ...c, messages: [...c.messages, { direction: "INBOUND", body: "אני בעלת העסק, ספר לי עוד", createdAt: at(300) }] })).toBe(false);
      // A customer's own words are not the shape.
      expect(autoReply({ ...c, messages: [c.messages[0], { direction: "INBOUND", body: "כמה עולה עוגה?", createdAt: at(4) }] })).toBe(false);
    });

    it("★ a member of the team: internal (phone, email, company domain; never a free mail domain)", () => {
      const team = teamIdentityOf([{ email: "dana@gotcha.co.il", phoneNumber: "+972-50-111-2222" }, { email: "cofounder@gmail.com", phoneNumber: null }]);
      expect(team.domains).toEqual(["gotcha.co.il"]);
      const wa = (id: string): RelevanceInput => ({ channel: "WHATSAPP", customerExternalId: id, firstDirection: "INBOUND", team, messages: [{ direction: "INBOUND", body: "hi" }] });
      expect(fastRelevance(wa("972501112222"))?.category).toBe("internal");
      expect(fastRelevance(wa("972509999999"))).toBeNull();
      const mail = (from: string): RelevanceInput => ({ channel: "GMAIL", customerExternalId: from, firstDirection: "INBOUND", team, messages: [{ direction: "INBOUND", body: "a pitch draft" }] });
      expect(fastRelevance(mail("cofounder@gmail.com"))?.category).toBe("internal");
      expect(fastRelevance(mail("someone@gotcha.co.il"))?.category).toBe("internal");
      expect(fastRelevance(mail("stranger@gmail.com"))).toBeNull();
      // The From of an inbound email counts too.
      expect(fastRelevance({ ...mail("thread@x.example"), messages: [{ direction: "INBOUND", body: "draft", metadata: { email: { from: "Dana <dana@gotcha.co.il>" } } }] })?.category).toBe("internal");
    });

    it("★ the first-mover rule: the business wrote first and the model is unsure: reply_to_outbound", async () => {
      expect(firstMover({ category: "business", confidence: 0.8, reason: "r" }, wa([["INBOUND", "x"]], "OUTBOUND")).category).toBe("reply_to_outbound");
      expect(firstMover({ category: "business", confidence: 0.95, reason: "r" }, wa([["INBOUND", "x"]], "OUTBOUND")).category).toBe("business");
      expect(firstMover({ category: "business", confidence: 0.5, reason: "r" }, wa([["INBOUND", "x"]], "INBOUND")).category).toBe("business");
      const gen = vi.fn(async () => ({ content: '{"category":"business","confidence":0.7,"reason":"store answer"}' } as any));
      const r = await classifyConversation("t1", biz, wa([["OUTBOUND", "do you sell clips?"], ["INBOUND", "אין צורך לרכוש את התופסן"]], "OUTBOUND"), { generate: gen as any });
      expect(r.category).toBe("reply_to_outbound");
      expect(relevancePrompt(biz, wa([["INBOUND", "x"]]))[0].content).toMatch(/HARD RULE: when the business wrote first/);
      // A model label under 0.6 is unclear, which never silences (dry run 2).
      const low = vi.fn(async () => ({ content: '{"category":"auto_reply","confidence":0.45,"reason":"r"}' } as any));
      expect((await classifyConversation("t1", biz, wa([["INBOUND", "[Unsupported message]"]]), { generate: low as any })).category).toBe("unclear");
      const ok6 = vi.fn(async () => ({ content: '{"category":"personal","confidence":0.6,"reason":"r"}' } as any));
      expect((await classifyConversation("t1", biz, wa([["INBOUND", "dinner tonight"]]), { generate: ok6 as any })).category).toBe("personal");
    });
  });
});
