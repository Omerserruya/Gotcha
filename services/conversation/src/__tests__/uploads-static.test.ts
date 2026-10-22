/**
 * ★ /api/uploads serves a customer's file without ever letting it run
 * (2026-10-09: "x.html" was served as a page on the app's own domain).
 *   - every file: nosniff and a sandbox policy
 *   - images, audio and video render inline; documents, .bin and anything a
 *     browser could run download as an attachment
 *   - a file stored before the fix under ".html" downloads too
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import { uploadsStatic } from "../lib/uploads-static";

let dir = "";
const app = express();

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-"));
  for (const name of ["a.jpg", "b.ogg", "c.pdf", "d.bin", "legacy.html", "e.svg"]) fs.writeFileSync(path.join(dir, name), "<script>alert(1)</script>");
  app.use("/api/uploads", uploadsStatic(dir));
});
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const get = (name: string) => request(app).get(`/api/uploads/${name}`);

describe("★ uploads are never run", () => {
  it("every file carries nosniff and a sandbox policy", async () => {
    for (const name of ["a.jpg", "c.pdf", "legacy.html"]) {
      const r = await get(name);
      expect(r.status, name).toBe(200);
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["content-security-policy"]).toBe("sandbox");
    }
  });

  it("images and audio inline", async () => {
    for (const name of ["a.jpg", "b.ogg"]) expect((await get(name)).headers["content-disposition"], name).toBeUndefined();
  });

  it("documents, .bin, and a stored .html or .svg download", async () => {
    for (const name of ["c.pdf", "d.bin", "legacy.html", "e.svg"]) {
      expect((await get(name)).headers["content-disposition"], name).toBe("attachment");
    }
  });
});
