/**
 * The relevance label BEFORE anything acts (2026-11-22): services/relevance-inline.service.ts.
 * The ai call is a fetch double; nothing reaches a model.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@chatcenter/shared", async () => {
  const hidden = await vi.importActual<any>("@chatcenter/shared/src/lib/relevance-hidden");
  const rel = await vi.importActual<any>("@chatcenter/shared/src/lib/conversation-relevance");
  return {
    prisma: {},
    getInternalServiceKey: () => "k",
    relevanceChannel: rel.relevanceChannel,
    relevanceHidden: hidden.relevanceHidden,
    relevanceClassifyEnabled: (t: string) => String(process.env.RELEVANCE_CLASSIFY_TENANTS ?? "").split(",").includes(t) || process.env.RELEVANCE_CLASSIFY_TENANTS === "*",
    enqueueRelevanceClassification: async () => true,
  };
});

import { relevanceBeforeDispatch, INLINE_WAIT_MS } from "../services/relevance-inline.service";

const conv = (o: any = {}) => ({ id: "c1", channel: "WHATSAPP", channelAccountId: "ca1", customerExternalId: "972501111111", relevanceCategory: null, relevanceConfidence: null, relevanceOverriddenBy: null, ...o });
const db = (filter = true) => ({ channelAccount: { findFirst: vi.fn(async () => ({ relevanceFilterEnabled: filter })) } });
const answer = (data: any, ok = true) => vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => ({ data }) })) as any;

let enqueue: any;
beforeEach(() => {
  process.env.RELEVANCE_CLASSIFY_TENANTS = "t1";
  enqueue = vi.fn(async () => true);
});

describe("relevanceBeforeDispatch", () => {
  it("a first inbound with no label is labelled now; personal from the model hides it, and its job is told to refine", async () => {
    const fetch = answer({ category: "personal", confidence: 0.88, source: "model" });
    const r = await relevanceBeforeDispatch("t1", conv(), { fetch, enqueue, db: db() });
    expect(r).toMatchObject({ hidden: true, outcome: "labelled", category: "personal" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toMatch(/\/api\/internal\/relevance\/classify$/);
    expect(JSON.parse(init.body)).toEqual({ tenantId: "t1", conversationId: "c1" });
    expect(init.headers["X-Internal-Key"]).toBe("k");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(enqueue).toHaveBeenCalledWith("t1", "c1", undefined, { refine: true });
  });

  it("a rule's answer hides with no refinement; a business label does not hide", async () => {
    let r = await relevanceBeforeDispatch("t1", conv(), { fetch: answer({ category: "auto_reply", confidence: 0.9, source: "fast" }), enqueue, db: db() });
    expect(r.hidden).toBe(true);
    expect(enqueue).toHaveBeenLastCalledWith("t1", "c1", undefined, { refine: false });
    r = await relevanceBeforeDispatch("t1", conv(), { fetch: answer({ category: "business", confidence: 0.95, source: "model" }), enqueue, db: db() });
    expect(r).toMatchObject({ hidden: false, outcome: "labelled", category: "business" });
  });

  it("an unsure model label (under 0.7) does not hide", async () => {
    const r = await relevanceBeforeDispatch("t1", conv(), { fetch: answer({ category: "personal", confidence: 0.6, source: "model" }), enqueue, db: db() });
    expect(r.hidden).toBe(false);
  });

  it("the sender rule's personal hides at once", async () => {
    const r = await relevanceBeforeDispatch("t1", conv(), { fetch: answer({ category: "personal", confidence: 1, source: "sender" }), enqueue, db: db() });
    expect(r.hidden).toBe(true);
  });

  it("a timeout, an error answer or a thrown fetch: not hidden, the 2-minute job still queued, no refine", async () => {
    const slow = vi.fn((_u: string, init: any) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "TimeoutError" })))));
    let r = await relevanceBeforeDispatch("t1", conv(), { fetch: slow as any, enqueue, db: db(), waitMs: 20 });
    expect(r).toMatchObject({ hidden: false, outcome: "timeout" });
    expect(enqueue).toHaveBeenLastCalledWith("t1", "c1", undefined, { refine: false });
    r = await relevanceBeforeDispatch("t1", conv(), { fetch: answer({ source: "error" }), enqueue, db: db() });
    expect(r).toMatchObject({ hidden: false, outcome: "no_label" });
    r = await relevanceBeforeDispatch("t1", conv(), { fetch: answer({}, false), enqueue, db: db() });
    expect(r).toMatchObject({ hidden: false, outcome: "error" });
    r = await relevanceBeforeDispatch("t1", conv(), { fetch: vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as any, enqueue, db: db() });
    expect(r).toMatchObject({ hidden: false, outcome: "error" });
    expect(enqueue).toHaveBeenCalledTimes(4);
  });

  it("waits at most 3 s by default", () => {
    expect(INLINE_WAIT_MS).toBe(3000);
  });

  it("a stored label decides with no call: hidden from 0.7, and the job is queued as on every inbound", async () => {
    const fetch = answer({ category: "business", confidence: 1, source: "model" });
    let r = await relevanceBeforeDispatch("t1", conv({ relevanceCategory: "marketing", relevanceConfidence: 0.9 }), { fetch, enqueue, db: db() });
    expect(r).toMatchObject({ hidden: true, outcome: "stored" });
    r = await relevanceBeforeDispatch("t1", conv({ relevanceCategory: "marketing", relevanceConfidence: 0.5 }), { fetch, enqueue, db: db() });
    expect(r).toMatchObject({ hidden: false, outcome: "stored" });
    expect(fetch).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith("t1", "c1", undefined, { refine: false });
  });

  it("a person's mark decides both ways, on any channel, tenant or filter, with no call and no read", async () => {
    const fetch = answer({ category: "business", confidence: 1, source: "model" });
    const d = db(false);
    process.env.RELEVANCE_CLASSIFY_TENANTS = "";
    expect((await relevanceBeforeDispatch("t1", conv({ relevanceCategory: "personal", relevanceOverriddenBy: "u1" }), { fetch, enqueue, db: d })).hidden).toBe(true);
    expect((await relevanceBeforeDispatch("t1", conv({ channel: "WEBCHAT", relevanceCategory: "personal", relevanceOverriddenBy: "u1" }), { fetch, enqueue, db: d })).hidden).toBe(true);
    process.env.RELEVANCE_CLASSIFY_TENANTS = "t1";
    expect((await relevanceBeforeDispatch("t1", conv({ relevanceCategory: "business", relevanceConfidence: 0.2, relevanceOverriddenBy: "u1" }), { fetch, enqueue, db: d })).hidden).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(d.channelAccount.findFirst).not.toHaveBeenCalled();
  });

  it("no call where nothing is classified: a site chat, a tenant outside the switch, a sandbox, an account with the filter off", async () => {
    const fetch = answer({ category: "personal", confidence: 1, source: "model" });
    expect((await relevanceBeforeDispatch("t1", conv({ channel: "WEBCHAT" }), { fetch, enqueue, db: db() })).outcome).toBe("not_classified");
    expect((await relevanceBeforeDispatch("t2", conv(), { fetch, enqueue, db: db() })).outcome).toBe("not_classified");
    expect((await relevanceBeforeDispatch("t1", conv({ customerExternalId: "sandbox:x" }), { fetch, enqueue, db: db() })).outcome).toBe("not_classified");
    const off = await relevanceBeforeDispatch("t1", conv(), { fetch, enqueue, db: db(false) });
    expect(off).toMatchObject({ hidden: false, outcome: "not_classified" });
    // A classifier label on an account whose filter is off counts as none.
    expect((await relevanceBeforeDispatch("t1", conv({ relevanceCategory: "personal", relevanceConfidence: 0.99 }), { fetch, enqueue, db: db(false) })).hidden).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("never throws: anything that breaks before the call is not hidden, and the message goes on", async () => {
    const broken = new Proxy(conv(), { get: (t: any, k) => { if (k === "channel") throw new Error("bad row"); return t[k]; } });
    const r = await relevanceBeforeDispatch("t1", broken, { fetch: answer({ category: "personal", confidence: 1, source: "model" }), enqueue, db: db() });
    expect(r).toMatchObject({ hidden: false, outcome: "error" });
  });

  it("never throws: a failed account read counts as filter on", async () => {
    const bad = { channelAccount: { findFirst: vi.fn(async () => { throw new Error("db down"); }) } };
    const r = await relevanceBeforeDispatch("t1", conv(), { fetch: answer({ category: "notice", confidence: 0.95, source: "fast" }), enqueue, db: bad });
    expect(r).toMatchObject({ hidden: true, outcome: "labelled" });
  });
});
