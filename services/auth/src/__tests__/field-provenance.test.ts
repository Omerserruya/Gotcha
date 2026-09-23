/**
 * What a rescan may overwrite, and what it must only offer.
 *
 * Screen 11b promises *"anything typed stays"*. The rule that keeps that
 * promise is `planRescan`, and the case that matters most is the one with NO
 * recorded provenance: the profile was seeded by an onboarding confirm step
 * whose single upsert meant both "the scan proposed this" and "the human
 * accepted it", so for every tenant that exists today the map is empty.
 *
 * Treating an untracked field as scan-owned would overwrite corrections made
 * during onboarding on the very first rescan - the exact failure the feature
 * exists to prevent, arriving through the fix for it. Unknown is therefore
 * OFFERED, never applied.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => ({ value: null as string | null, writes: [] as Array<string | null> }));

vi.mock("@chatcenter/shared", () => ({
  readDurableSetting: vi.fn(async () => store.value),
  writeDurableSetting: vi.fn(async (_t: string, _k: string, v: string | null) => {
    store.writes.push(v);
    store.value = v;
  }),
}));

import {
  planRescan,
  readProvenance,
  stampProvenance,
  fieldSources,
  PROVENANCE_KEY,
  type ProvenanceMap,
} from "../services/field-provenance.service";

const human = (at = "2026-09-01T00:00:00.000Z"): ProvenanceMap => ({
  businessDescription: { source: "human", at },
});
const scan = (at = "2026-09-01T00:00:00.000Z"): ProvenanceMap => ({
  businessDescription: { source: "scan", at },
});

beforeEach(() => {
  store.value = null;
  store.writes = [];
  vi.clearAllMocks();
});

describe("what a rescan may write", () => {
  it("applies a change to a field the scan owns", () => {
    const plan = planRescan(scan(), { businessDescription: "new" }, { businessDescription: "old" });

    expect(plan.apply).toEqual({ businessDescription: "new" });
    expect(plan.offer).toEqual([]);
  });

  it("OFFERS rather than overwrites a field a person edited", () => {
    const plan = planRescan(human(), { businessDescription: "from site" }, { businessDescription: "typed by owner" });

    expect(plan.apply).toEqual({});
    expect(plan.offer).toEqual([
      {
        field: "businessDescription",
        current: "typed by owner",
        proposed: "from site",
        because: "human_edited",
      },
    ]);
  });

  it("★ OFFERS a field with no recorded provenance, because nobody knows who owns it", () => {
    // Every tenant that exists today is in this state. Applying here would
    // overwrite a correction made at the onboarding confirm step, which is
    // indistinguishable from an untouched scan value in the stored data.
    const plan = planRescan({}, { businessDescription: "from site" }, { businessDescription: "possibly typed" });

    expect(plan.apply).toEqual({});
    expect(plan.offer[0]!.because).toBe("source_unknown");
  });

  it("treats an unreadable provenance store as unknown, so it touches nothing", async () => {
    // A store that cannot be read must not license an overwrite.
    const provenance = await readProvenance("t1"); // store.value is null
    const plan = planRescan(provenance, { businessDescription: "from site" }, { businessDescription: "stored" });

    expect(plan.apply).toEqual({});
    expect(plan.offer).toHaveLength(1);
  });
});

describe("what a rescan must leave alone", () => {
  it("does not report an unchanged value as a finding", () => {
    const plan = planRescan(scan(), { businessDescription: "same" }, { businessDescription: "same" });

    expect(plan.apply).toEqual({});
    // Otherwise every rescan would look like it found something.
    expect(plan.offer).toEqual([]);
  });

  it("never clears a stored value because the scan found nothing", () => {
    // Absence is not evidence that the field is empty.
    const plan = planRescan(scan(), { businessDescription: "", industry: null, country: undefined }, {
      businessDescription: "stored",
      industry: "Retail",
      country: "Israel",
    });

    expect(plan.apply).toEqual({});
    expect(plan.offer).toEqual([]);
  });

  it("ignores fields that are not provenance-tracked", () => {
    const plan = planRescan({}, { somethingElse: "x" } as any, {});

    expect(plan.apply).toEqual({});
    expect(plan.offer).toEqual([]);
  });
});

describe("the stored map", () => {
  it("MERGES a stamp instead of replacing, so one writer cannot erase the other's marks", async () => {
    store.value = JSON.stringify({ industry: { source: "scan", at: "2026-01-01T00:00:00.000Z" } });

    await stampProvenance("t1", ["businessDescription"], "human", "user-1");

    const saved = JSON.parse(store.writes.at(-1)!);
    // The scan's mark survives. A replace would have turned `industry` back
    // into an unknown field, silently downgrading it from refreshable to
    // offer-only.
    expect(saved.industry.source).toBe("scan");
    expect(saved.businessDescription.source).toBe("human");
  });

  it("ignores fields it does not track and writes nothing when none are tracked", async () => {
    await stampProvenance("t1", ["nonsense"], "human");

    expect(store.writes).toEqual([]);
  });

  it("discards a malformed stored entry rather than trusting it", async () => {
    store.value = JSON.stringify({
      businessDescription: { source: "elsewhere", at: "x" },
      industry: "not an object",
      country: { source: "human", at: "2026-01-01T00:00:00.000Z" },
    });

    const map = await readProvenance("t1");

    // An unrecognised source is not a source. Keeping it would let a junk value
    // decide whether a field may be overwritten.
    expect(map.businessDescription).toBeUndefined();
    expect(map.industry).toBeUndefined();
    expect(map.country!.source).toBe("human");
  });

  it("reports every tracked field to the screen, unknown ones as null", () => {
    const sources = fieldSources(human());

    expect(sources.businessDescription).toBe("human");
    // Not "scan". The screen must be able to tell "from the website" from
    // "we do not know", because only one of those may be refreshed silently.
    expect(sources.industry).toBeNull();
    expect(sources.organizationName).toBeNull();
  });

  it("stores under a stable key", () => {
    expect(PROVENANCE_KEY).toBe("profileFieldProvenance");
  });
});
