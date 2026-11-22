/**
 * The public sign-up door: GET /api/auth/signup/config, POST /api/auth/signup
 * (2026-11-22).
 *
 * What is pinned is the door, not the work behind it (self-signup-service
 * tests): shut unless both switches are on, one answer for every accepted
 * form and sent before the work, the two limits, the hidden field, and that
 * the compose files hand the switch to the auth service, off by default.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  settings: { enabled: true, trialDays: 14, cardRequiredAfterDays: 10, trialCredits: 5000 } as any,
  stateFails: false,
  stateReads: 0,
  runs: [] as any[],
  run: null as null | (() => Promise<any>),
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    selfSignupState: async () => {
      H.stateReads++;
      if (H.stateFails) throw new Error("db down");
      const envEnabled = actual.selfSignupEnvEnabled();
      return { ...H.settings, envEnabled, open: envEnabled && H.settings.enabled };
    },
  };
});

vi.mock("../services/self-signup.service", () => ({
  runSelfSignup: (req: any) => {
    H.runs.push(req);
    return H.run ? H.run() : Promise.resolve({ kind: "created", tenantId: "t" });
  },
}));

import { buildSignupRouter, SIGNUP_PER_IP_PER_HOUR, SIGNUP_PER_EMAIL_PER_DAY } from "../routes/signup";

const FORM = {
  name: "Noa Levi",
  email: "noa@cafe-noga.co.il",
  businessName: "Cafe Noga",
  locale: "he",
  terms: true,
  privacy: true,
  capturedText: "I accept",
};
const ENV = process.env.SELF_SIGNUP;

let app: express.Express;
/** One form from one visitor address. */
const post = (body: any, ip = "198.51.100.1") =>
  request(app).post("/api/auth/signup").set("X-Forwarded-For", ip).set("User-Agent", "TestBrowser/1.0").send(body);

beforeEach(() => {
  H.settings = { enabled: true, trialDays: 14, cardRequiredAfterDays: 10, trialCredits: 5000 };
  H.stateFails = false; H.stateReads = 0; H.runs = []; H.run = null;
  process.env.SELF_SIGNUP = "on";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  // A fresh router each test: its counters start at zero.
  app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/api/auth/signup", buildSignupRouter());
});
afterEach(() => {
  if (ENV === undefined) delete process.env.SELF_SIGNUP; else process.env.SELF_SIGNUP = ENV;
});

describe("GET /api/auth/signup/config", () => {
  it("open: what the page may promise, and nothing more (no credits)", async () => {
    const r = await request(app).get("/api/auth/signup/config");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: true, trialDays: 14, cardRequiredAfterDays: 10 });
  });

  it("the console setting off: closed", async () => {
    H.settings.enabled = false;
    expect((await request(app).get("/api/auth/signup/config")).body).toEqual({ enabled: false, trialDays: 14, cardRequiredAfterDays: 10 });
  });

  it.each([["off"], [""], ["true"], ["1"], [undefined]])("the env switch as %j: closed, whatever the console says", async (v) => {
    if (v === undefined) delete process.env.SELF_SIGNUP; else process.env.SELF_SIGNUP = v;
    expect((await request(app).get("/api/auth/signup/config")).body.enabled).toBe(false);
  });

  it("settings that cannot be read: closed with the defaults, still a 200 the page can render", async () => {
    H.stateFails = true;
    const r = await request(app).get("/api/auth/signup/config");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: false, trialDays: 14, cardRequiredAfterDays: 14 });
  });
});

describe("POST /api/auth/signup: the door", () => {
  it.each([["off"], [""], ["true"], [undefined]])("env switch %j: 404, and not even the settings are read", async (v) => {
    if (v === undefined) delete process.env.SELF_SIGNUP; else process.env.SELF_SIGNUP = v;
    const r = await post(FORM);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "signup_disabled" });
    expect(H.stateReads).toBe(0);
    expect(H.runs).toEqual([]);
  });

  it("the console setting off: 404, nothing runs", async () => {
    H.settings.enabled = false;
    const r = await post(FORM);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "signup_disabled" });
    expect(H.runs).toEqual([]);
  });

  it("settings that cannot be read: shut, never open by accident", async () => {
    H.stateFails = true;
    const r = await post(FORM);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "signup_disabled" });
    expect(H.runs).toEqual([]);
  });

  it("a closed door answers 404 to a bad form too: closed is said before anything is judged", async () => {
    H.settings.enabled = false;
    expect((await post({})).status).toBe(404);
  });
});

