/**
 * ★ The snippet loader (frontend/public/widget/chatcenter-widget.js) on a busy
 * server (2026-10-25): 28 of 46 bootstraps on the dev Woo store answered 429
 * and the widget simply did not draw. Pinned, by running the real file:
 *   - a 429 with nothing kept: retried after the server's retryAfter, then draws
 *   - a 429 with a widget kept from an earlier page view: draws it at once
 *   - a removed widget (200, empty): draws nothing and forgets what was kept
 *   - a 4xx that is not 429: no retry
 *   - at most 4 retries, each wait capped at 30s
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import vm from "vm";

const SOURCE = readFileSync(join(__dirname, "../../../../frontend/public/widget/chatcenter-widget.js"), "utf-8");
const WIDGET = { widget: { appearance: {} }, availability: "online" };

type Answer = { status: number; body: any };

function run(answers: Answer[], storage: Record<string, string> = {}) {
  const calls: string[] = [];
  const delays: number[] = [];
  const mounted: any[] = [];
  const queue = [...answers];
  const window: any = {
    __chatcenter: { apiUrl: "https://dev.gotcha.co.il", widgetId: "wid_0123456789abcdef" },
    localStorage: {
      getItem: (k: string) => (k in storage ? storage[k] : null),
      setItem: (k: string, v: string) => { storage[k] = v; },
      removeItem: (k: string) => { delete storage[k]; },
    },
  };
  const fetch = async (url: string) => {
    calls.push(url);
    if (url.endsWith("/widget-manifest.json")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ site: "s.js", chat: "c.js" }) };
    const a = queue.shift() ?? { status: 200, body: { data: {} } };
    return { ok: a.status < 400, status: a.status, headers: { get: () => null }, json: async () => a.body };
  };
  const document: any = {
    readyState: "complete",
    head: {
      appendChild: (s: any) => {
        window.__gotchaSiteMount = (opts: any) => mounted.push(opts.data);
        window.__gotchaShopifyChatApp = () => undefined;
        s.onload();
      },
    },
    createElement: () => ({}),
  };
  const ctx = vm.createContext({
    window, document, fetch, Promise, JSON, Date, Math, Number, String, Error, console: { warn: () => undefined },
    setTimeout: (fn: () => void, ms: number) => { delays.push(ms); fn(); },
  });
  vm.runInContext(SOURCE, ctx);
  const settled = new Promise((r) => setImmediate(() => setImmediate(() => setTimeout(r, 30))));
  return { settled, calls: () => calls.filter((c) => c.includes("/bootstrap")).length, delays, mounted, storage };
}

const busy = (retryAfter?: number): Answer => ({ status: 429, body: { error: "Too many", ...(retryAfter ? { retryAfter } : {}) } });
const ok: Answer = { status: 200, body: { data: WIDGET } };

describe("★ the loader does not vanish on a busy server", () => {
  it("429 with nothing kept: waits the server's retryAfter, retries, draws", async () => {
    const r = run([busy(7), ok]);
    await r.settled;
    expect(r.calls()).toBe(2);
    expect(r.delays[0]).toBeGreaterThanOrEqual(7000);
    expect(r.delays[0]).toBeLessThan(7500);
    expect(r.mounted).toHaveLength(1);
  });

  it("a good answer is kept, and the next page view's 429 draws it at once", async () => {
    const storage: Record<string, string> = {};
    const first = run([ok], storage);
    await first.settled;
    expect(Object.keys(storage)).toEqual(["cc_boot_wid_0123456789abcdef"]);
    const second = run([busy(30)], storage);
    await second.settled;
    expect(second.calls()).toBe(1);
    expect(second.delays).toEqual([]);
    expect(second.mounted).toHaveLength(1);
  });

  it("a kept widget older than a day is not drawn", async () => {
    const storage = { cc_boot_wid_0123456789abcdef: JSON.stringify({ at: Date.now() - 25 * 3600 * 1000, data: WIDGET }) };
    const r = run([busy(1), ok], storage);
    await r.settled;
    expect(r.calls()).toBe(2);
  });

  it("a removed widget (200, empty) draws nothing and forgets what was kept", async () => {
    const storage = { cc_boot_wid_0123456789abcdef: JSON.stringify({ at: Date.now(), data: WIDGET }) };
    const r = run([{ status: 200, body: { data: {} } }], storage);
    await r.settled;
    expect(r.mounted).toHaveLength(0);
    expect(storage).toEqual({});
  });

  it("a 400 is not retried", async () => {
    const r = run([{ status: 400, body: { error: "bad" } }]);
    await r.settled;
    expect(r.calls()).toBe(1);
    expect(r.mounted).toHaveLength(0);
  });

  it("without retryAfter: 2, 4, 8, 16s, then it stops; a long retryAfter is capped at 30s", async () => {
    const r = run([busy(), busy(), busy(), busy(), busy()]);
    await r.settled;
    expect(r.calls()).toBe(5);
    expect(r.delays.map((d) => Math.floor(d / 1000))).toEqual([2, 4, 8, 16]);
    expect(r.mounted).toHaveLength(0);
    const capped = run([busy(600), ok]);
    await capped.settled;
    expect(capped.delays[0]).toBeLessThan(30500);
  });

  it("a 503 is retried like a 429", async () => {
    const r = run([{ status: 503, body: {} }, ok]);
    await r.settled;
    expect(r.calls()).toBe(2);
    expect(r.mounted).toHaveLength(1);
  });
});
