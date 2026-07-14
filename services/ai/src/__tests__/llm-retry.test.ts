/**
 * P1-7 - provider retry/backoff + micro-model tier.
 */

import { describe, it, expect, vi } from "vitest";
import { callWithRetry, getMicroModel } from "../services/ai.service";

const err = (status?: number, name?: string) => Object.assign(new Error("boom"), { status, name });

describe("callWithRetry", () => {
  it("returns on first success (no retries)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    expect(await callWithRetry(fn, undefined, { baseDelayMs: 1 })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 then succeeds", async () => {
    const fn = vi.fn().mockRejectedValueOnce(err(429)).mockResolvedValue("ok");
    expect(await callWithRetry(fn, undefined, { baseDelayMs: 1 })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries a network error (no status) then succeeds", async () => {
    const fn = vi.fn().mockRejectedValueOnce(err(undefined)).mockResolvedValue("ok");
    expect(await callWithRetry(fn, undefined, { baseDelayMs: 1 })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 400 (non-retryable) - throws immediately", async () => {
    const fn = vi.fn().mockRejectedValue(err(400));
    await expect(callWithRetry(fn, undefined, { baseDelayMs: 1 })).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a user abort - throws immediately", async () => {
    const fn = vi.fn().mockRejectedValue(err(undefined, "APIUserAbortError"));
    await expect(callWithRetry(fn, undefined, { baseDelayMs: 1 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    const fn = vi.fn().mockRejectedValue(err(503));
    await expect(callWithRetry(fn, undefined, { maxRetries: 2, baseDelayMs: 1 })).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("stops retrying when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const fn = vi.fn().mockRejectedValue(err(429));
    await expect(callWithRetry(fn, ac.signal, { baseDelayMs: 1 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("getMicroModel", () => {
  it("defaults to a nano-tier model", () => {
    const prev = process.env.OPENAI_MICRO_MODEL;
    delete process.env.OPENAI_MICRO_MODEL;
    expect(getMicroModel()).toBe("gpt-5-nano");
    if (prev !== undefined) process.env.OPENAI_MICRO_MODEL = prev;
  });
  it("honours OPENAI_MICRO_MODEL override", () => {
    const prev = process.env.OPENAI_MICRO_MODEL;
    process.env.OPENAI_MICRO_MODEL = "gpt-5-mini";
    expect(getMicroModel()).toBe("gpt-5-mini");
    if (prev === undefined) delete process.env.OPENAI_MICRO_MODEL; else process.env.OPENAI_MICRO_MODEL = prev;
  });
});
