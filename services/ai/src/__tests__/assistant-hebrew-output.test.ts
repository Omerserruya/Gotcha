/**
 * ★ The assistant in a Hebrew interface (Home chat and Ctrl+K, one runtime):
 *   - no wide dash reaches the operator: every streamed token, the step
 *     summaries, and what is saved to memory carry "-" instead
 *   - result labels and summaries are in the interface language (an English
 *     label used to be quoted verbatim inside the Hebrew answer)
 *   - in English nothing changes
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ round: 0, memory: [] as any[], deltas: [] as string[] }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const t = { findFirst: async () => null, findMany: async () => [], findUnique: async () => null, count: async () => 3 };
  return { ...actual, prisma: { conversation: t, message: t, contact: t, tenantTool: t, approvalRequest: t } };
});
vi.mock("../services/agent-memory.service", () => ({
  appendToMemory: async (a: any) => { H.memory.push(a); },
  getSessionMemory: async () => [],
  memoryToChatMessages: () => [],
  sanitizeHistoryForLLM: (x: any) => x,
}));
vi.mock("../services/ai.service", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    streamResponse: async function* () {
      H.round++;
      if (H.round === 1) {
        yield { done: true, content: "", usage: {}, toolCalls: [
          { id: "t1", type: "function", function: { name: "system_get_metric", arguments: JSON.stringify({ metric: "closed_today" }) } },
          { id: "t2", type: "function", function: { name: "system_count_conversations", arguments: JSON.stringify({ status: "OPEN", channel: "WHATSAPP" }) } },
        ] };
      } else {
        for (const d of H.deltas) yield { contentDelta: d };
        yield { done: true, content: H.deltas.join(""), toolCalls: [], usage: {} };
      }
    },
  };
});

import { runAgent } from "../services/agent-runtime.service";

const WIDE = /[\u2013\u2014\u2015]/;

async function run(locale: "he" | "en") {
  const events: any[] = [];
  await runAgent({
    operator: { tenantId: "T", userId: "u1", viewer: { userId: "u1", role: "ADMIN" }, locale },
    client: null, message: "כמה שיחות נסגרו היום?", sessionId: "s1", ephemeral: false, aiAgentId: null,
  } as any, (e) => { events.push(e); });
  return events;
}

beforeEach(() => {
  H.round = 0; H.memory = [];
  // A dash on its own, one inside a delta, and an en dash.
  H.deltas = ["יש 3 שיחות ", "\u2014", " נסגרו היום (9\u201310). רוצה\u2014פירוט?"];
});

describe("★ no wide dash reaches the operator", () => {
  it("every streamed token is clean and the text keeps a regular hyphen in its place", async () => {
    const tokens = (await run("he")).filter((e) => e.type === "token").map((e) => e.text);
    expect(tokens.length).toBe(3);
    expect(tokens.some((t) => WIDE.test(t))).toBe(false);
    expect(tokens.join("")).toBe("יש 3 שיחות - נסגרו היום (9-10). רוצה-פירוט?");
  });

  it("no event of the run carries one, and the answer saved to memory is clean", async () => {
    const events = await run("he");
    expect(WIDE.test(JSON.stringify(events))).toBe(false);
    const saved = H.memory.filter((m) => m.role === "assistant").map((m) => m.content).join("");
    expect(saved).toContain("רוצה-פירוט?");
    expect(WIDE.test(saved)).toBe(false);
  });
});

describe("★ result labels follow the interface language", () => {
  it("Hebrew: the summaries and the labels the model reads are Hebrew", async () => {
    const events = await run("he");
    const ends = events.filter((e) => e.type === "tool_end").map((e) => e.resultSummary);
    expect(ends).toEqual(["3 שיחות שנסגרו היום", "3 שיחות פתוחות בערוץ וואטסאפ"]);
    // The step says what is counted, not a generic "counting conversations".
    expect(events.filter((e) => e.type === "tool_start").map((e) => e.label)[1]).toBe("סופר שיחות פתוחות בערוץ וואטסאפ");
    const toolRows = H.memory.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content).label);
    expect(toolRows).toEqual(["שיחות שנסגרו היום", "שיחות פתוחות בערוץ וואטסאפ"]);
  });

  it("English is unchanged", async () => {
    const ends = (await run("en")).filter((e) => e.type === "tool_end").map((e) => e.resultSummary);
    expect(ends).toEqual(["3 conversations closed today", "3 open conversations on WhatsApp"]);
  });
});
