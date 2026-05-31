/**
 * Tenant isolation regression — verifies the voice-sessions fix uses
 * `loadSessionForTenant` (tenantId-guarded) rather than a raw
 * `findUnique({ where: { id } })` that could leak across tenants.
 *
 * This is a static-analysis style test: we read the route file and
 * assert the patterns we'd expect after the F-002 patch landed. It
 * complements (rather than replaces) integration tests with a real DB.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const VOICE_SESSIONS_PATH = path.resolve(
  __dirname,
  "../../../../../services/conversation/src/routes/voice-sessions.ts",
);

const EMBEDDED_CHAT_PATH = path.resolve(
  __dirname,
  "../../routes/embedded-chat.ts",
);

function readFileOrSkip(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

describe("voice-sessions.ts — tenant-scoped session lookup", () => {
  it("file exists at the expected path", () => {
    const src = readFileOrSkip(VOICE_SESSIONS_PATH);
    expect(src, `expected ${VOICE_SESSIONS_PATH} to exist`).toBeTruthy();
  });

  it("declares `loadSessionForTenant` and matches sessions on tenantId", () => {
    const src = readFileOrSkip(VOICE_SESSIONS_PATH)!;
    expect(src).toMatch(/async function loadSessionForTenant\(/);
    expect(src).toMatch(/session\.tenantId !== tenantId/);
  });

  it("every route handler resolves session via loadSessionForTenant(req.tenantId!)", () => {
    const src = readFileOrSkip(VOICE_SESSIONS_PATH)!;
    // Count handler invocations of the helper.
    const helperCalls = (src.match(/loadSessionForTenant\(String\(req\.params\.id\)/g) || []).length;
    expect(helperCalls).toBeGreaterThanOrEqual(5);
    // Helper is always called with the tenant id from the request.
    expect(src).toMatch(/loadSessionForTenant\(String\(req\.params\.id\), req\.tenantId!\)/);
  });

  it("CRM / brief / contact lookups are scoped by tenantId", () => {
    const src = readFileOrSkip(VOICE_SESSIONS_PATH)!;
    // Each cross-conversation lookup carries a tenantId guard.
    expect(src).toMatch(/customerBrief\.findFirst\(\{\s*where:\s*\{\s*tenantId:\s*req\.tenantId!/);
    expect(src).toMatch(/contact\.findFirst\(\{\s*where:\s*\{\s*tenantId:\s*req\.tenantId!/);
    expect(src).toMatch(/getHistoryByCustomerExternalId\(req\.tenantId!/);
  });

  it("the gate query for voiceCopilotEnabled scopes to req.tenantId", () => {
    const src = readFileOrSkip(VOICE_SESSIONS_PATH)!;
    // The tenant lookup is by-id, but the id IS req.tenantId — same property.
    expect(src).toMatch(/tenant\.findUnique\(\{\s*where:\s*\{\s*id:\s*req\.tenantId!/);
  });
});

describe("embedded-chat.ts — public widget uses explicit cross-tenant marker on init", () => {
  it("file exists", () => {
    const src = readFileOrSkip(EMBEDDED_CHAT_PATH);
    expect(src).toBeTruthy();
  });

  it("uses `withCrossTenantAccess` for the public widget init lookup (auditable boundary crossing)", () => {
    const src = readFileOrSkip(EMBEDDED_CHAT_PATH)!;
    expect(src).toMatch(/withCrossTenantAccess\(/);
  });

  it("derives tenantId from the resolved ChannelAccount and uses it on subsequent writes", () => {
    const src = readFileOrSkip(EMBEDDED_CHAT_PATH)!;
    expect(src).toMatch(/channelAccount\.tenantId/);
    // Conversation creation scopes to that tenantId.
    expect(src).toMatch(/conversation\.create\(\{[\s\S]*tenantId:\s*channelAccount\.tenantId/);
  });

  it("messages-poll endpoint scopes by tenantId derived from the session", () => {
    const src = readFileOrSkip(EMBEDDED_CHAT_PATH)!;
    // The poll handler builds `where = { tenantId: conversation.tenantId, ... }`.
    expect(src).toMatch(/tenantId:\s*conversation\.tenantId/);
  });
});
