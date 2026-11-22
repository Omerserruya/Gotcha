/**
 * The public sign-up, behind its "check your email" answer (2026-11-22).
 *
 * The route answers before any of this runs, so nothing here has a screen to
 * fail on. What is pinned: who gets which email, that an address with an
 * account never opens a second organization, that the new organization is the
 * console's trial with the days and credits the settings name, that the mark
 * the card sweep reads is a snapshot, and that the function never rejects.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  state: { enabled: true, trialDays: 14, cardRequiredAfterDays: 14, trialCredits: 5000, envEnabled: true, open: true } as any,
  stateFails: false,
  identity: null as any,
  member: null as any,
  authentik: { subject: "sub-1", pk: 77, email: "dana@acme.co.il", username: "dana@acme.co.il" } as any,
  authentikThrows: false,
  lastLogin: null as any,
  creations: [] as any[],
  creationResults: [] as any[],
  creationGate: null as Promise<void> | null,
  durable: [] as any[],
  durableFails: false,
  consents: [] as any[],
  consentFails: false,
  audits: [] as any[],
  hints: [] as any[],
  hintFails: false,
  setupLinks: [] as any[],
  calls: [] as string[],
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    prisma: {
      identity: {
        findUnique: async (q: any) => { H.calls.push("identity:" + JSON.stringify(q.where)); return H.identity; },
      },
      user: {
        findFirst: async (q: any) => { H.calls.push("member:" + JSON.stringify({ where: q.where, orderBy: q.orderBy })); return H.member; },
      },
      consentRecord: {
        create: (q: any) => ({ __row: q.data }),
      },
      $transaction: async (ops: any[]) => {
        if (H.consentFails) throw new Error("db down");
        H.consents.push(...ops.map((o) => o.__row));
      },
    },
    withCrossTenantAccess: (fn: any) => fn(),
    selfSignupState: async () => {
      H.calls.push("state");
      if (H.stateFails) throw new Error("settings unreadable");
      return H.state;
    },
    findIdentityBySubject: async (subject: string) => {
      H.calls.push("authentik:" + subject);
      if (H.authentikThrows) throw new Error("authentik down");
      return H.authentik;
    },
    getUserLastLogin: async (pk: number) => { H.calls.push("lastLogin:" + pk); return H.lastLogin; },
    writeDurableSetting: async (tenantId: string, key: string, value: string) => {
      if (H.durableFails) throw new Error("db down");
      H.durable.push({ tenantId, key, value });
    },
    writeAudit: async (a: any) => { H.audits.push(a); },
  };
});

vi.mock("../services/tenant-creation.service", () => ({
  LICENSE_DOMAINS: ["communication", "sales", "marketing", "insights"],
  createTenantWithAdmin: async (input: any) => {
    H.creations.push(input);
    if (H.creationGate) await H.creationGate;
    const next = H.creationResults.shift();
    if (next instanceof Error) throw next;
    return next ?? { status: 201, body: { data: {} }, created: { tenantId: "t_new", adminUserId: "u_new" } };
  },
}));

vi.mock("../services/notification.service", () => ({
  sendSignInHintEmail: async (...a: any[]) => { H.hints.push(a); if (H.hintFails) throw new Error("smtp down"); },
  sendSetupLinkEmail: async (...a: any[]) => { H.setupLinks.push(a); },
}));

import { runSelfSignup, SELF_SIGNUP_NOTE } from "../services/self-signup.service";
import { LEGAL_VERSIONS, legalUrls, SELF_SIGNUP_ORIGIN_KEY, AuditAction } from "@chatcenter/shared";

const NOW = new Date("2026-11-22T10:00:00.000Z");
const REQ = {
  name: "Dana Katz",
  email: "dana@acme.co.il",
  businessName: "Acme Flowers",
  locale: "he" as const,
  capturedText: "קראתי ואני מסכים/ה לתנאי השימוש ולמדיניות הפרטיות",
  ip: "203.0.113.9",
  userAgent: "Mozilla/5.0 (test)",
};

beforeEach(() => {
  H.state = { enabled: true, trialDays: 14, cardRequiredAfterDays: 14, trialCredits: 5000, envEnabled: true, open: true };
  H.stateFails = false;
  H.identity = null; H.member = null;
  H.authentik = { subject: "sub-1", pk: 77, email: "dana@acme.co.il", username: "dana@acme.co.il" };
  H.authentikThrows = false; H.lastLogin = null;
  H.creations = []; H.creationResults = []; H.creationGate = null;
  H.durable = []; H.durableFails = false;
  H.consents = []; H.consentFails = false;
  H.audits = []; H.hints = []; H.hintFails = false; H.setupLinks = []; H.calls = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

const nothingCreated = () => {
  expect(H.creations).toEqual([]);
  expect(H.durable).toEqual([]);
  expect(H.consents).toEqual([]);
};
const noMail = () => {
  expect(H.hints).toEqual([]);
  expect(H.setupLinks).toEqual([]);
};

describe("an address nobody has: a new organization", () => {
  it("is the console's trial organization, opened by nobody on our side", async () => {
    expect(await runSelfSignup(REQ, NOW)).toEqual({ kind: "created", tenantId: "t_new" });
    expect(H.creations).toHaveLength(1);
    const c = H.creations[0];
    expect(c.slug).toMatch(/^acme-flowers-[0-9a-f]{6}$/);
    expect({ ...c, slug: "" }).toEqual({
      name: "Acme Flowers",
      slug: "",
      adminEmail: "dana@acme.co.il",
      adminName: "Dana Katz",
      locale: "he",
      billing: {
        mode: "POC",
        pocCredits: 5000,
        pocExpiresAt: "2026-12-06T10:00:00.000Z",
        pocFeatureAreas: ["communication", "sales", "marketing", "insights"],
        commercialNote: SELF_SIGNUP_NOTE,
      },
      actor: { type: "system", id: null },
    });
    noMail();
  });

  it("the days and the credits are the ones the console holds today", async () => {
    H.state = { ...H.state, trialDays: 21, cardRequiredAfterDays: 7, trialCredits: 2000 };
    await runSelfSignup(REQ, NOW);
    expect(H.creations[0].billing.pocCredits).toBe(2000);
    expect(H.creations[0].billing.pocExpiresAt).toBe("2026-12-13T10:00:00.000Z");
  });

  it("the organization carries the mark the card sweep reads: a snapshot of today's promise", async () => {
    H.state = { ...H.state, trialDays: 21, cardRequiredAfterDays: 7, trialCredits: 2000 };
    await runSelfSignup(REQ, NOW);
    expect(H.durable).toHaveLength(1);
    expect(H.durable[0].tenantId).toBe("t_new");
    expect(H.durable[0].key).toBe(SELF_SIGNUP_ORIGIN_KEY);
    expect(JSON.parse(H.durable[0].value)).toEqual({
      at: "2026-11-22T10:00:00.000Z",
      trialDays: 21,
      cardRequiredAfterDays: 7,
      trialCredits: 2000,
    });
  });

  it("the two ticks are written as two rows under the new organization, with where and when", async () => {
    await runSelfSignup(REQ, NOW);
    const urls = legalUrls("he");
    const evidence = {
      ip: "203.0.113.9",
      userAgent: "Mozilla/5.0 (test)",
      capturedText: REQ.capturedText,
      locale: "he",
      channel: "self_signup",
      acceptedAt: "2026-11-22T10:00:00.000Z",
    };
    const row = { tenantId: "t_new", subjectType: "user", subjectId: "u_new", granted: true, source: "self_signup" };
    expect(H.consents).toEqual([
      { ...row, purpose: "terms_of_service", evidence: { ...evidence, document: { url: urls.terms, version: LEGAL_VERSIONS.terms } } },
      { ...row, purpose: "privacy_policy", evidence: { ...evidence, document: { url: urls.privacy, version: LEGAL_VERSIONS.privacy } } },
    ]);
    expect(H.audits).toEqual([
      {
        tenantId: "t_new",
        actorType: "user",
        actorId: "u_new",
        action: AuditAction.CONSENT_GRANTED,
        targetType: "user",
        targetId: "u_new",
        metadata: { purposes: ["terms_of_service", "privacy_policy"], versions: LEGAL_VERSIONS, source: "self_signup", locale: "he" },
      },
    ]);
  });

  it("an English form writes English documents; a browser line of any length is kept to 500", async () => {
    await runSelfSignup({ ...REQ, locale: "en", userAgent: "u".repeat(900), ip: null, capturedText: null }, NOW);
    expect(H.creations[0].locale).toBe("en");
    expect(H.consents[0].evidence.document.url).toBe(legalUrls("en").terms);
    expect(H.consents[0].evidence.userAgent).toHaveLength(500);
    expect(H.consents[0].evidence.ip).toBeNull();
    expect(H.consents[0].evidence.capturedText).toBeNull();
  });

  it("no browser line at all is written as none", async () => {
    await runSelfSignup({ ...REQ, userAgent: null }, NOW);
    expect(H.consents[0].evidence.userAgent).toBeNull();
  });

  it("a taken address name is drawn once more, with another ending", async () => {
    H.creationResults = [{ status: 409, body: { error: "Slug already exists" } }];
    expect(await runSelfSignup(REQ, NOW)).toEqual({ kind: "created", tenantId: "t_new" });
    expect(H.creations).toHaveLength(2);
    expect(H.creations[0].slug).not.toBe(H.creations[1].slug);
    expect(H.creations[1].slug).toMatch(/^acme-flowers-[0-9a-f]{6}$/);
    expect(H.durable).toHaveLength(1);
  });

  it("taken twice: gives up, writes nothing, says why", async () => {
    H.creationResults = [{ status: 409, body: { error: "Slug already exists" } }, { status: 409, body: { error: "Slug already exists" } }];
    const out = await runSelfSignup(REQ, NOW);
    expect(out.kind).toBe("failed");
    expect((out as any).reason).toContain("409");
    expect(H.creations).toHaveLength(2);
    expect(H.durable).toEqual([]);
    expect(H.consents).toEqual([]);
  });

  it("a refusal that is not about the name is not retried", async () => {
    H.creationResults = [{ status: 400, body: { code: "expiry_must_be_in_the_future" } }];
    const out = await runSelfSignup(REQ, NOW);
    expect(out).toEqual({ kind: "failed", reason: "tenant creation refused: 400 expiry_must_be_in_the_future" });
    expect(H.creations).toHaveLength(1);
  });

  it("the organization exists but its plan did not set up: still marked, still recorded, reported as incomplete", async () => {
    H.creationResults = [{ status: 502, body: { error: "billing" }, created: { tenantId: "t_half", adminUserId: "u_half" } }];
    expect(await runSelfSignup(REQ, NOW)).toEqual({ kind: "created_incomplete", tenantId: "t_half" });
    expect(H.durable[0].tenantId).toBe("t_half");
    expect(H.consents.map((r) => r.tenantId)).toEqual(["t_half", "t_half"]);
  });

  it("the identity provider is down: a logged failure, never a rejection", async () => {
    H.creationResults = [new Error("authentik 503")];
    await expect(runSelfSignup(REQ, NOW)).resolves.toEqual({ kind: "failed", reason: "authentik 503" });
    expect(H.durable).toEqual([]);
  });

  it("the mark could not be written: the acceptance is still recorded and the sign-up stands", async () => {
    H.durableFails = true;
    expect(await runSelfSignup(REQ, NOW)).toEqual({ kind: "created", tenantId: "t_new" });
    expect(H.consents).toHaveLength(2);
  });

  it("the acceptance could not be recorded: the mark is written and the sign-up stands", async () => {
    H.consentFails = true;
    expect(await runSelfSignup(REQ, NOW)).toEqual({ kind: "created", tenantId: "t_new" });
    expect(H.durable).toHaveLength(1);
    expect(H.audits).toEqual([]);
  });

  it("the person is looked up by the exact address the form was read to", async () => {
    await runSelfSignup(REQ, NOW);
    expect(H.calls).toContain('identity:{"email":"dana@acme.co.il"}');
  });
});

describe("sign-up is closed", () => {
  it("closed between the route's check and the work: nothing happens, nobody is looked up", async () => {
    H.state = { ...H.state, enabled: false, open: false };
    expect(await runSelfSignup(REQ, NOW)).toEqual({ kind: "closed" });
    expect(H.calls).toEqual(["state"]);
    nothingCreated(); noMail();
  });

  it("the env switch off reads the same", async () => {
    H.state = { ...H.state, envEnabled: false, open: false };
    expect(await runSelfSignup(REQ, NOW)).toEqual({ kind: "closed" });
    nothingCreated();
  });

  it("settings that cannot be read: a failure, nothing created", async () => {
    H.stateFails = true;
    await expect(runSelfSignup(REQ, NOW)).resolves.toEqual({ kind: "failed", reason: "settings unreadable" });
    nothingCreated(); noMail();
  });
});

describe("an address that already has an account: never a second organization", () => {
  beforeEach(() => {
    H.identity = { id: "idn_1", authentikSubject: "sub-1" };
    H.member = { id: "u_old", tenantId: "t_old" };
  });

  it("someone who has signed in gets the sign-in hint, in the form's language", async () => {
    H.lastLogin = new Date("2026-10-01T08:00:00Z");
    expect(await runSelfSignup(REQ, NOW)).toEqual({ kind: "existing_sign_in_hint" });
    expect(H.hints).toEqual([["dana@acme.co.il", "he", "t_old"]]);
    expect(H.setupLinks).toEqual([]);
    nothingCreated();
  });

  it("the hint goes in English when the form was English", async () => {
    H.lastLogin = new Date("2026-10-01T08:00:00Z");
    await runSelfSignup({ ...REQ, locale: "en" }, NOW);
    expect(H.hints[0][1]).toBe("en");
  });

  it("someone invited who never set a password gets a fresh set-password link into that organization", async () => {
    H.lastLogin = null;
    expect(await runSelfSignup(REQ, NOW)).toEqual({ kind: "existing_setup_link" });
    expect(H.setupLinks).toEqual([["u_old"]]);
    expect(H.hints).toEqual([]);
    nothingCreated();
  });

  it("the organization is the oldest one the person is still active in", async () => {
    await runSelfSignup(REQ, NOW);
    expect(H.calls).toContain('member:{"where":{"identityId":"idn_1","isActive":true},"orderBy":{"createdAt":"asc"}}');
  });

  it("the last sign-in is asked of the provider's own record of this person", async () => {
    await runSelfSignup(REQ, NOW);
    expect(H.calls).toContain("authentik:sub-1");
    expect(H.calls).toContain("lastLogin:77");
  });

  it("never signed in and active nowhere: no email can be true, so none goes", async () => {
    H.member = null; H.lastLogin = null;
    expect(await runSelfSignup(REQ, NOW)).toEqual({ kind: "existing_no_mail" });
    noMail(); nothingCreated();
  });

  it("signed in but active nowhere: the hint still goes, logged under no organization", async () => {
    H.member = null; H.lastLogin = new Date("2026-10-01T08:00:00Z");
    expect(await runSelfSignup(REQ, NOW)).toEqual({ kind: "existing_sign_in_hint" });
    expect(H.hints).toEqual([["dana@acme.co.il", "he", null]]);
  });

  it("a person who can never sign in (no provider record): nothing", async () => {
    H.identity = { id: "idn_1", authentikSubject: null };
    expect(await runSelfSignup(REQ, NOW)).toEqual({ kind: "existing_no_mail" });
    expect(H.calls.some((c) => c.startsWith("authentik:"))).toBe(false);
    noMail(); nothingCreated();
  });

  it("the provider cannot be asked: reads as has signed in, the hint is harmless to both", async () => {
    H.authentikThrows = true; H.lastLogin = null;
    expect(await runSelfSignup(REQ, NOW)).toEqual({ kind: "existing_sign_in_hint" });
    expect(H.setupLinks).toEqual([]);
  });

  it("the provider does not know the person: the hint, never a set-password link", async () => {
    H.authentik = null; H.lastLogin = null;
    expect(await runSelfSignup(REQ, NOW)).toEqual({ kind: "existing_sign_in_hint" });
    expect(H.setupLinks).toEqual([]);
    expect(H.calls.some((c) => c.startsWith("lastLogin:"))).toBe(false);
  });

  it("the hint could not be sent: a logged failure, never a rejection, nothing created", async () => {
    H.lastLogin = new Date("2026-10-01T08:00:00Z"); H.hintFails = true;
    await expect(runSelfSignup(REQ, NOW)).resolves.toEqual({ kind: "failed", reason: "smtp down" });
    nothingCreated();
  });
});

describe("the same form sent twice at once", () => {
  it("opens one organization; the second is dropped", async () => {
    let release!: () => void;
    H.creationGate = new Promise<void>((r) => { release = r; });
    const first = runSelfSignup(REQ, NOW);
    const second = await runSelfSignup(REQ, NOW);
    expect(second).toEqual({ kind: "duplicate_in_flight" });
    release();
    expect(await first).toEqual({ kind: "created", tenantId: "t_new" });
    expect(H.creations).toHaveLength(1);
  });

  it("two different people at once are both served", async () => {
    let release!: () => void;
    H.creationGate = new Promise<void>((r) => { release = r; });
    const a = runSelfSignup(REQ, NOW);
    const b = runSelfSignup({ ...REQ, email: "omri@other.co.il" }, NOW);
    release();
    expect((await a).kind).toBe("created");
    expect((await b).kind).toBe("created");
    expect(H.creations.map((c) => c.adminEmail).sort()).toEqual(["dana@acme.co.il", "omri@other.co.il"]);
  });

  it("once the first is done the address is free again, after a success and after a failure", async () => {
    H.creationResults = [new Error("authentik 503")];
    expect((await runSelfSignup(REQ, NOW)).kind).toBe("failed");
    expect((await runSelfSignup(REQ, NOW)).kind).toBe("created");
    expect((await runSelfSignup(REQ, NOW)).kind).toBe("created");
    expect(H.creations).toHaveLength(3);
  });
});

describe("what the log may hold", () => {
  it("a failure is logged without the address: only its domain", async () => {
    H.creationResults = [{ status: 400, body: { code: "unknown_feature_domain" } }];
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runSelfSignup(REQ, NOW);
    const line = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(line).toContain("acme.co.il");
    expect(line).not.toContain("dana@");
    expect(line).not.toContain("Dana Katz");
  });
});
