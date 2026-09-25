/**
 * Keyset pagination for the conversation list.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT THESE EXIST TO PREVENT, IN ORDER OF HOW BADLY IT WOULD END
 *
 * 1. ★ A PERMISSIONS LEAK WEARING A PAGINATION DIFF. `where.OR` on this query
 *    already holds the department/agent VISIBILITY clause. A keyset predicate is
 *    also an `OR`, so assigning one replaces that scoping silently - the list
 *    returns conversations the agent must never see, perfectly ordered, with no
 *    error, and a reviewer reading the diff sees pagination.
 *
 *    So the assertion here is on the QUERY, not on the rows. A fake returns
 *    whatever it likes regardless of the filter, so "the right rows came back"
 *    cannot see a clause that was never applied.
 *
 * 2. ★ AN INCOMPLETE SET MADE OF CORRECT PAGES. Offset paging on a
 *    recency-ordered list shows a duplicate and SKIPS a row when a message
 *    arrives mid-scroll; the skipped conversation is somebody waiting who never
 *    appears. The same failure can be reintroduced by a keyset with a broken
 *    boundary - and every single-page assertion still passes, because each page
 *    IS correct. Only walking the whole list and counting catches it. That
 *    happened on the customer timeline: it stopped at 100 of 120 and reported
 *    itself complete.
 *
 *    → `walks the WHOLE list` below is that test. Do not replace it with
 *      something cheaper that checks one page.
 *
 * 3. The null tail. `lastMessageAt` is a denormalised cache that ~9 message
 *    writers never maintained, so rows exist with it NULL. Nulls sort last, and
 *    a cursor that cannot address them makes those conversations unreachable -
 *    the exact defect this change exists to remove.
 * ════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as any[],
  seenWhere: null as any,
  seenArgs: null as any,
  counted: 0,
}));

// Exhaustive by necessity: the barrel is mocked wholesale, and a symbol the
// service imports but the mock omits is `undefined` at module scope - which
// throws during collection and reports as "no tests" rather than a failure.
vi.mock("@chatcenter/shared", () => ({
  getInternalServiceKey: () => "test-key",
  readDurableSetting: async () => null,
  recordHandover: async () => undefined,
  publishEvent: async () => undefined,
  outgoingMessageQueue: { add: async () => undefined },
  notificationsQueue: { add: async () => undefined },
  withHistoricalRecords: (fn: any) => fn(),
  prisma: {
    conversation: {
      findMany: async (args: any) => {
        state.seenWhere = args.where;
        state.seenArgs = args;
        // Apply the keyset predicate the way Postgres would, so a dropped or
        // malformed boundary cannot pass here.
        let rows = [...state.rows];
        const keysetClause = (args.where?.AND ?? []).find(
          (c: any) => c?.OR?.some?.((x: any) => x?.lastMessageAt?.lt !== undefined || x?.lastMessageAt === null) || c?.AND,
        );
        if (keysetClause) rows = rows.filter((r) => matchesKeyset(r, keysetClause));
        // Sorted the way the QUERY asked, not the way this fake would prefer.
        // Hard-coding the tiebreak here would make the straddle test pass with
        // `{ id: "desc" }` missing from orderBy - the fake being more faithful
        // than the code, which is how a control stops being one.
        rows.sort((a, b) => order(a, b, args.orderBy));
        return rows.slice(0, args.take);
      },
      count: async () => { state.counted += 1; return state.rows.length; },
    },
  },
}));

/**
 * `(lastMessageAt desc nulls last, id desc)` — driven by the query's own
 * `orderBy`, so a missing tiebreak is visible here rather than supplied.
 */
