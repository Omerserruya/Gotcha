/**
 * POST /api/ai-assist/onboarding-employee-chat through the real router: the
 * reply and the tuned persona (stored on the discovery row as tunedPersona)
 * leave with no wide dash, whatever the model wrote.
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const pass = (_q: any, _s: any, n: any) => n();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireRole: () => pass,
  };
});
vi.mock("../services/employee-tuning.service", () => ({
  tuneEmployeeChat: async () => ({
    reply: "שלום — אני מאיה",
    persona: { tone: "friendly", personality: "Warm – direct", instructions: ["Ask once ― then act"] },
  }),
}));

import router from "../routes/ai-assist";
const app = express();
app.use(express.json());
app.use("/api/ai-assist", router);

describe("onboarding employee chat", () => {
  it("★ no wide dash in the reply or the persona", async () => {
    const r = await request(app).post("/api/ai-assist/onboarding-employee-chat").send({ messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toMatch(/[–—―]/);
    expect(r.body.data).toMatchObject({ ok: true, reply: "שלום - אני מאיה", persona: { personality: "Warm - direct", instructions: ["Ask once - then act"] } });
  });
});
