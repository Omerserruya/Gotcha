/**
 * Setup links: the token that replaced a mailed IdP credential.
 *
 * These tests exist because of a production incident on 2026-08-06. A POC
 * tenant's admin was mailed an Authentik recovery link at 07:14 and opened it
 * at 08:15. Authentik mints that link's FlowToken with no explicit expiry, so
 * it inherited `default_token_duration` (30 minutes) and had been dead for half
 * an hour. The recovery flow has no identification stage, so it rendered "Set
 * your password" anyway and refused only at user_write, AFTER a password had
 * been typed: "Request has been denied. No user found and can't create new
 * user." Meanwhile the email promised 48 hours.
 *
 * So the properties worth pinning are not really about tokens. They are:
 *   - what we mail is OURS, and lives as long as we said it does;
 *   - the IdP link is minted at the click, never before;
 *   - a dead link lands somewhere that says so and offers a repair, instead of
 *     a password form that fails after the fact.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";

interface Row {
  id: string;
  tokenHash: string;
  userId: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

const store = vi.hoisted(() => ({ rows: [] as any[], seq: 0 }));
const users = vi.hoisted(() => ({
  u1: { tenantId: "t1", email: "dana@acme.com", name: "Dana", identity: { authentikSubject: "sub-1" } },
}));
const idp = vi.hoisted(() => ({
  lastLogin: null as Date | null,
  recoveryCalls: 0,
}));

const setupLinkTable = vi.hoisted(() => ({
  create: async ({ data }: any) => {
    const row = {
      id: `sl${++store.seq}`,
      tokenHash: data.tokenHash,
      userId: data.userId,
      expiresAt: data.expiresAt,
      usedAt: null as Date | null,
      revokedAt: null as Date | null,
    };
    store.rows.push(row);
    return row;
  },
  updateMany: async ({ where, data }: any) => {
    let count = 0;
    for (const r of store.rows) {
      if (where.userId && r.userId !== where.userId) continue;
      if (where.id && r.id !== where.id) continue;
      if (where.revokedAt === null && r.revokedAt !== null) continue;
      if (where.usedAt === null && r.usedAt !== null) continue;
      Object.assign(r, data);
      count++;
    }
    return { count };
  },
  findUnique: async ({ where }: any) => {
    const row = store.rows.find((r: any) => r.tokenHash === where.tokenHash);
    if (!row) return null;
    return { ...row, user: (users as any).u1 };
  },
}));

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    setupLink: setupLinkTable,
    $transaction: async (fn: any) => fn({ setupLink: setupLinkTable }),
  },
  withCrossTenantAccess: async (fn: any) => fn(),
  createRecoveryLink: async () => {
    idp.recoveryCalls++;
    return "https://auth.test/if/flow/gotcha-recovery/?flow_token=fresh";
  },
  ensureIdentity: async () => ({ pk: 7, subject: "sub-1", email: "dana@acme.com", username: "dana" }),
  findIdentityBySubject: async () => ({ pk: 7, subject: "sub-1", email: "dana@acme.com", username: "dana" }),
  getUserLastLogin: async () => idp.lastLogin,
  resolveAppPublicUrl: (env: NodeJS.ProcessEnv = process.env) =>
    (env.FRONTEND_URL || "https://app.test").replace(/\/+$/, ""),
}));

import {
  issueSetupLink,
  resolveSetupLink,
  redeemForRecoveryUrl,
  ownerOfSetupToken,
  hashSetupToken,
} from "../services/setup-link.service";

beforeEach(() => {
  store.rows = [];
  store.seq = 0;
  idp.lastLogin = null;
  idp.recoveryCalls = 0;
  process.env.FRONTEND_URL = "https://app.test";
});

describe("issuing", () => {
  it("mails a GOTCHA URL, not an Authentik one", async () => {
    const { url } = await issueSetupLink("u1");
    expect(url.startsWith("https://app.test/api/auth/setup/")).toBe(true);
    // The whole point: no IdP token is minted at send time.
    expect(idp.recoveryCalls).toBe(0);
  });

  it("persists only the hash, never the raw token", async () => {
    const { token } = await issueSetupLink("u1");
    const stored = JSON.stringify(store.rows);
    expect(stored).not.toContain(token);
    expect(store.rows[0].tokenHash).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
  });

  it("defaults to the 48 hours the email has always claimed", async () => {
    const { expiresAt } = await issueSetupLink("u1");
    const hours = (expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47.9);
    expect(hours).toBeLessThan(48.1);
  });

  it("revokes the previous live link, so a resend is a replacement", async () => {
    const first = await issueSetupLink("u1");
    await issueSetupLink("u1");
    const old = await resolveSetupLink(first.token);
    expect(old.ok).toBe(false);
    expect(old.ok === false && old.reason).toBe("revoked");
  });
});

describe("resolving", () => {
  it("accepts a live token", async () => {
    const { token } = await issueSetupLink("u1");
    const res = await resolveSetupLink(token);
    expect(res.ok).toBe(true);
    expect(res.ok && res.link.userId).toBe("u1");
  });

  it("refuses an expired one", async () => {
    const { token } = await issueSetupLink("u1", { ttlHours: -1 });
    const res = await resolveSetupLink(token);
    expect(res.ok === false && res.reason).toBe("expired");
  });

  it("refuses an unknown one, and garbage, identically", async () => {
    expect((await resolveSetupLink("a".repeat(32))).ok).toBe(false);
    expect((await resolveSetupLink("short")).ok).toBe(false);
    expect((await resolveSetupLink(undefined)).ok).toBe(false);
    expect((await resolveSetupLink({ token: "x" })).ok).toBe(false);
  });

  it("still identifies the owner of a DEAD token, which is what makes resend possible", async () => {
    const { token } = await issueSetupLink("u1", { ttlHours: -1 });
    const owner = await ownerOfSetupToken(token);
    expect(owner?.userId).toBe("u1");
    // ...and only for a token we actually issued.
    expect(await ownerOfSetupToken("b".repeat(32))).toBeNull();
  });
});

describe("redeeming", () => {
  it("mints the IdP link at CLICK time", async () => {
    const { token } = await issueSetupLink("u1");
    const res = await resolveSetupLink(token);
    expect(res.ok).toBe(true);
    const outcome = res.ok ? await redeemForRecoveryUrl(res.link) : null;
    expect(outcome?.status).toBe("recovery");
    expect(idp.recoveryCalls).toBe(1);
  });

  it("refuses to walk someone who already has a password into a reset", async () => {
    idp.lastLogin = new Date();
    const { token } = await issueSetupLink("u1");
    const res = await resolveSetupLink(token);
    const outcome = res.ok ? await redeemForRecoveryUrl(res.link) : null;
    expect(outcome?.status).toBe("already_has_password");
    expect(idp.recoveryCalls).toBe(0);
  });

  it("hashes deterministically (the lookup is one indexed probe)", () => {
    expect(hashSetupToken("abc")).toBe(hashSetupToken("abc"));
    expect(hashSetupToken("abc")).not.toBe(hashSetupToken("abd"));
  });
});

/**
 * The contract across three files that different people change at different
 * times: the service builds a URL, the auth service has to mount a route at
 * that path, and the failure redirect has to land on a page that exists. Any
 * one of them moving alone breaks a flow nobody on the team receives email for.
 */
describe("wiring", () => {
  const repo = path.resolve(__dirname, "../../../..");

  it("the URL the email carries is a route the auth service mounts", () => {
    const index = fs.readFileSync(path.join(repo, "services/auth/src/index.ts"), "utf8");
    expect(index).toContain('app.use("/api/auth/setup", setupLinkRoutes)');
  });

  it("the expiry redirect lands on a page that exists", () => {
    const route = fs.readFileSync(path.join(repo, "services/auth/src/routes/setup-link.ts"), "utf8");
    expect(route).toContain("/setup-link/expired");
    expect(fs.existsSync(path.join(repo, "frontend/src/app/setup-link/expired/page.tsx"))).toBe(true);
  });

  it("no mail path hands out a raw Authentik recovery link any more", () => {
    for (const f of [
      "services/auth/src/services/invitation.service.ts",
      "services/auth/src/services/notification.service.ts",
    ]) {
      expect(fs.readFileSync(path.join(repo, f), "utf8")).not.toContain("createRecoveryLink(");
    }
  });
});
