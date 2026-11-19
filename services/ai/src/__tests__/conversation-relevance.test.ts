/**
 * The conversation relevance classifier (2026-11-17): generic, a fast path then ONE small model call,
 * platform-paid. No tenant-specific words: the samples are invented and the business is a fixture.
 */
import { describe, it, expect, vi } from "vitest";
vi.mock("../services/ai.service", async (orig) => ({ ...(await orig<any>()), getDefaultModel: () => "test-model" }));
// The sender rule's one read, answered from S.rows by the conditions the service wrote (never a database).
const S = vi.hoisted(() => ({ rows: [] as any[], reads: [] as any[] }));
vi.mock("@chatcenter/shared", async (orig) => ({
  ...(await orig<any>()),
  prisma: {
    conversation: {
      findFirst: async (a: any) => {
        S.reads.push(a);
        const w = a.where;
        const hit = S.rows.filter((r) => r.tenantId === w.tenantId && r.channel === w.channel && w.customerExternalId.in.includes(r.customerExternalId) && r.relevanceSource === w.relevanceSource && r.relevanceOverriddenAt != null && r.id !== w.id?.not);
        hit.sort((x, y) => (a.orderBy.relevanceOverriddenAt === "desc" ? -1 : 1) * (x.relevanceOverriddenAt.getTime() - y.relevanceOverriddenAt.getTime()));
        return hit[0] ? { relevanceCategory: hit[0].relevanceCategory } : null;
      },
    },
  },
}));
import { classifyConversation, fastRelevance, parseRelevance, relevancePrompt, shouldReclassify, SILENCING, teamIdentityOf, autoReply, firstMover, couldBeCustomer, bracketOnly, personalBound, senderIds, senderMarkedPersonal, type RelevanceInput } from "../services/conversation-relevance.service";
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
    expect(parseDryArgs(["--tenant", "t1"])).toEqual({ tenant: "t1", days: 60, out: "/tmp/classify-t1.md", limit: 2000, write: false });
    expect(parseDryArgs(["--tenant", "t1", "--write"]).write).toBe(true);
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
      // 0.6 itself holds for every label but personal, which needs 0.75 (2026-11-19: a customer hidden as personal is the expensive error).
      const ok6 = vi.fn(async () => ({ content: '{"category":"auto_reply","confidence":0.6,"reason":"r"}' } as any));
      expect((await classifyConversation("t1", biz, wa([["INBOUND", "I am out of the office until Sunday"]]), { generate: ok6 as any })).category).toBe("auto_reply");
      const p6 = vi.fn(async () => ({ content: '{"category":"personal","confidence":0.6,"reason":"r"}' } as any));
      expect((await classifyConversation("t1", biz, wa([["INBOUND", "dinner tonight"]]), { generate: p6 as any })).category).toBe("unclear");
      const p75 = vi.fn(async () => ({ content: '{"category":"personal","confidence":0.75,"reason":"r"}' } as any));
      expect((await classifyConversation("t1", biz, wa([["INBOUND", "dinner tonight"]]), { generate: p75 as any })).category).toBe("personal");
    });
  });
});

