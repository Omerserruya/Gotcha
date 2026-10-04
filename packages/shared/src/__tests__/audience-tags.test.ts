/**
 * `Contact.tags` is Json (a string[] defaulting to `[]`). The generic scalar
 * translation got every tag operator wrong: contains/in threw inside Prisma,
 * equals never matched, and `exists` (`not: null`) matched EVERY contact,
 * because no row is SQL NULL - so "contacts with a tag" broadcast to the
 * whole list.
 *
 * These pin the clause shapes. The shapes were also run against the real
 * client and dev database (Json filter grammar cannot be checked by a fake);
 * see the commit message for those counts.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/prisma", () => ({ prisma: {} }));

import { tagsToPrismaClause, buildLocalContactWhere } from "../lib/audience";

const T = "tenant-a";

describe("tagsToPrismaClause", () => {
  it("exists means a NON-EMPTY tag list, not a non-null column", () => {
    expect(tagsToPrismaClause("exists", undefined)).toEqual({ NOT: { tags: { equals: [] } } });
  });

  it("not_exists means the empty list", () => {
    expect(tagsToPrismaClause("not_exists", undefined)).toEqual({ tags: { equals: [] } });
  });

  it("equals and contains are an exact element match", () => {
    expect(tagsToPrismaClause("equals", "VIP")).toEqual({ tags: { array_contains: ["VIP"] } });
    expect(tagsToPrismaClause("contains", "VIP")).toEqual({ tags: { array_contains: ["VIP"] } });
  });

  it("is case-sensitive: the value is passed through, not lowered", () => {
    expect(tagsToPrismaClause("contains", "vip")).toEqual({ tags: { array_contains: ["vip"] } });
  });

  it("in is an OR of single-element matches; not_in negates it", () => {
    const anyOf = { OR: [{ tags: { array_contains: ["A"] } }, { tags: { array_contains: ["B"] } }] };
    expect(tagsToPrismaClause("in", ["A", "B"])).toEqual(anyOf);
    expect(tagsToPrismaClause("not_in", ["A", "B"])).toEqual({ NOT: anyOf });
  });

  it("not_equals negates the element match", () => {
    expect(tagsToPrismaClause("not_equals", "VIP")).toEqual({ NOT: { tags: { array_contains: ["VIP"] } } });
  });

  it("never emits the scalar operators Prisma rejects on Json", () => {
    for (const op of ["equals", "contains", "in", "not_in", "not_equals", "exists", "not_exists"] as const) {
      const s = JSON.stringify(tagsToPrismaClause(op, op.includes("in") ? ["A"] : "A"));
      expect(s).not.toMatch(/"(contains|in|notIn|mode|startsWith|not)":/);
    }
  });

  it("returns null for operators with no meaning on a list, and for a missing value", () => {
    expect(tagsToPrismaClause("gt", "A")).toBeNull();
    expect(tagsToPrismaClause("starts_with", "A")).toBeNull();
    expect(tagsToPrismaClause("contains", undefined)).toBeNull();
    expect(tagsToPrismaClause("in", [])).toBeNull();
  });
});

describe("buildLocalContactWhere - tags fail closed", () => {
  it("an untranslatable tag rule matches nobody instead of being dropped", () => {
    const reasoning: string[] = [];
    const where = buildLocalContactWhere(T, { all: [{ field: "tags", op: "starts_with", value: "V" }] }, reasoning);
    // Dropped would be `{ tenantId }` - every contact in the tenant.
    expect(where).not.toEqual({ tenantId: T });
    expect(where).toEqual({ tenantId: T, AND: [{ id: { in: [] } }] });
    expect(reasoning.join(" ")).toMatch(/matches no contacts/);
  });

  it("a supported tag rule composes beside other local rules", () => {
    const where = buildLocalContactWhere(
      T,
      { all: [{ field: "tags", op: "exists" }, { field: "channel", op: "equals", value: "WHATSAPP" }] },
      [],
    );
    expect(where).toEqual({
      tenantId: T,
      AND: [{ NOT: { tags: { equals: [] } } }, { channel: { equals: "WHATSAPP" } }],
    });
  });

  it("keeps the tenant scope on every shape", () => {
    for (const op of ["exists", "not_exists", "gt"] as const) {
      expect(buildLocalContactWhere(T, { all: [{ field: "tags", op, value: "A" }] }, [])).toHaveProperty("tenantId", T);
    }
  });
});
