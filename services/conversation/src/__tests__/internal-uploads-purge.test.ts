/**
 * The tenant delete's uploads purge: internal key only, stored names only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("@chatcenter/shared", () => ({
  requireInternalKey: (req: any, res: any, next: any) =>
    req.headers["x-internal-key"] === "k" ? next() : res.status(403).json({ error: "Forbidden" }),
}));

import { internalUploadsRouter } from "../routes/internal-uploads";

const A = "0f8fad5b-d9cb-469f-a165-70867728950e.jpg";
const B = "7c9e6679-7425-40de-944b-e07fc1f90ae7.pdf";
let dir: string;
let app: express.Express;

beforeEach(() => {
  // The uploads dir sits inside its own temp root, so "outside" is still ours.
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "purge-")), "uploads");
  fs.mkdirSync(dir);
  for (const f of [A, B, "keep.txt"]) fs.writeFileSync(path.join(dir, f), "x");
  fs.writeFileSync(path.join(path.dirname(dir), "outside-secret.txt"), "x");
  app = express();
  app.use(express.json());
  app.use(internalUploadsRouter(dir));
});

afterEach(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));

const purge = (files: unknown, key = "k") =>
  request(app).post("/internal/uploads/purge").set("x-internal-key", key).send({ files });

describe("POST /internal/uploads/purge", () => {
  it("removes stored files by name and counts the ones already gone", async () => {
    const r = await purge([A, B, "1b4e28ba-2fa1-11d2-883f-0016d3cca427.png"]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, removed: 2, missing: 1, rejected: [], failed: [] });
    expect(fs.readdirSync(dir)).toEqual(["keep.txt"]);
  });

  it("refuses anything that is not a stored name, and says the purge was not complete", async () => {
    const r = await purge(["../outside-secret.txt", "keep.txt", `${A}/..`, A]);
    expect(r.status).toBe(207);
    expect(r.body.ok).toBe(false);
    expect(r.body.rejected).toHaveLength(3);
    expect(fs.existsSync(path.join(path.dirname(dir), "outside-secret.txt"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "keep.txt"))).toBe(true);
  });

  it("a widget image in uploads/widget/ is a stored name too; no other folder, and never a way out of it", async () => {
    const W = "widget/3f2504e0-4f89-11d3-9a0c-0305e82c3301.png";
    fs.mkdirSync(path.join(dir, "widget"));
    fs.writeFileSync(path.join(dir, W), "x");
    fs.mkdirSync(path.join(dir, "other"));
    fs.writeFileSync(path.join(dir, "other", "3f2504e0-4f89-11d3-9a0c-0305e82c3301.png"), "x");
    const r = await purge([W, "other/3f2504e0-4f89-11d3-9a0c-0305e82c3301.png", "widget/../outside-secret.txt", "widget/widget/3f2504e0-4f89-11d3-9a0c-0305e82c3301.png"]);
    expect(r.body.removed).toBe(1);
    expect(r.body.rejected).toHaveLength(3);
    expect(fs.existsSync(path.join(dir, W))).toBe(false);
    expect(fs.existsSync(path.join(dir, "other", "3f2504e0-4f89-11d3-9a0c-0305e82c3301.png"))).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(dir), "outside-secret.txt"))).toBe(true);
  });

  it("is internal-key only", async () => {
    const r = await purge([A], "wrong");
    expect(r.status).toBe(403);
    expect(fs.existsSync(path.join(dir, A))).toBe(true);
  });

  it("rejects a body that is not a list", async () => {
    expect((await purge("x")).status).toBe(400);
  });
});
