/**
 * Hidden conversations get no automation (2026-11-22): the one rule (lib/relevance-hidden.ts), its Prisma
 * twin, and the read that fails open.
 */
import { describe, it, expect } from "vitest";
import { relevanceHidden, notHiddenWhere, isConversationHidden, AUTOMATION_HIDDEN_CATEGORIES, HIDDEN_CONFIDENCE } from "../lib/relevance-hidden";
import { IRRELEVANT_CATEGORIES, RELEVANCE_CATEGORY_VALUES } from "../lib/conversation-relevance";

const row = (relevanceCategory: string | null, relevanceConfidence: number | null, relevanceOverriddenBy: string | null = null) =>
  ({ relevanceCategory, relevanceConfidence, relevanceOverriddenBy });

describe("relevanceHidden", () => {
  it("the hidden labels are the inbox's not-relevant ones plus internal, nothing else", () => {
    expect([...AUTOMATION_HIDDEN_CATEGORIES].sort()).toEqual([...IRRELEVANT_CATEGORIES, "internal"].sort());
    expect(HIDDEN_CONFIDENCE).toBe(0.7);
  });

  it("a classifier label hides from 0.7, on an account whose filter is on", () => {
    for (const c of AUTOMATION_HIDDEN_CATEGORIES) {
      expect(relevanceHidden(row(c, 0.7), true)).toBe(true);
      expect(relevanceHidden(row(c, 0.95), true)).toBe(true);
      expect(relevanceHidden(row(c, 0.69), true)).toBe(false);
      expect(relevanceHidden(row(c, null), true)).toBe(false);
      expect(relevanceHidden(row(c, 0.95), false)).toBe(false);
    }
  });

  it("business, reply_to_outbound and unclear never hide, at any confidence", () => {
    for (const c of ["business", "reply_to_outbound", "unclear"]) {
      expect(relevanceHidden(row(c, 1), true)).toBe(false);
      expect(relevanceHidden(row(c, 1, "u1"), true)).toBe(false);
    }
  });

  it("a person's mark counts both ways: personal hides on any account, business never hides", () => {
    expect(relevanceHidden(row("personal", null, "u1"), true)).toBe(true);
    expect(relevanceHidden(row("personal", null, "u1"), false)).toBe(true);
    expect(relevanceHidden(row("business", 0.99, "u1"), true)).toBe(false);
  });

  it("no label, no row: not hidden", () => {
    expect(relevanceHidden(row(null, null), true)).toBe(false);
    expect(relevanceHidden(null, true)).toBe(false);
    expect(relevanceHidden(undefined, true)).toBe(false);
  });
});

/** A small evaluator for the where shapes notHiddenWhere uses. */
function matches(r: any, w: any): boolean {
  if (w.OR) return w.OR.some((x: any) => matches(r, x));
  if (w.AND) return w.AND.every((x: any) => matches(r, x));
  return Object.entries(w).every(([k, v]: [string, any]) => {
    if (k === "channelAccount") return r.channelAccount != null && Object.entries(v.is).every(([kk, vv]) => r.channelAccount[kk] === vv);
    if (v === null) return r[k] === null;
    if (v && typeof v === "object") {
      if ("notIn" in v) return r[k] !== null && !v.notIn.includes(r[k]);
      if ("lt" in v) return r[k] !== null && r[k] < v.lt;
    }
    return r[k] === v;
  });
}

describe("notHiddenWhere: the same rule in a query", () => {
  it("selects exactly the rows relevanceHidden calls visible", () => {
    const cats = [null, ...RELEVANCE_CATEGORY_VALUES];
    let checked = 0;
    for (const c of cats) for (const conf of [null, 0.2, 0.69, 0.7, 0.9]) for (const by of [null, "u1"]) for (const acct of [null, true, false]) {
      const r = { relevanceCategory: c, relevanceConfidence: conf, relevanceOverriddenBy: by, channelAccount: acct === null ? null : { relevanceFilterEnabled: acct } };
      const visible = !relevanceHidden(r, acct !== false);
      expect([c, conf, by, acct, matches(r, notHiddenWhere())]).toEqual([c, conf, by, acct, visible]);
      checked++;
    }
    expect(checked).toBe(9 * 5 * 2 * 3);
  });
});

describe("isConversationHidden", () => {
  const db = (result: any) => ({ conversation: { findFirst: async (a: any) => { db.last = a; if (result instanceof Error) throw result; return result; } } }) as any;
  (db as any).last = null;

  it("reads this conversation in this workspace, and applies the account's filter", async () => {
    expect(await isConversationHidden("t1", "c1", db({ ...row("personal", 0.9), channelAccount: { relevanceFilterEnabled: true } }))).toBe(true);
    expect((db as any).last.where).toEqual({ id: "c1", tenantId: "t1" });
    expect(await isConversationHidden("t1", "c1", db({ ...row("personal", 0.9), channelAccount: { relevanceFilterEnabled: false } }))).toBe(false);
    expect(await isConversationHidden("t1", "c1", db({ ...row("personal", 0.9), channelAccount: null }))).toBe(true);
  });

  it("fails open: a failed read, a missing row or no id is not hidden", async () => {
    expect(await isConversationHidden("t1", "c1", db(new Error("db down")))).toBe(false);
    expect(await isConversationHidden("t1", "c1", db(null))).toBe(false);
    expect(await isConversationHidden("t1", "", db(row("personal", 1, "u1")))).toBe(false);
    expect(await isConversationHidden("", "c1", db(row("personal", 1, "u1")))).toBe(false);
  });
});
