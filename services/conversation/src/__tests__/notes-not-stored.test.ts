/**
 * A stub must not answer successfully.
 *
 * `GET/POST /api/conversations/:id/notes` were demo stubs: the POST returned
 * 200 with `{ id, text, createdAt }` for a note it never wrote, so a client
 * rendered it as saved and nothing anywhere recorded the loss. The GET's
 * `{ data: [] }` had the same defect one level down - "no notes" and "notes
 * are not kept here" are different facts, and an empty array reads as the
 * first.
 *
 * ── Why 501 and not 404 ──
 *
 * Conversation notes DO work, in another service: `POST /api/crm/conversation/
 * :id/notes` writes to the merchant's CRM and they are read back as
 * `recent_crm_notes`. A 404 would hide that. The 501 names the endpoint so the
 * next person links a CRM instead of building a second note store here.
 *
 * Nothing in the repo calls this path (checked: the frontend's note box calls
 * the CRM one), so this is a trap being closed, not a client being fixed. It
 * is reachable through both gateways, including `/t/:tenant/api/conversations`.
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("@chatcenter/shared", () => ({
  prisma: {},
  authenticate: (req: any, _res: any, next: any) => { req.user = { userId: "u1", role: "AGENT" }; next(); },
  resolveTenant: (req: any, _res: any, next: any) => { req.tenantId = "t1"; next(); },
  requireActiveTenant: () => (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
  latestHandover: async () => null,
}));

// The notes handlers touch no service, and mocking it keeps this suite from
// dragging in the whole conversation domain to assert on two refusals.
vi.mock("../services/conversation.service", () => ({}));

import conversationsRouter from "../routes/conversations";

const app = express();
app.use(express.json());
app.use("/api/conversations", conversationsRouter);

describe("conversation notes are refused, not echoed", () => {
  it("★ POST does not answer 200 with a note it never stored", async () => {
    const res = await request(app)
      .post("/api/conversations/c1/notes")
      .send({ text: "Customer asked for a refund on the blue one" });

    // This is the whole defect. A 2xx here means a UI shows the note as added.
    expect(res.status).toBe(501);
    expect(res.body.error).toBe("notes_not_stored_here");
  });

  it("★ POST does not echo the submitted text back in any form", async () => {
    const text = "Customer asked for a refund on the blue one";

    const res = await request(app).post("/api/conversations/c1/notes").send({ text });

    // Echoing it is what made the old response look like a saved record. The
    // serialised body must not contain the note, an id, or a timestamp.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(text);
    expect(res.body.data).toBeUndefined();
    expect(res.body.id).toBeUndefined();
    expect(res.body.createdAt).toBeUndefined();
  });

  it("★ GET does not answer an empty list, which reads as 'no notes'", async () => {
    const res = await request(app).get("/api/conversations/c1/notes");

    expect(res.status).toBe(501);
    expect(res.body.error).toBe("notes_not_stored_here");
    // `{ data: [] }` is indistinguishable from a conversation that genuinely
    // has none, which is the absent-versus-empty confusion.
    expect(res.body.data).toBeUndefined();
  });

  it("names where notes actually live, so nobody rebuilds them here", async () => {
    const res = await request(app).get("/api/conversations/c1/notes");

    // A bare 501 leaves the reader believing notes are unimplemented platform-
    // wide. They are not: they are written to the CRM.
    expect(res.body.message).toContain("/api/crm/conversation/:id/notes");
    expect(res.body.message).toContain("recent_crm_notes");
  });

  it("refuses without reading the body at all", async () => {
    // A 501 that still parsed the note would invite a caller to think some of
    // it was used. An empty POST gets the same refusal as a full one.
    const empty = await request(app).post("/api/conversations/c1/notes").send({});
    const full = await request(app).post("/api/conversations/c1/notes").send({ text: "x" });

    expect(empty.status).toBe(501);
    expect(empty.body).toEqual(full.body);
  });
});
