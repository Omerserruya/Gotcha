/**
 * The Terms and the Privacy Policy, accepted on the first-password screen
 * (2026-10-26, Omer: a required box on setup, recorded as consent).
 *
 * The password never reaches us: the screen drives Authentik's executor from
 * the browser. So "the server refuses a setup without the acceptance" cannot
 * mean refusing the password submit. It means: no Authentik token to set a
 * first password with exists until the acceptance is on file. The emailed link
 * no longer mints; `/accept` records, then mints.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  link: { ok: true, link: { id: "sl1", userId: "u1", tenantId: "t1", email: "dana@acme.com", name: "Dana", authentikSubject: "sub-1" } } as any,
  ready: { status: "ready", pk: 7 } as any,
  events: [] as string[],
  consents: [] as any[],
  audits: [] as any[],
  failConsent: false,
  mintUrl: "https://auth.test/if/flow/gotcha-recovery/?flow_token=FRESH_TOKEN",
}));

vi.mock("@chatcenter/shared", async () => {
  const legal = await vi.importActual<any>("../../../../packages/shared/src/lib/email/brand-email");
  return {
    legalUrls: legal.legalUrls,
    LEGAL_VERSIONS: legal.LEGAL_VERSIONS,
    resolveAppPublicUrl: () => "https://app.example.test",
    writeAudit: async (a: any) => { H.audits.push(a); },
    AuditAction: {
      SETUP_LINK_REJECTED: "rejected",
      SETUP_LINK_REDEEMED: "redeemed",
      SETUP_LINK_ISSUED: "issued",
      CONSENT_GRANTED: "consent_granted",
    },
    withCrossTenantAccess: async (fn: any) => fn(),
    createRecoveryLink: async () => { H.events.push("mint"); return H.mintUrl; },
    prisma: {
      consentRecord: { create: (a: any) => ({ op: "consent", data: a.data }) },
      $transaction: async (ops: any[]) => {
        if (H.failConsent) throw new Error("db down");
        for (const op of ops) { H.consents.push(op.data); H.events.push("consent"); }
        return ops;
      },
    },
  };
});

vi.mock("../services/setup-link.service", async () => {
  const real = await vi.importActual<any>("../services/setup-link.service");
  return {
    flowOfRecoveryUrl: real.flowOfRecoveryUrl,
    resolveSetupLink: async () => H.link,
    identityForSetup: async () => H.ready,
    markSetupLinkUsed: async () => { H.events.push("used"); },
    ownerOfSetupToken: async () => null,
  };
});
vi.mock("../services/notification.service", () => ({ sendSetupLinkEmail: vi.fn() }));

import router from "../routes/setup-link";
import { flowOfRecoveryUrl } from "../services/setup-link.service";

const app = express();
app.use(express.json());
app.use("/api/auth/setup", router);

const TOKEN = "t".repeat(32);
const accept = (body: any, headers: Record<string, string> = {}) => {
  let r = request(app).post(`/api/auth/setup/${TOKEN}/accept`);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send(body);
};
const BOTH = { terms: true, privacy: true, locale: "he", capturedText: "מאשרים את תנאי השירות ואת מדיניות הפרטיות" };

beforeEach(() => {
  H.link = { ok: true, link: { id: "sl1", userId: "u1", tenantId: "t1", email: "dana@acme.com", name: "Dana", authentikSubject: "sub-1" } };
  H.ready = { status: "ready", pk: 7 };
  H.events = [];
  H.consents = [];
  H.audits = [];
  H.failConsent = false;
  H.mintUrl = "https://auth.test/if/flow/gotcha-recovery/?flow_token=FRESH_TOKEN";
});

describe("the emailed link", () => {
  it("goes to the app's setup screen with our token, and mints nothing", async () => {
    const res = await request(app).get(`/api/auth/setup/${TOKEN}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`https://app.example.test/recover?flow=gotcha-recovery&setup=${TOKEN}`);
    expect(H.events).toEqual([]);
  });

  it("a dead one still goes to the expiry page", async () => {
    H.link = { ok: false, reason: "expired" };
    const res = await request(app).get(`/api/auth/setup/${TOKEN}`);
    expect(res.headers.location).toContain("/setup-link/expired?reason=expired");
    expect(H.events).toEqual([]);
  });
});

describe("accept refuses without both boxes", () => {
  for (const [name, body] of [
    ["nothing", {}],
    ["terms only", { terms: true }],
    ["privacy only", { privacy: true }],
    ["privacy false", { terms: true, privacy: false }],
    ["a string is not a tick", { terms: "true", privacy: "true" }],
  ] as const) {
    it(`${name}: 400, nothing recorded, nothing minted`, async () => {
      const res = await accept(body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "consent_required" });
      expect(H.events).toEqual([]);
    });
  }
});

describe("accept with both", () => {
  it("records BOTH, then mints, then answers the flow and its token", async () => {
    const res = await accept(BOTH, { "X-Forwarded-For": "203.0.113.9, 10.0.0.2", "User-Agent": "Mozilla/5.0 test" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: "recovery", flow: "gotcha-recovery", flowToken: "FRESH_TOKEN" } });
    // The order is the guarantee: no token exists before its acceptance does.
    expect(H.events).toEqual(["consent", "consent", "mint", "used"]);
  });

  it("each row is the user's, append-only, with the evidence and the document version", async () => {
    await accept(BOTH, { "X-Forwarded-For": "203.0.113.9, 10.0.0.2", "User-Agent": "Mozilla/5.0 test" });
    expect(H.consents.map((c) => c.purpose)).toEqual(["terms_of_service", "privacy_policy"]);
    for (const c of H.consents) {
      expect(c).toMatchObject({ tenantId: "t1", subjectType: "user", subjectId: "u1", granted: true, source: "setup" });
      expect(c.evidence).toMatchObject({
        ip: "203.0.113.9",
        userAgent: "Mozilla/5.0 test",
        capturedText: BOTH.capturedText,
        locale: "he",
        channel: "setup",
        setupLinkId: "sl1",
      });
      expect(Date.parse(c.evidence.acceptedAt)).not.toBeNaN();
    }
    expect(H.consents[0].evidence.document).toEqual({ url: "https://trust.gotcha.co.il/he/terms-of-service", version: "2026-07-27" });
    expect(H.consents[1].evidence.document).toEqual({ url: "https://trust.gotcha.co.il/he/privacy-policy", version: "2026-07-18" });
  });

  it("an English screen records the English documents", async () => {
    await accept({ ...BOTH, locale: "en", capturedText: "I agree" });
    expect(H.consents[0].evidence.document.url).toBe("https://trust.gotcha.co.il/terms-of-service");
  });

  it("audits the grant against the user", async () => {
    await accept(BOTH);
    const grant = H.audits.find((a) => a.action === "consent_granted");
    expect(grant).toMatchObject({ tenantId: "t1", actorType: "user", actorId: "u1", targetId: "u1" });
    expect(grant.metadata.purposes).toEqual(["terms_of_service", "privacy_policy"]);
  });

  it("a failed write mints nothing: 503, and the link still works", async () => {
    H.failConsent = true;
    const res = await accept(BOTH);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "idp_unavailable" });
    expect(H.events).not.toContain("mint");
  });

  it("an unrecognised mint answer is a 503, not a screen that cannot start", async () => {
    H.mintUrl = "https://auth.test/something-else";
    const res = await accept(BOTH);
    expect(res.status).toBe(503);
    expect(H.events).not.toContain("used");
  });

  it("a repeat accept (a refresh after Continue) records again and mints again", async () => {
    await accept(BOTH);
    await accept(BOTH);
    expect(H.consents).toHaveLength(4);
    expect(H.events.filter((e) => e === "mint")).toHaveLength(2);
  });
});

describe("accept on a link that cannot set a password records nothing", () => {
  it("a dead link: expired, with its reason", async () => {
    H.link = { ok: false, reason: "revoked" };
    const res = await accept(BOTH);
    expect(res.body).toEqual({ data: { status: "expired", reason: "revoked" } });
    expect(H.events).toEqual([]);
  });

  it("someone who already has a password: the way in, no consent, no mint", async () => {
    H.ready = { status: "already_has_password" };
    const res = await accept(BOTH);
    expect(res.body.data.status).toBe("already_has_password");
    expect(res.body.data.next).toBe("https://app.example.test/api/auth/login?returnTo=%2Fonboarding");
    expect(H.events).toEqual([]);
  });

  it("no identity: expired as identity_missing", async () => {
    H.ready = { status: "no_identity" };
    const res = await accept(BOTH);
    expect(res.body).toEqual({ data: { status: "expired", reason: "identity_missing" } });
    expect(H.events).toEqual([]);
  });
});

describe("flowOfRecoveryUrl", () => {
  it("reads the slug and the token out of Authentik's link", () => {
    expect(flowOfRecoveryUrl("https://auth-dev.gotcha.co.il/if/flow/gotcha-recovery/?flow_token=abc123")).toEqual({
      flow: "gotcha-recovery",
      flowToken: "abc123",
    });
  });

  it("refuses anything else", () => {
    for (const bad of ["not a url", "https://a/if/flow/gotcha-recovery/", "https://a/if/flow/../x/?flow_token=t", "https://a/x?flow_token=t"]) {
      expect(flowOfRecoveryUrl(bad)).toBeNull();
    }
  });
});