describe("POST /api/auth/signup: an accepted form", () => {
  it("answers 202 { ok: true } and hands the read form on, with the visitor's address and browser", async () => {
    const r = await post({ ...FORM, email: " Noa@Cafe-Noga.co.il " }, "203.0.113.50");
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ ok: true });
    expect(H.runs).toEqual([
      {
        name: "Noa Levi",
        email: "noa@cafe-noga.co.il",
        businessName: "Cafe Noga",
        locale: "he",
        capturedText: "I accept",
        ip: "203.0.113.50",
        userAgent: "TestBrowser/1.0",
      },
    ]);
  });

  it("answers before the work is done: work that never ends does not hold the answer", async () => {
    H.run = () => new Promise(() => undefined);
    const r = await post(FORM);
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ ok: true });
    expect(H.runs).toHaveLength(1);
  });

  it("the answer is the same whatever the work found", async () => {
    const answers: any[] = [];
    for (const [i, kind] of ["created", "existing_sign_in_hint", "existing_no_mail", "failed"].entries()) {
      H.run = () => Promise.resolve({ kind });
      const r = await post({ ...FORM, email: `p${i}@cafe-noga.co.il` });
      answers.push([r.status, r.body]);
    }
    expect(answers).toEqual(Array(4).fill([202, { ok: true }]));
  });

  it("the hidden field filled: the same 202, and nothing runs", async () => {
    const r = await post({ ...FORM, website: "https://spam.example" });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ ok: true });
    expect(H.runs).toEqual([]);
  });

  it("the hidden field filled on a broken form: still 202, no validation to learn from", async () => {
    const r = await post({ website: "x" });
    expect(r.status).toBe(202);
    expect(H.runs).toEqual([]);
  });
});

describe("POST /api/auth/signup: a refused form", () => {
  it("names the fields and runs nothing", async () => {
    const r = await post({ ...FORM, email: "noa", terms: false });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "validation", fields: { email: "invalid", terms: "required" } });
    expect(H.runs).toEqual([]);
  });

  it("no body at all", async () => {
    const r = await request(app).post("/api/auth/signup").set("X-Forwarded-For", "198.51.100.1");
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("validation");
  });
});

describe("POST /api/auth/signup: the limits", () => {
  it("one email address: three forms a day, whoever sends them and however it is typed", async () => {
    expect(SIGNUP_PER_EMAIL_PER_DAY).toBe(3);
    expect((await post(FORM, "198.51.100.1")).status).toBe(202);
    expect((await post({ ...FORM, email: "NOA@cafe-noga.co.il" }, "198.51.100.2")).status).toBe(202);
    expect((await post({ ...FORM, email: " noa@CAFE-NOGA.co.il" }, "198.51.100.3")).status).toBe(202);
    const r = await post(FORM, "198.51.100.4");
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: "rate_limited" });
    expect(H.runs).toHaveLength(3);
    // Another address is not held back by this one.
    expect((await post({ ...FORM, email: "dan@cafe-noga.co.il" }, "198.51.100.4")).status).toBe(202);
  });

  it("one visitor address: five forms an hour, whatever emails they name", async () => {
    expect(SIGNUP_PER_IP_PER_HOUR).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect((await post({ ...FORM, email: `p${i}@cafe-noga.co.il` }, "203.0.113.7")).status).toBe(202);
    }
    const r = await post({ ...FORM, email: "p5@cafe-noga.co.il" }, "203.0.113.7");
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: "rate_limited" });
    expect(H.runs).toHaveLength(5);
    // Another visitor is not held back by this one.
    expect((await post({ ...FORM, email: "p6@cafe-noga.co.il" }, "203.0.113.8")).status).toBe(202);
  });

  it("a form sent back for a typo does not cost the visitor a try", async () => {
    for (let i = 0; i < 8; i++) expect((await post({ ...FORM, email: "noa" }, "203.0.113.7")).status).toBe(400);
    for (let i = 0; i < 5; i++) {
      expect((await post({ ...FORM, email: `p${i}@cafe-noga.co.il` }, "203.0.113.7")).status).toBe(202);
    }
    expect((await post({ ...FORM, email: "p5@cafe-noga.co.il" }, "203.0.113.7")).status).toBe(429);
  });

  it("a bot's forms (hidden field filled) do count against its address", async () => {
    for (let i = 0; i < 5; i++) expect((await post({ ...FORM, website: "x" }, "203.0.113.7")).status).toBe(202);
    expect((await post(FORM, "203.0.113.7")).status).toBe(429);
    expect(H.runs).toEqual([]);
  });

  it("a refused form does not count against the email it names", async () => {
    for (let i = 0; i < 6; i++) await post({ ...FORM, terms: false }, `198.51.100.${10 + i}`);
    expect((await post(FORM, "198.51.100.99")).status).toBe(202);
  });
});

describe("the deployment hands the switch to the auth service, off by default", () => {
  const authBlock = (file: string): string => {
    const text = readFileSync(join(__dirname, "../../../..", file), "utf8");
    const start = text.indexOf("\n  auth:\n");
    expect(start).toBeGreaterThan(-1);
    const rest = text.slice(start + 1);
    const next = rest.slice(8).search(/\n  [a-z][a-z0-9-]*:\n/);
    return next === -1 ? rest : rest.slice(0, next + 8);
  };

  it.each([["docker-compose.yml"], ["docker-compose.prod.yml"]])("%s", (file) => {
    expect(authBlock(file)).toContain("      SELF_SIGNUP: ${SELF_SIGNUP:-off}\n");
    const whole = readFileSync(join(__dirname, "../../../..", file), "utf8");
    // Once, and only there: no other service reads it.
    expect(whole.split("\n").filter((l) => l.trim().startsWith("SELF_SIGNUP:"))).toHaveLength(1);
  });
});