function order(a: any, b: any, orderBy?: any[]): number {
  const at = a.lastMessageAt ? a.lastMessageAt.getTime() : -Infinity;
  const bt = b.lastMessageAt ? b.lastMessageAt.getTime() : -Infinity;
  if (at !== bt) return bt - at;
  const hasIdTiebreak = (orderBy ?? []).some((o: any) => o?.id);
  // Without the tiebreak the database's order among equals is arbitrary. Insertion
  // order stands in for "arbitrary", which is enough to make the walk unstable.
  if (!hasIdTiebreak) return 0;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** The predicate the service built, evaluated as the database would. */
function matchesKeyset(row: any, clause: any): boolean {
  if (Array.isArray(clause.OR)) {
    return clause.OR.some((c: any) => {
      if (c.lastMessageAt === null) return row.lastMessageAt === null;
      if (c.lastMessageAt?.lt) return !!row.lastMessageAt && row.lastMessageAt < c.lastMessageAt.lt;
      if (Array.isArray(c.AND)) {
        const at = c.AND[0].lastMessageAt;
        const idLt = c.AND[1].id.lt;
        return !!row.lastMessageAt && row.lastMessageAt.getTime() === at.getTime() && row.id < idLt;
      }
      return false;
    });
  }
  if (Array.isArray(clause.AND)) {
    return row.lastMessageAt === null && row.id < clause.AND[1].id.lt;
  }
  return true;
}

vi.mock("../lib/socket", () => ({ getIO: () => null }));
vi.mock("../services/message.service", () => ({}));

import { list, encodeConversationCursor, decodeConversationCursor } from "../services/conversation.service";

/** A non-ADMIN with a department is what produces a visibility clause. */
const AGENT = { userRole: "AGENT", userId: "u1", userDepartmentId: "d1" };

const conv = (id: string, minutesAgo: number | null) => ({
  id,
  lastMessageAt: minutesAgo === null ? null : new Date(Date.now() - minutesAgo * 60_000),
  messages: [{ direction: "INBOUND", body: "hi", createdAt: new Date() }],
});

beforeEach(() => {
  state.rows = [];
  state.seenWhere = null;
  state.seenArgs = null;
  state.counted = 0;
});

describe("★ the visibility clause survives the keyset", () => {
  it("★ is still present in the final where, unchanged", async () => {
    state.rows = [conv("c1", 1)];

    await list("t1", { ...AGENT, cursor: "" });

    // The real visibilityClause() for a departmental AGENT. Asserted on the
    // QUERY: if a keyset predicate had been assigned to `where.OR`, this array
    // would be gone and every row-level assertion would still pass.
    expect(state.seenWhere.OR).toEqual([
      { departmentId: "d1", assignedAgentId: null },
      { departmentId: null, assignedAgentId: null },
      { assignedAgentId: "u1" },
    ]);
  });

  it("★ survives a SECOND page too, where the predicate is non-empty", async () => {
    state.rows = [conv("c1", 1), conv("c2", 2)];
    const first = await list("t1", { ...AGENT, cursor: "", limit: 1 });

    await list("t1", { ...AGENT, cursor: (first as any).page.nextCursor, limit: 1 });

    expect(state.seenWhere.OR).toEqual([
      { departmentId: "d1", assignedAgentId: null },
      { departmentId: null, assignedAgentId: null },
      { assignedAgentId: "u1" },
    ]);
    // And the keyset went into AND, never over OR.
    expect(Array.isArray(state.seenWhere.AND)).toBe(true);
  });

  it("puts the keyset in AND beside the other AND clauses, not instead of them", async () => {
    state.rows = [conv("c1", 1), conv("c2", 2)];
    const first = await list("t1", { ...AGENT, cursor: "", limit: 1 });

    // `search` also pushes an OR into AND - both must coexist.
    await list("t1", { ...AGENT, cursor: (first as any).page.nextCursor, limit: 1, search: "dana" });

    const andClauses = state.seenWhere.AND as any[];
    expect(andClauses.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(andClauses)).toContain("customerName");
    expect(JSON.stringify(andClauses)).toContain("lastMessageAt");
  });

  it("an ADMIN has no visibility clause, and the keyset still lands in AND", async () => {
    state.rows = [conv("c1", 1), conv("c2", 2)];
    const first = await list("t1", { userRole: "ADMIN", userId: "u9", cursor: "", limit: 1 });

    await list("t1", { userRole: "ADMIN", userId: "u9", cursor: (first as any).page.nextCursor, limit: 1 });

    // visibilityClause returns null for ADMIN, so OR is absent rather than empty.
    expect(state.seenWhere.OR).toBeUndefined();
    expect(Array.isArray(state.seenWhere.AND)).toBe(true);
  });
});

describe("★ walks the WHOLE list — every page correct is not the same as a complete set", () => {
  it("★ visits all 120 conversations exactly once across pages of 25", async () => {
    state.rows = Array.from({ length: 120 }, (_, i) => conv(`c${String(i).padStart(4, "0")}`, i));

    const seen: string[] = [];
    let cursor: string | null = "";
    for (let guard = 0; guard < 20 && cursor !== null; guard++) {
      const res: any = await list("t1", { ...AGENT, cursor, limit: 25 });
      seen.push(...res.data.map((c: any) => c.id));
      cursor = res.page.nextCursor;
    }

    // The assertion no per-page check can make. A boundary that drops one row
    // per page leaves every page internally correct and the set short.
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
  });

  it("★ reaches the NULL tail, which sorts after every real timestamp", async () => {
    state.rows = [conv("c1", 1), conv("c2", 2), conv("n1", null), conv("n2", null)];

    const seen: string[] = [];
    let cursor: string | null = "";
    for (let guard = 0; guard < 10 && cursor !== null; guard++) {
      const res: any = await list("t1", { ...AGENT, cursor, limit: 1 });
      seen.push(...res.data.map((c: any) => c.id));
      cursor = res.page.nextCursor;
    }

    // Without a cursor that can express "inside the nulls", these two rows are
    // unreachable - conversations that exist and can never be paged to.
    expect(seen).toEqual(["c1", "c2", "n2", "n1"]);
  });

  it("★ does not straddle a page boundary on an identical timestamp", async () => {
    const same = new Date("2026-09-25T10:00:00.000Z");
    state.rows = ["a", "b", "c", "d"].map((id) => ({ ...conv(id, 0), lastMessageAt: same }));

    const seen: string[] = [];
    let cursor: string | null = "";
    for (let guard = 0; guard < 10 && cursor !== null; guard++) {
      const res: any = await list("t1", { ...AGENT, cursor, limit: 2 });
      seen.push(...res.data.map((c: any) => c.id));
      cursor = res.page.nextCursor;
    }

    // id is the tiebreak; without it these four share a sort position and the
    // skip reappears in a rarer, harder-to-reproduce form.
    expect(seen).toEqual(["d", "c", "b", "a"]);
  });

  it("stops offering a cursor on the last page", async () => {
    state.rows = [conv("c1", 1), conv("c2", 2)];

    const res: any = await list("t1", { ...AGENT, cursor: "", limit: 50 });

    expect(res.data).toHaveLength(2);
    expect(res.page.hasMore).toBe(false);
    expect(res.page.nextCursor).toBeNull();
  });
});

describe("the cursor itself", () => {
  it("round-trips a real timestamp and a null", () => {
    const at = new Date("2026-09-25T10:00:00.000Z");
    expect(decodeConversationCursor(encodeConversationCursor(at, "c1"))).toEqual({ at, id: "c1" });
    expect(decodeConversationCursor(encodeConversationCursor(null, "n1"))).toEqual({ at: null, id: "n1" });
  });

  it("★ refuses a malformed cursor rather than restarting at the top", async () => {
    state.rows = [conv("c1", 1)];

    // Silently restarting reads to a paging UI as a list that never ends.
    await expect(list("t1", { ...AGENT, cursor: "not-a-cursor" })).rejects.toThrow("invalid_cursor");
    await expect(list("t1", { ...AGENT, cursor: "~c1" })).rejects.toThrow("invalid_cursor");
    await expect(list("t1", { ...AGENT, cursor: "2026-13-45T99:99:99Z~c1" })).rejects.toThrow("invalid_cursor");
  });

  it("an empty cursor means the FIRST keyset page, not an invalid one", async () => {
    state.rows = [conv("c1", 1)];

    const res: any = await list("t1", { ...AGENT, cursor: "" });

    expect(res.page).toBeTruthy();
    expect(res.data).toHaveLength(1);
  });
});

describe("what the keyset does not do, and what offset callers keep", () => {
  it("★ counts NO total on the keyset path", async () => {
    state.rows = Array.from({ length: 10 }, (_, i) => conv(`c${i}`, i));

    const res: any = await list("t1", { ...AGENT, cursor: "", limit: 5 });

    // A keyset list cannot page to a known end, and the count was a second full
    // scan for a figure the caller does not need.
    expect(state.counted).toBe(0);
    expect(res.meta).toBeUndefined();
  });

  it("★ leaves the legacy offset shape exactly as it was", async () => {
    state.rows = Array.from({ length: 10 }, (_, i) => conv(`c${i}`, i));

    const res: any = await list("t1", { ...AGENT, page: 1, limit: 5 });

    // Existing callers pass `page` and read `meta`. Breaking them to add a
    // cursor would trade one invisible fault for a visible one.
    expect(res.meta).toEqual({ total: 10, page: 1, limit: 5, totalPages: 2 });
    expect(res.page).toBeUndefined();
    expect(state.counted).toBe(1);
    expect(state.seenArgs.skip).toBe(0);
  });

  it("orders by lastMessageAt then id on BOTH paths", async () => {
    state.rows = [conv("c1", 1)];

    await list("t1", { ...AGENT, page: 1 });
    expect(state.seenArgs.orderBy).toEqual([
      { lastMessageAt: { sort: "desc", nulls: "last" } },
      { id: "desc" },
    ]);

    await list("t1", { ...AGENT, cursor: "" });
    expect(state.seenArgs.orderBy).toEqual([
      { lastMessageAt: { sort: "desc", nulls: "last" } },
      { id: "desc" },
    ]);
  });

  it("takes limit + 1 on the keyset path to learn whether more exist", async () => {
    state.rows = [conv("c1", 1)];

    await list("t1", { ...AGENT, cursor: "", limit: 25 });

    expect(state.seenArgs.take).toBe(26);
    expect(state.seenArgs.skip).toBeUndefined();
  });
});
