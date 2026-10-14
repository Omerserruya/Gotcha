/**
 * ★ safeFetchBuffer (W3/W4): bytes from a public address only, re-checked on
 * every redirect hop, with the byte cap enforced while reading.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import dns from "dns";
import { safeFetchBuffer } from "../safe-fetch";

const hosts: Record<string, string> = { "cdn.example.com": "93.184.216.34", "evil.example.com": "169.254.169.254", "drive.google.com": "142.250.1.1" };
let calls: string[] = [];
let cancelled = 0;
let reads = 0;

function body(chunks: Uint8Array[]) {
  let i = 0;
  return {
    getReader: () => ({
      read: async () => (reads++, i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
      cancel: async () => { cancelled++; },
    }),
    cancel: async () => { cancelled++; },
  };
}
const respond = (status: number, headers: Record<string, string>, chunks: Uint8Array[] = []) =>
  ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers), body: body(chunks) }) as any;

let routes: Record<string, () => any> = {};

beforeEach(() => {
  calls = []; cancelled = 0; reads = 0; routes = {};
  vi.spyOn(dns.promises, "lookup").mockImplementation((async (h: string) => {
    const a = hosts[h];
    if (!a) throw new Error("ENOTFOUND");
    return [{ address: a, family: 4 }];
  }) as any);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(url); const r = routes[url]; if (!r) throw new Error("no route " + url); return r(); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("★ safeFetchBuffer", () => {
  it("follows a redirect to a public host and returns the bytes", async () => {
    routes["https://drive.google.com/uc?export=download&id=abc"] = () => respond(303, { location: "https://cdn.example.com/f.png" });
    routes["https://cdn.example.com/f.png"] = () => respond(200, { "content-type": "image/png" }, [new Uint8Array([1, 2]), new Uint8Array([3])]);
    const r = await safeFetchBuffer("https://drive.google.com/uc?export=download&id=abc", { maxBytes: 10 });
    expect(r).toMatchObject({ ok: true, status: 200, contentType: "image/png" });
    expect([...r.buffer!]).toEqual([1, 2, 3]);
  });

  it("★ a redirect to a private / metadata address is refused before it is fetched", async () => {
    routes["https://cdn.example.com/f.png"] = () => respond(302, { location: "https://evil.example.com/latest/meta-data" });
    const r = await safeFetchBuffer("https://cdn.example.com/f.png", { maxBytes: 10 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/blocked address/);
    expect(calls).toEqual(["https://cdn.example.com/f.png"]);
    expect((await safeFetchBuffer("http://127.0.0.1/x", { maxBytes: 10 })).ok).toBe(false);
  });

  it("★ a declared size over the cap stops before the body", async () => {
    routes["https://cdn.example.com/big.png"] = () => respond(200, { "content-length": "11" }, [new Uint8Array(11)]);
    const r = await safeFetchBuffer("https://cdn.example.com/big.png", { maxBytes: 10 });
    expect(r).toMatchObject({ ok: false, tooLarge: true, buffer: null });
    expect(cancelled).toBe(1);
    expect(reads).toBe(0);
  });

  it("★ a body that runs past the cap with no declared size is cancelled mid-read", async () => {
    routes["https://cdn.example.com/stream.png"] = () => respond(200, {}, [new Uint8Array(6), new Uint8Array(6), new Uint8Array(6)]);
    const r = await safeFetchBuffer("https://cdn.example.com/stream.png", { maxBytes: 10 });
    expect(r).toMatchObject({ ok: false, tooLarge: true, buffer: null });
    expect(cancelled).toBe(1);
  });

  it("exactly at the cap is fine; an error status is not ok", async () => {
    routes["https://cdn.example.com/ten"] = () => respond(200, { "content-length": "10" }, [new Uint8Array(10)]);
    expect((await safeFetchBuffer("https://cdn.example.com/ten", { maxBytes: 10 })).buffer!.length).toBe(10);
    routes["https://cdn.example.com/404"] = () => respond(404, {}, [new Uint8Array(3)]);
    expect((await safeFetchBuffer("https://cdn.example.com/404", { maxBytes: 10 })).ok).toBe(false);
  });
});
