/**
 * ★ The worker's lastError codes read back through AUTH's own parser
 * (2026-10-09). The worker writes "[CODE] sentence"; auth's channels reads
 * split it. If either side's format moves, this fails instead of the screen
 * silently falling back to a generic line.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { withErrorCode, errorCodeOf, clearOwnError, ERROR_CODES_KNOWN } from "../lib/error-code";

// A computed path keeps tsc (rootDir: src) out of auth's tree; vitest loads it.
const AUTH_ERROR_CODE = path.resolve(__dirname, "../../../auth/src/lib/error-code.ts");

describe("★ error-code twin of services/auth/src/lib/error-code.ts", () => {
  it("pins the exact stored format", () => {
    expect(withErrorCode("SUBSCRIBE_FAILED", "a sentence.")).toBe("[SUBSCRIBE_FAILED] a sentence.");
    expect(withErrorCode("WATCH_FAILED")).toBe(`[WATCH_FAILED] ${ERROR_CODES_KNOWN.WATCH_FAILED}`);
  });

  it("every code this worker writes is split by auth into { sentence, code }", async () => {
    const auth: any = await import(AUTH_ERROR_CODE);
    for (const code of Object.keys(ERROR_CODES_KNOWN) as Array<keyof typeof ERROR_CODES_KNOWN>) {
      expect(auth.splitErrorCode(withErrorCode(code))).toEqual({ lastError: ERROR_CODES_KNOWN[code], lastErrorCode: code });
      expect(auth.splitErrorCode(withErrorCode(code, "with (detail): x."))).toEqual({ lastError: "with (detail): x.", lastErrorCode: code });
    }
  });

  it("writes exactly what auth's own writer writes, and auth knows every code", async () => {
    const auth: any = await import(AUTH_ERROR_CODE);
    for (const code of Object.keys(ERROR_CODES_KNOWN)) {
      expect(Object.keys(auth.ERROR_CODES_KNOWN)).toContain(code);
      expect(withErrorCode(code as any, "  why it failed. ")).toBe(auth.withErrorCode(code, "  why it failed. "));
      expect(withErrorCode(code as any, "")).toBe(`[${code}] ${ERROR_CODES_KNOWN[code as keyof typeof ERROR_CODES_KNOWN]}`);
    }
  });

  it("errorCodeOf reads the code, and free text has none", () => {
    expect(errorCodeOf("[WATCH_FAILED] x")).toBe("WATCH_FAILED");
    expect(errorCodeOf("Token refresh failed: [x]")).toBeNull();
    expect(errorCodeOf(null)).toBeNull();
  });

  it("clearOwnError clears free text and its own code, never another writer's code", () => {
    expect(clearOwnError("[WATCH_FAILED] x", "WATCH_FAILED")).toBeNull();
    expect(clearOwnError("Gmail watch renewal failed: boom", "WATCH_FAILED")).toBeNull();
    expect(clearOwnError(null, "WATCH_FAILED")).toBeNull();
    expect(clearOwnError("[SHOPIFY_CHAT_UNINSTALLED] y", "WATCH_FAILED")).toBe("[SHOPIFY_CHAT_UNINSTALLED] y");
  });
});
