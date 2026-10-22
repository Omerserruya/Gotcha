/** The pair keys of "not the same person" marks, and which marks name a contact (erasure cleanup). */
import { describe, it, expect } from "vitest";
import { notSameKey, marksNaming, NOT_SAME } from "../lib/not-same";

const naming = (key: string, ids: string[]) =>
  marksNaming("T", ids).OR.some((c: any) => ("endsWith" in c.key ? key.endsWith(c.key.endsWith) : key.includes(c.key.contains)));

describe("not-same keys", () => {
  it("one key per pair, whatever the order", () => {
    expect(notSameKey("b", "a")).toBe(`${NOT_SAME}a:b`);
    expect(notSameKey("a", "b")).toBe(notSameKey("b", "a"));
  });
  it("a contact's marks are found on either side, never by a prefix of another id", () => {
    const k = notSameKey("c1", "c2");
    expect(naming(k, ["c1"])).toBe(true);
    expect(naming(k, ["c2"])).toBe(true);
    expect(naming(k, ["c"])).toBe(false);
    expect(naming(notSameKey("c10", "c2"), ["c1"])).toBe(false);
    expect(marksNaming("T", ["x"])).toMatchObject({ tenantId: "T", key: { startsWith: NOT_SAME } });
  });
});