describe("casual chat is personal; a customer opener never is (Omer 2026-11-19)", () => {
  const profile = { organizationName: "Acme AI", industry: "SaaS / Conversational AI / Customer Communication", businessDescription: "A platform for WhatsApp and website chat bots, an AI agent that answers customers and books meetings.", whatWeSell: "subscriptions to the AI chat platform" };
  const conv = (body: string) => ({ channel: "WHATSAPP", firstDirection: "INBOUND" as const, customerExternalId: "972500000001", messages: [{ direction: "INBOUND", body, createdAt: new Date() }] });
  const as = (category: string, confidence: number) => async () => ({ content: JSON.stringify({ category, confidence, reason: "casual chat about a car" }) } as any);
  it("★ the two prod phrases stay personal when the model says so with confidence", async () => {
    const { classifyConversation } = await import("../services/conversation-relevance.service");
    for (const m of ["איזה חזק אפשר לשפר את הרכב", "טובה מגניב ה GTA vi"]) {
      const r = await classifyConversation("t1", profile, conv(m), { generate: as("personal", 0.85) });
      expect(r.category, m).toBe("personal");
    }
  });
  it("★ eight short customer openers are never personal, whatever the model says", async () => {
    const { classifyConversation } = await import("../services/conversation-relevance.service");
    for (const m of ["היי", "שלום!", "אפשר שאלה?", "יש לכם בוט לוואטסאפ?", "כמה עולה המנוי?", "אני רוצה להזמין דמו", "hi", "do you have a free trial?", "מה המחיר?"]) {
      const r = await classifyConversation("t1", profile, conv(m), { generate: as("personal", 0.9) });
      expect(r.category, m).toBe("unclear");
    }
  });
  it("★ every message of the sender counts: an ask earlier in the chat keeps it out of personal; a greeting before a casual chat does not", async () => {
    const { classifyConversation, couldBeCustomer } = await import("../services/conversation-relevance.service");
    const many = (...bodies: string[]) => ({ channel: "WHATSAPP", firstDirection: "INBOUND" as const, customerExternalId: "972500000001", messages: bodies.map((body) => ({ direction: "INBOUND", body, createdAt: new Date() })) });
    expect((await classifyConversation("t1", profile, many("כמה עולה המנוי?", "תודה אחי, נדבר"), { generate: as("personal", 0.9) })).category).toBe("unclear");
    expect((await classifyConversation("t1", profile, many("ראיתי את המחירון באתר", "סבבה"), { generate: as("personal", 0.9) })).category).toBe("unclear");
    expect((await classifyConversation("t1", profile, many("היי", "טובה מגניב ה GTA vi"), { generate: as("personal", 0.85) })).category).toBe("personal");
    expect((await classifyConversation("t1", profile, many("היי", "שלום"), { generate: as("personal", 0.85) })).category).toBe("unclear");
    // The joined prefix: המחיר, והמחיר, למשלוח, שהזמנתי; never a longer word that only contains one (מחירת is no word of ours).
    for (const m of ["מה המחיר?", "והמחיר?", "מתי זה יוצא למשלוח", "מה שהזמנתי לא הגיע", "בתמיכה אמרו לי"]) expect(couldBeCustomer(m), m).toBe(true);
    for (const m of ["איזה חזק אפשר לשפר את הרכב", "טובה מגניב ה GTA vi", "ראית את המשחק אתמול?", "נפגשים בשמונה אצל דני"]) expect(couldBeCustomer(m), m).toBe(false);
  });
  it("★ personal under 0.75 is unclear; the rubric says what personal is", async () => {
    const { classifyConversation, relevancePrompt, MIN_PERSONAL_CONFIDENCE } = await import("../services/conversation-relevance.service");
    expect(MIN_PERSONAL_CONFIDENCE).toBe(0.75);
    expect((await classifyConversation("t1", profile, conv("טובה מגניב ה GTA vi"), { generate: as("personal", 0.7) })).category).toBe("unclear");
    expect(relevancePrompt(profile, conv("x") as any)[0].content).toMatch(/casual chat about something that has nothing to do with what this business does/);
    expect(relevancePrompt(profile, conv("x") as any)[0].content).toMatch(/A short opener that could be a customer \(a greeting, "can I ask", "do you have", a product, price or order word\) is never personal: business or unclear/);
    expect(relevancePrompt(profile, conv("x") as any)[0].content).toMatch(/Name that subject in the reason/);
  });
});

