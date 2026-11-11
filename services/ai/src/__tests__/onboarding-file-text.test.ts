/**
 * POST /api/ai-assist/onboarding-file-text (2026-10-23): the text of one file
 * the owner gives when the site blocks reading. Type and size refused with a
 * code; an empty file is NOTHING_FOUND. No model is called here.
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    requireSystemAdmin: () => (_q: any, _r: any, next: any) => next(),
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "system", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireRole: () => (_q: any, _s: any, n: any) => n(),
  };
});

import router from "../routes/ai-assist";
const app = express();
app.use("/api/ai-assist", router);
const post = () => request(app).post("/api/ai-assist/onboarding-file-text");

describe("onboarding file text", () => {
  it("a text file: its text and name", async () => {
    const r = await post().attach("file", Buffer.from("Returns within 30 days."), { filename: "policy.txt", contentType: "text/plain" });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ filename: "policy.txt", text: "Returns within 30 days." });
  });
  it("markdown sent as octet-stream resolves by extension", async () => {
    const r = await post().attach("file", Buffer.from("# FAQ"), { filename: "faq.md", contentType: "application/octet-stream" });
    expect(r.status).toBe(200);
  });
  it("an image or an old .doc: 415 UNSUPPORTED_TYPE", async () => {
    for (const [name, type] of [["a.png", "image/png"], ["a.doc", "application/msword"]]) {
      const r = await post().attach("file", Buffer.from("x"), { filename: name, contentType: type });
      expect(r.status).toBe(415);
      expect(r.body.code).toBe("UNSUPPORTED_TYPE");
    }
  });
  it("over 5MB: 413 FILE_TOO_LARGE", async () => {
    const r = await post().attach("file", Buffer.alloc(5 * 1024 * 1024 + 1, 97), { filename: "a.txt", contentType: "text/plain" });
    expect(r.status).toBe(413);
    expect(r.body.code).toBe("FILE_TOO_LARGE");
  });
  it("an empty file: 422 NOTHING_FOUND; a broken PDF: 422 UNREADABLE_FILE; no file: 400", async () => {
    expect((await post().attach("file", Buffer.from("   "), { filename: "a.txt", contentType: "text/plain" })).body.code).toBe("NOTHING_FOUND");
    const pdf = await post().attach("file", Buffer.from("not a pdf"), { filename: "a.pdf", contentType: "application/pdf" });
    expect(pdf.status).toBe(422);
    expect(pdf.body.code).toBe("UNREADABLE_FILE");
    expect((await post().field("x", "y")).body.code).toBe("FILE_REQUIRED");
  });
});
