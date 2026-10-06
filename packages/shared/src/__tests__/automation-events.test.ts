/**
 * Tag-added events for automations: one per NEW tag, keyed per contact, tag
 * and moment; a queue failure never fails the write that already happened.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const Q = vi.hoisted(() => ({ jobs: [] as any[], fail: false }));
vi.mock("../lib/queue", () => ({
  incomingMessageQueue: { add: async (name: string, data: any, opts: any) => { if (Q.fail) throw new Error("redis down"); Q.jobs.push({ name, data, opts }); } },
}));

import { tagsAdded, emitTagsAdded } from "../lib/automation-events";

beforeEach(() => { Q.jobs = []; Q.fail = false; });

describe("tag-added events", () => {
  it("only tags that were not there before, case as stored", () => {
    expect(tagsAdded(["VIP"], ["VIP", "lead", "lead"])).toEqual(["lead"]);
    expect(tagsAdded(["vip"], ["VIP"])).toEqual(["VIP"]);
    expect(tagsAdded(null, ["a"])).toEqual(["a"]);
    expect(tagsAdded(["a"], ["a"])).toEqual([]);
  });

  it("one automation-event job per new tag", async () => {
    expect(await emitTagsAdded("T", "k1", ["VIP"], ["VIP", "lead", "hot"])).toBe(2);
    expect(Q.jobs.map((j) => [j.name, j.data.type, j.data.tag, j.data.contactId])).toEqual([
      ["automation-event", "tag_added", "lead", "k1"], ["automation-event", "tag_added", "hot", "k1"],
    ]);
    expect(Q.jobs[0].data.eventKey).toMatch(/^tag:k1:lead:\d+$/);
  });

  it("a queue failure is swallowed", async () => {
    Q.fail = true;
    await expect(emitTagsAdded("T", "k1", [], ["x"])).resolves.toBe(1);
  });
});
