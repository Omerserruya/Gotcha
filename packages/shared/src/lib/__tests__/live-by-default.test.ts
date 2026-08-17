import { describe, it, expect } from "vitest";
import { applyLiveByDefault, mentionsOrigin } from "../prisma";

/**
 * Live-by-default: the mechanism that makes "a historical message is not a live
 * message" true everywhere at once.
 *
 * Historical Intelligence Import backfills up to 180 days of a business's past
 * WhatsApp conversations into the same two tables the product already reads.
 * For one real customer that is roughly twelve thousand messages and a thousand
 * conversations, all of it dated before GOTCHA existed for them.
 *
 * Every query written before that feature existed - the inbox list, the unread
 * badge, the analytics aggregates, the idle-conversation sweeper, the AI's own
 * "what did we last talk about" lookups - means LIVE. None of them say so,
 * because until now there was nothing else it could mean. This function is what
 * keeps them meaning it.
 *
 * The consequences of getting it wrong, in order of severity: the AI answers a
 * customer about an order from last March; a flow re-triggers on a two-year-old
 * keyword; twelve thousand unread messages appear overnight; every analytics
 * number the customer has ever seen changes.
 */

const LIVE = { origin: "LIVE" };

describe("the models that hold both live traffic and imported history", () => {
  it.each(["Conversation", "Message"])("narrows %s reads to live rows", (model) => {
    const out = applyLiveByDefault(model, "findMany", { where: { tenantId: "t1" } }, false) as any;
    expect(out.where).toEqual({ tenantId: "t1", ...LIVE });
  });

  it("leaves every other model completely alone", () => {
    // Contact, KnowledgeDocument and the rest have no origin column. Injecting
    // one would turn every query against them into an error.
    for (const model of ["Contact", "KnowledgeDocument", "AIAgent", "Tenant"]) {
      const args = { where: { tenantId: "t1" } };
      expect(applyLiveByDefault(model, "findMany", args, false)).toBe(args);
    }
  });

  it("leaves an unknown model alone", () => {
    const args = { where: {} };
    expect(applyLiveByDefault(undefined, "findMany", args, false)).toBe(args);
  });
});

describe("which operations are narrowed", () => {
  it.each(["findMany", "findFirst", "count", "aggregate", "groupBy", "updateMany", "deleteMany"])(
    "narrows %s, because it returns or affects many rows",
    (operation) => {
      const out = applyLiveByDefault("Message", operation, { where: {} }, false) as any;
      expect(out.where).toEqual(LIVE);
    },
  );

  it.each(["findUnique", "update", "delete", "create", "upsert"])(
    "leaves %s alone, because it keys by a primary key",
    (operation) => {
      // A row fetched by its own id is unambiguous: the caller already has the
      // id and knows what it points at. Narrowing these would break the import
      // pipeline's own updates to rows it just created.
      const args = { where: { id: "m1" } };
      expect(applyLiveByDefault("Message", operation, args, false)).toBe(args);
    },
  );
});

describe("an explicit caller is never overridden", () => {
  it("respects a query that asks for historical rows", () => {
    const args = { where: { tenantId: "t1", origin: "HISTORICAL_IMPORT" } };
    expect(applyLiveByDefault("Message", "findMany", args, false)).toBe(args);
  });

  it("respects a query filtered by a specific import", () => {
    // Filtering by importId is an unambiguous request for that import's rows.
    // Forcing those callers to also write `origin` would be ceremony a future
    // reader would eventually drop, and then silently get nothing back.
    const args = { where: { historicalImportId: "imp1" } };
    expect(applyLiveByDefault("Conversation", "findMany", args, false)).toBe(args);
  });

  it("sees an origin filter nested inside OR", () => {
    const args = {
      where: { OR: [{ origin: "LIVE" }, { origin: "HISTORICAL_IMPORT" }] },
    };
    expect(applyLiveByDefault("Message", "findMany", args, false)).toBe(args);
  });

  it("sees an origin filter nested inside AND and NOT", () => {
    expect(mentionsOrigin({ AND: [{ tenantId: "t" }, { origin: "LIVE" }] })).toBe(true);
    expect(mentionsOrigin({ NOT: { origin: "HISTORICAL_IMPORT" } })).toBe(true);
  });

  it("does not mistake an unrelated field for an origin filter", () => {
    expect(mentionsOrigin({ tenantId: "t1", status: "OPEN" })).toBe(false);
    expect(mentionsOrigin({ metadata: { equals: { origin: "x" } } })).toBe(false);
  });

  it("treats an explicit undefined as not specified", () => {
    // Prisma silently drops `undefined` from a where clause, so a caller who
    // wrote `origin: maybeUndefined` did NOT actually filter and must still get
    // the safe default.
    const out = applyLiveByDefault(
      "Message",
      "findMany",
      { where: { origin: undefined } },
      false,
    ) as any;
    expect(out.where.origin).toBe("LIVE");
  });
});

describe("the escape hatch", () => {
  it("injects nothing inside a historical scope", () => {
    // The import pipeline reads what it wrote, and GDPR export and erasure MUST
    // see everything: a subject-access request that returned half of somebody's
    // conversations, or an erasure that left two years behind, is a compliance
    // failure and a silent one.
    const args = { where: { tenantId: "t1" } };
    expect(applyLiveByDefault("Message", "findMany", args, true)).toBe(args);
  });
});

describe("edge shapes", () => {
  it("handles a query with no where clause at all", () => {
    const out = applyLiveByDefault("Conversation", "count", {}, false) as any;
    expect(out.where).toEqual(LIVE);
  });

  it("handles undefined args", () => {
    const out = applyLiveByDefault("Conversation", "count", undefined, false) as any;
    expect(out.where).toEqual(LIVE);
  });

  it("preserves every other argument", () => {
    const out = applyLiveByDefault(
      "Message",
      "findMany",
      { where: { tenantId: "t1" }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true } },
      false,
    ) as any;
    expect(out.orderBy).toEqual({ createdAt: "desc" });
    expect(out.take).toBe(50);
    expect(out.select).toEqual({ id: true });
  });

  it("does not mutate the caller's object", () => {
    const args = { where: { tenantId: "t1" } };
    applyLiveByDefault("Message", "findMany", args, false);
    expect(args.where).toEqual({ tenantId: "t1" });
  });
});