describe("relevance exclusions (2026-11-19): no profile words, no placeholders, the sender rule", () => {
  // A profile full of everyday words: none of them makes a chat a customer's.
  const profile = { organizationName: "Acme Chat", industry: "messaging", businessDescription: "Message and call customers on WhatsApp chat at any time", whatWeSell: "chat subscriptions" };
  const many = (...bodies: string[]) => ({ channel: "WHATSAPP", firstDirection: "INBOUND" as const, customerExternalId: "972500000009", messages: bodies.map((body) => ({ direction: "INBOUND", body, createdAt: new Date() })) });
  const as = (category: string, confidence: number) => vi.fn(async () => ({ content: JSON.stringify({ category, confidence, reason: "a chat between friends" }) } as any));

  it("★ a word of the business's profile no longer binds; an ask and a bare greeting still do", async () => {
    S.rows = [];
    for (const m of ["saw your message on whatsapp, call me when you have time", "acme chat was fun last night", "chatbot", "שלחתי לך הודעה בצ'אט, תתקשר כשיש זמן"]) {
      expect(couldBeCustomer(m), m).toBe(false);
      expect((await classifyConversation("t1", profile, many(m), { generate: as("personal", 0.9) })).category, m).toBe("personal");
    }
    // The ask pattern binds in both modes, anywhere in the sender's messages.
    for (const m of ["how much does the plan cost?", "can i ask something", "יש לכם מקום מחר?"]) {
      expect(couldBeCustomer(m), m).toBe(true);
      expect(couldBeCustomer(m, true), m).toBe(true);
      expect((await classifyConversation("t1", profile, many(m, "great game last night"), { generate: as("personal", 0.9) })).category, m).toBe("unclear");
    }
    // A bare greeting binds only when it is not strongOnly: alone it could be a customer, before a casual chat it is not.
    expect(couldBeCustomer("hi")).toBe(true);
    expect(couldBeCustomer("hi", true)).toBe(false);
    expect((await classifyConversation("t1", profile, many("hi"), { generate: as("personal", 0.9) })).category).toBe("unclear");
    expect((await classifyConversation("t1", profile, many("hi", "great game last night"), { generate: as("personal", 0.9) })).category).toBe("personal");
  });

  it("★ a bracketed placeholder is not the sender's text: it never binds and never counts as an inbound message", async () => {
    S.rows = [];
    for (const m of ["[edit message]", "[image]", "[sticker]", "[deleted]", "  [order update]  ", "[תמונה]", "[]"]) {
      expect(bracketOnly(m), m).toBe(true);
      expect(couldBeCustomer(m), m).toBe(false);
      expect(couldBeCustomer(m, true), m).toBe(false);
    }
    // Words around a bracket, or two tokens, are a written message.
    for (const m of ["[image] how much is it?", "see [image]", "[image] [sticker]", "", "image"]) expect(bracketOnly(m), m).toBe(false);
    expect(couldBeCustomer("[image] how much is it? what is the price")).toBe(true);
    // A word inside a placeholder is no ask: the casual chat stays personal.
    expect((await classifyConversation("t1", profile, many("[order update]", "[sticker]", "great game last night"), { generate: as("personal", 0.9) })).category).toBe("personal");
    // The placeholder does not count: greetings are all the sender wrote, so it could be a customer.
    expect((await classifyConversation("t1", profile, many("hi", "[image]"), { generate: as("personal", 0.9) })).category).toBe("unclear");
    // Nor does an empty body or a system line (the file's realMessages), whatever the system line says.
    const sys = (body: string) => ({ direction: "INBOUND", body, messageType: "system" });
    expect(personalBound({ category: "personal", confidence: 0.9, reason: "r" }, { ...many(), messages: [...many("hi", "").messages, sys("missed voice call")] }).category).toBe("unclear");
    expect(personalBound({ category: "personal", confidence: 0.9, reason: "r" }, { ...many(), messages: [...many("great game last night").messages, sys("the price changed")] }).category).toBe("personal");
  });

  describe("the sender rule", () => {
    const day = (d: number) => new Date(Date.UTC(2026, 10, d, 9, 0, 0));
    const mark = (o: any = {}) => ({ id: "c0", tenantId: "t1", channel: "WHATSAPP", customerExternalId: "972500000009", relevanceCategory: "personal", relevanceSource: "override", relevanceOverriddenBy: "u1", relevanceOverriddenAt: day(10), ...o });
    const conv = (o: any = {}) => ({ ...many("how much does the plan cost?"), conversationId: "c9", ...o });
    const now = new Date("2026-11-19T12:00:00Z");

    it("★ the newest hand mark of the sender is personal: personal, confidence 1, source sender, no model call", async () => {
      S.rows = [mark({ id: "c1", relevanceCategory: "business", relevanceOverriddenAt: day(5) }), mark({ id: "c2", relevanceOverriddenAt: day(12) })];
      S.reads = [];
      const gen = as("business", 0.95);
      const r = await classifyConversation("t1", profile, conv(), { generate: gen, now: () => now });
      expect(r).toEqual({ category: "personal", confidence: 1, reason: "this sender was marked personal by hand", source: "sender", classifiedAt: now.toISOString() });
      expect(gen).not.toHaveBeenCalled();
      // One bounded read: the tenant first, the channel, the sender, hand marks only, newest first, never itself.
      expect(S.reads).toHaveLength(1);
      expect(Object.keys(S.reads[0].where)[0]).toBe("tenantId");
      expect(S.reads[0]).toMatchObject({ where: { tenantId: "t1", channel: "WHATSAPP", relevanceSource: "override", id: { not: "c9" } }, orderBy: { relevanceOverriddenAt: "desc" }, select: { relevanceCategory: true } });
      // Before the fast path too: a person's mark is over every rule.
      const mail = { channel: "EMAIL", customerExternalId: "news@brand.example", firstDirection: "INBOUND" as const, messages: [{ direction: "INBOUND", body: "Our autumn sale", metadata: { email: { bulk: "list" } } }] };
      S.rows = [mark({ channel: "EMAIL", customerExternalId: "news@brand.example" })];
      expect(await classifyConversation("t1", profile, mail, { generate: gen })).toMatchObject({ category: "personal", source: "sender" });
      expect(gen).not.toHaveBeenCalled();
    });

    it("★ the newest mark is business, after an older personal one: the rule does nothing", async () => {
      S.rows = [mark({ id: "c1", relevanceOverriddenAt: day(5) }), mark({ id: "c2", relevanceCategory: "business", relevanceOverriddenAt: day(12) })];
      const gen = as("business", 0.95);
      expect(await classifyConversation("t1", profile, conv(), { generate: gen })).toMatchObject({ category: "business", confidence: 0.95, source: "model" });
      expect(gen).toHaveBeenCalledTimes(1);
    });

    it("★ no sender id: no read, nothing changes", async () => {
      S.rows = [mark({ customerExternalId: "" }), mark({ id: "c3", customerExternalId: "+" })];
      S.reads = [];
      for (const id of [null, undefined, "", "   ", "+"]) {
        const gen = as("business", 0.95);
        expect((await classifyConversation("t1", profile, conv({ customerExternalId: id }), { generate: gen })).source, String(id)).toBe("model");
        expect(gen).toHaveBeenCalledTimes(1);
      }
      expect(S.reads).toHaveLength(0);
    });

    it("★ a number matches with and without the leading plus; an email only as written", async () => {
      expect(senderIds("972500000009")).toEqual(["972500000009", "+972500000009"]);
      expect(senderIds(" +972500000009 ")).toEqual(["972500000009", "+972500000009"]);
      expect(senderIds("dana@friends.example")).toEqual(["dana@friends.example"]);
      const gen = as("business", 0.95);
      S.rows = [mark({ customerExternalId: "+972500000009" })];
      expect((await classifyConversation("t1", profile, conv({ customerExternalId: "972500000009" }), { generate: gen })).source).toBe("sender");
      S.rows = [mark({ customerExternalId: "972500000009" })];
      expect((await classifyConversation("t1", profile, conv({ customerExternalId: "+972500000009" }), { generate: gen })).source).toBe("sender");
      expect(gen).not.toHaveBeenCalled();
    });

    it("★ only a hand mark of the same tenant, channel and sender on ANOTHER conversation; a marked conversation is never relabelled", async () => {
      const others = [mark({ tenantId: "t2" }), mark({ channel: "INSTAGRAM" }), mark({ customerExternalId: "972500000008" }), mark({ relevanceSource: "model", relevanceOverriddenBy: null, relevanceOverriddenAt: null }), mark({ id: "c9" })];
      for (const row of others) {
        S.rows = [row];
        expect((await classifyConversation("t1", profile, conv(), { generate: as("business", 0.95) })).source, JSON.stringify(row)).toBe("model");
      }
      // The conversation carries a person's own mark: the rule does not even read.
      S.rows = [mark()];
      S.reads = [];
      expect(await senderMarkedPersonal("t1", conv({ overriddenBy: "u2" }))).toBe(false);
      expect(S.reads).toHaveLength(0);
      expect(await senderMarkedPersonal("t1", conv())).toBe(true);
    });

    it("★ a failed read is no mark: the classifier goes on as before", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const gen = as("business", 0.95);
      const r = await classifyConversation("t1", profile, conv(), { generate: gen, db: { conversation: { findFirst: async () => { throw new Error("down"); } } } });
      expect(r).toMatchObject({ category: "business", source: "model" });
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it("★ the dry-run report counts the sender rule's labels in their own column", () => {
      const md = dryRunReport("t1", 60, [{ conversationId: "c1", channel: "WHATSAPP", firstWriter: "contact", line: "x", label: { category: "personal", confidence: 1, reason: "this sender was marked personal by hand", source: "sender", classifiedAt: "" } }]);
      expect(md).toMatch(/\| category \| count \| fast path \| model \| sender rule \|/);
      expect(md).toMatch(/\| personal \| 1 \| 0 \| 0 \| 1 \|/);
    });
  });
});
