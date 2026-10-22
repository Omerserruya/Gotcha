/**
 * ★ The onboarding chat and the domain analysis (the grandfathered model
 * calls in auth) show no wide dash: the model writes them anyway, and the
 * owner reads the reply and the business description as is.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ content: "" }));
const DASHED = "Great\u2014let's set up \u2013 your team\u2015now";
const WIDE = /[\u2013\u2014\u2015]/;

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: async () => ({ choices: [{ message: { content: H.content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) } };
  },
}));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const none = { findUnique: async () => null, findFirst: async () => null, findMany: async () => [], create: async () => ({}), update: async () => ({}) };
  return {
    ...actual,
    authenticate: (req: any, _r: any, next: any) => { req.user = { userId: "u1", role: "ADMIN", tenantId: "T" }; next(); },
    resolveTenant: (req: any, _r: any, next: any) => { req.tenantId = "T"; next(); },
    requireRole: () => (_q: any, _r: any, next: any) => next(),
    trackAIUsage: async () => undefined,
    meterAiUnits: async () => undefined,
    safeFetch: async () => ({ ok: true, contentType: "text/html", text: "<html><body><h1>Lumiere lamps</h1><p>Handmade lamps for the home.</p></body></html>" }),
    prisma: new Proxy({}, {
      get: (_t, name: string) => name === "businessProfile"
        ? { ...none, findUnique: async () => ({ organizationName: "Lumiere", industry: "retail", businessDescription: "lamps" }) }
        : none,
    }),
  };
});

process.env.OPENAI_API_KEY = "test-key";
import onboardingRouter from "../routes/onboarding";

const app = () => { const a = express(); a.use(express.json()); a.use("/api/onboarding", onboardingRouter); return a; };

beforeEach(() => { H.content = ""; });

describe("★ no wide dash from the onboarding model calls", () => {
  it("the chat reply", async () => {
    H.content = JSON.stringify({ reply: DASHED, readyToGenerate: false });
    const r = await request(app()).post("/api/onboarding/ai-chat").send({ message: "hi", context: { locale: "en" } });
    expect(r.status).toBe(200);
    expect(r.body.data.reply).toBe("Great-let's set up - your team-now");
  });

  it("the business understanding from the domain", async () => {
    H.content = JSON.stringify({ name: "Lumiere\u2014Lamps", industry: "retail", country: "IL", language: "en", description: `We make lamps \u2014 by hand, for the home \u2013 since 2010.`, packSlug: "" });
    const r = await request(app()).post("/api/onboarding/analyze-domain").send({ domain: "lumiere.example" });
    expect(r.status).toBe(200);
    expect(r.body.data, JSON.stringify(r.body)).toMatchObject({ ok: true });
    expect(WIDE.test(JSON.stringify(r.body))).toBe(false);
    expect(r.body.data.understanding.name).toBe("Lumiere-Lamps");
  });
});
