import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "../../..");
const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
const migDir = join(ROOT, "prisma/migrations");
const migFile = readdirSync(migDir).find((d) => d.endsWith("_user_session_infra"))!;
const migration = readFileSync(join(migDir, migFile, "migration.sql"), "utf8");

describe("UserSession Prisma schema", () => {
  const model = schema.match(/model UserSession \{[\s\S]*?\n\}/)?.[0] ?? "";

  it("exists and is owned by Identity, not a raw Tenant", () => {
    expect(model).toBeTruthy();
    expect(model).toMatch(/identityId\s+String/);
    expect(model).toMatch(/identity\s+Identity\s+@relation/);
    expect(model).not.toMatch(/tenantId\s+String/); // never coupled directly to a tenant
    expect(model).toMatch(/activeMembershipId\s+String\?/); // active tenant via membership
  });

  it("stores only the hashed token + encrypted provider tokens (no plaintext)", () => {
    expect(model).toMatch(/sessionTokenHash\s+String\s+@unique/);
    expect(model).toMatch(/encryptedAccessToken\s+String/);
    expect(model).toMatch(/encryptedRefreshToken\s+String\?/);
    expect(model).not.toMatch(/\baccessToken\s+String/); // no plaintext access token column
  });

  it("carries lifecycle, revocation, version snapshot, csrf and device metadata", () => {
    for (const f of ["rememberMe", "lastActivityAt", "expiresAt", "revokedAt", "revocationReason", "sessionVersion", "csrfSecret", "userAgentHash"]) {
      expect(model, `field ${f}`).toContain(f);
    }
  });

  it("declares the invalidation/cleanup indexes", () => {
    expect(model).toMatch(/@@index\(\[identityId\]\)/);
    expect(model).toMatch(/@@index\(\[identityId, sessionVersion\]\)/);
    expect(model).toMatch(/@@index\(\[activeMembershipId\]\)/);
    expect(model).toMatch(/@@index\(\[expiresAt\]\)/);
    expect(model).toMatch(/@@index\(\[revokedAt\]\)/);
  });

  it("Identity carries the global sessionVersion counter", () => {
    const identity = schema.match(/model Identity \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(identity).toMatch(/sessionVersion\s+Int\s+@default\(0\)/);
    expect(identity).toMatch(/sessions\s+UserSession\[\]/);
  });
});

describe("UserSession migration", () => {
  it("creates the table, hashed-token unique index, and correct FK delete rules", () => {
    expect(migration).toMatch(/CREATE TABLE "user_sessions"/);
    expect(migration).toMatch(/CREATE UNIQUE INDEX "user_sessions_session_token_hash_key"/);
    expect(migration).toMatch(/"user_sessions_identity_id_fkey"[\s\S]*ON DELETE CASCADE/);
    expect(migration).toMatch(/"user_sessions_active_membership_id_fkey"[\s\S]*ON DELETE SET NULL/);
    expect(migration).toMatch(/ALTER TABLE "identities" ADD COLUMN "session_version"/);
  });
});
