/**
 * The Command Center's memory and the AI-Employee Builder's transcripts share
 * one table (SystemAgentMessage; the builder keys sessionId = employee id):
 *   - ★ "clear" wipes the operator's Command Center rows, never a builder transcript
 *     nor a Home chat thread's memory (sessionId = the thread id)
 *   - ★ the runtime reads ONE session's memory (not the user's whole history),
 *     so builder turns and other sessions never reach the model
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ rows: [] as any[], seenHistory: null as any }));

function match(row: any, where: any): boolean {
  return Object.entries(where).every(([k, v]: [string, any]) =>
    v && typeof v === "object" && "notIn" in v ? !v.notIn.includes(row[k]) : row[k] === v);
}

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    prisma: {
      aIAgent: { findMany: async (a: any) => [{ id: "emp_1", tenantId: "T" }, { id: "emp_x", tenantId: "OTHER" }].filter((e) => e.tenantId === a.where.tenantId) },
      assistantThread: { findMany: async (a: any) => [{ id: "thr_1", tenantId: "T", userId: "u1" }].filter((t) => t.tenantId === a.where.tenantId && t.userId === a.where.userId) },
      systemAgentMessage: {
        deleteMany: async (a: any) => {
          const before = H.rows.length;
          H.rows = H.rows.filter((r) => !match(r, a.where));
          return { count: before - H.rows.length };
        },
        findMany: async (a: any) => H.rows.filter((r) => match(r, a.where)),
      },
    },
  };
});

import { clearAgentMemory, getSessionMemory } from "../services/agent-memory.service";

beforeEach(() => {
  H.rows = [
    { id: "1", tenantId: "T", userId: "u1", sessionId: "cmdk-a", role: "user", content: "hi", createdAt: new Date(1) },
    { id: "2", tenantId: "T", userId: "u1", sessionId: "cmdk-b", role: "user", content: "other session", createdAt: new Date(2) },
    { id: "3", tenantId: "T", userId: "u1", sessionId: "emp_1", role: "user", content: "builder interview", createdAt: new Date(3) },
    { id: "4", tenantId: "T", userId: "u2", sessionId: "cmdk-c", role: "user", content: "someone else", createdAt: new Date(4) },
    { id: "5", tenantId: "T", userId: "u1", sessionId: "thr_1", role: "user", content: "a Home chat thread", createdAt: new Date(5) },
  ];
});

describe("★ the Command Center and the Builder are separate", () => {
  it("clear removes the operator's Command Center rows, never the builder's transcript or another user's", async () => {
    expect(await clearAgentMemory({ tenantId: "T", userId: "u1" })).toBe(2);
    expect(H.rows.map((r) => r.id)).toEqual(["3", "4", "5"]);
  });

  it("memory is one session: no other session, no builder turns", async () => {
    const m = await getSessionMemory({ tenantId: "T", userId: "u1", sessionId: "cmdk-a" });
    expect(m.map((x) => x.content)).toEqual(["hi"]);
  });
});
