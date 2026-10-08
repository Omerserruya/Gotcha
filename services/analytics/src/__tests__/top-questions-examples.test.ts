/**
 * "What people asked": a group whose intent is "unknown" or "general" carries
 * what the customers actually wrote.
 *
 * On dev every analysed conversation is "unknown", so the screen got
 * {question:"unknown", count:N} and had nothing to show. Each vague group now
 * also carries examples: [{question, count}] - the most common FIRST inbound
 * message of its conversations, deduped case-insensitively, up to 5. Test and
 * sandbox conversations are excluded. Additive: the existing fields are
 * unchanged, and a meaningful intent gets no examples.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const DB = vi.hoisted(() => ({ intel: [] as any[], messages: [] as any[], conversations: new Map<string, any>() }));

function holds(row: any, where: any): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (k === "NOT") { if (holds(row, v)) return false; continue; }
    if (k === "conversation") { if (!holds(DB.conversations.get(row.conversationId) ?? {}, v)) return false; continue; }
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const o = v as any;
      // A JSON path filter (metadata.source = "close-analysis").
      if ("path" in o) { if ((o.path as string[]).reduce((x: any, p: string) => x?.[p], row[k]) !== o.equals) return false; continue; }
      if ("in" in o && !o.in.includes(row[k])) return false;
      if ("not" in o && row[k] === o.not) return false;
      if ("startsWith" in o && !String(row[k] ?? "").startsWith(o.startsWith)) return false;
      if ("gte" in o && row[k] < o.gte) return false;
      if ("lte" in o && row[k] > o.lte) return false;
      continue;
    }
    if (row[k] !== v) return false;
  }
  return true;
}

vi.mock("@chatcenter/shared", () => ({
  getRedis: () => ({}),
  prisma: {
    conversationIntelligence: {
      groupBy: async (a: any) => {
        if (!a.where?.tenantId) throw new Error("tenant guard");
        const m = new Map<string, number>();
        for (const r of DB.intel.filter((r) => holds(r, a.where))) m.set(r.detectedIntent, (m.get(r.detectedIntent) ?? 0) + 1);
        return [...m].sort((x, y) => y[1] - x[1]).map(([detectedIntent, n]) => ({ detectedIntent, _count: { detectedIntent: n } }));
      },
      findMany: async (a: any) => {
        if (!a.where?.tenantId) throw new Error("tenant guard");
        return DB.intel.filter((r) => holds(r, a.where));
      },
    },
    message: {
      findMany: async (a: any) => {
        if (!a.where?.tenantId) throw new Error("tenant guard");
        return DB.messages.filter((m) => holds(m, a.where)).sort((x, y) => x.createdAt - y.createdAt);
      },
    },
  },
}));

import { getTopQuestions, normalizeQuestion, isGreetingOnly } from "../services/analytics.service";

const now = new Date();
const at = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000);
let n = 0;
function convo(intent: string, msgs: string[], conv: Partial<{ isTest: boolean; customerExternalId: string; legacy: boolean }> = {}) {
  const id = `c${++n}`;
  const { legacy, ...c } = conv;
  DB.conversations.set(id, { isTest: false, customerExternalId: "97250", ...c });
  // The analysis on close marks its rows; a legacy row (keyword guesses) has no source.
  DB.intel.push({ tenantId: "T", conversationId: id, detectedIntent: intent, analyzedAt: at(1), metadata: legacy ? null : { source: "close-analysis" } });
  msgs.forEach((body, i) => DB.messages.push({ tenantId: "T", conversationId: id, direction: "INBOUND", body, createdAt: at(100 - i) }));
}

beforeEach(() => { DB.intel = []; DB.messages = []; DB.conversations.clear(); n = 0; });

describe("examples for vague groups", () => {
  it("★ the 'other' group carries the customers' first questions, most common first", async () => {
    convo("other", ["  Do you ship   to Eilat? ", "thanks"]);
    convo("other", ["do you ship to eilat?"]);
    convo("other", ["What sizes do you have?"]);
    const [g]: any = await getTopQuestions("T");
    expect(g).toMatchObject({ key: "other", label: "Other", question: "Other", intent: "other", count: 3 });
    expect(g.examples).toEqual([
      { question: "Do you ship to Eilat?", count: 2 },
      { question: "What sizes do you have?", count: 1 },
    ]);
  });

  it("uses the FIRST inbound message, not a later 'thanks'", async () => {
    convo("other", ["Is the store open on Saturday?", "ok thanks"]);
    const [g]: any = await getTopQuestions("T");
    expect(g.examples).toEqual([{ question: "Is the store open on Saturday?", count: 1 }]);
  });

  it("★ test and sandbox conversations are not 'what people asked'", async () => {
    convo("other", ["real question"]);
    convo("other", ["rehearsal"], { isTest: true });
    convo("other", ["sandbox try"], { customerExternalId: "sandbox:abc" });
    const [g]: any = await getTopQuestions("T");
    expect(g.examples).toEqual([{ question: "real question", count: 1 }]);
  });

  it("the examples come only from analysed conversations too", async () => {
    convo("other", ["a real question"]);
    convo("other", ["an old guessed one"], { legacy: true });
    const [g]: any = await getTopQuestions("T");
    expect(g.examples).toEqual([{ question: "a real question", count: 1 }]);
  });

  it("caps at 5 examples", async () => {
    for (let i = 0; i < 7; i++) convo("other", [`question number ${i}`]);
    const [g]: any = await getTopQuestions("T");
    expect(g.examples).toHaveLength(5);
  });

  it("★ a meaningful intent is unchanged - no examples field", async () => {
    convo("order_status", ["where is my order"]);
    const [g]: any = await getTopQuestions("T");
    expect(g).toEqual({ key: "order_status", label: "Order status", question: "Order status", intent: "order_status", count: 1, automatable: false });
  });

  it("★ the label is in the reader's language, the key stays the same", async () => {
    convo("order_status", ["איפה ההזמנה שלי"]);
    const [g]: any = await getTopQuestions("T", undefined, undefined, 10, "he");
    expect(g).toMatchObject({ key: "order_status", intent: "order_status", label: "סטטוס הזמנה", question: "סטטוס הזמנה" });
  });

  it("★ only the analysis on close counts: no keyword-guess rows, no rehearsals", async () => {
    convo("refund", ["I want my money back"]);
    convo("general", ["hi"], { legacy: true });
    convo("unknown", ["?"], { legacy: true });
    convo("refund", ["rehearsal refund"], { customerExternalId: "sandbox:ag:1" });
    convo("refund", ["test refund"], { isTest: true });
    const groups: any[] = await getTopQuestions("T");
    expect(groups.map((g) => [g.key, g.count])).toEqual([["refund", 1]]);
  });
});

describe("normalizeQuestion", () => {
  it("trims, collapses whitespace and caps length", () => {
    expect(normalizeQuestion("  a \n\n b  ")).toBe("a b");
    expect(normalizeQuestion("x".repeat(300))).toHaveLength(200);
    expect(normalizeQuestion(null)).toBe("");
  });
});

describe("a greeting is not the question", () => {
  it("★ 'היי' then a real question → the question is shown", async () => {
    convo("other", ["היי", "אני מחפש סנובורד לילדים"]);
    const [g]: any = await getTopQuestions("T");
    expect(g.examples).toEqual([{ question: "אני מחפש סנובורד לילדים", count: 1 }]);
  });

  it("★ a greeting with nothing after it is still shown, not dropped", async () => {
    convo("other", ["היי"]);
    const [g]: any = await getTopQuestions("T");
    expect(g.examples).toEqual([{ question: "היי", count: 1 }]);
  });

  it("a real first question is kept as is", async () => {
    convo("other", ["אני מחפש סנובורד לילדים", "היי"]);
    const [g]: any = await getTopQuestions("T");
    expect(g.examples).toEqual([{ question: "אני מחפש סנובורד לילדים", count: 1 }]);
  });

  it.each(["היי", "הייי!", "שלום", "hi", "Hello!!", "hiii", "👋", "🙂🙂", "?!", "ok", "בוקר טוב", "אהלן"])(
    "'%s' is a greeting", (t) => expect(isGreetingOnly(t)).toBe(true));

  it.each(["היי אני רוצה לבטל את ההזמנה שלי 1006", "שלום, איפה ההזמנה?", "hi, where is my order", "יש קופון?", "1006"])(
    "'%s' is not just a greeting", (t) => expect(isGreetingOnly(t)).toBe(false));
});
