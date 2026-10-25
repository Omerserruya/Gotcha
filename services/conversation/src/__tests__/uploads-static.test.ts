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

describe("★ widget images load on the merchant's site (2026-10-25)", () => {
  let wdir = "";
  const wapp = express();
  beforeAll(async () => {
    wdir = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-w-"));
    fs.mkdirSync(path.join(wdir, "widget"));
    for (const name of ["widget/hero.jpg", "widget/logo.PNG", "widget/x.html", "other.jpg"]) fs.writeFileSync(path.join(wdir, name), "x");
    fs.mkdirSync(path.join(wdir, "widget", "deep"));
    fs.writeFileSync(path.join(wdir, "widget", "deep", "y.jpg"), "x");
    // The real app runs helmet first, which sets same-origin on everything.
    const helmet = (await import("helmet")).default;
    wapp.use(helmet());
    wapp.use("/api/uploads", uploadsStatic(wdir));
  });
  afterAll(() => { fs.rmSync(wdir, { recursive: true, force: true }); });
  const wget = (name: string) => request(wapp).get(`/api/uploads/${name}`);

  it("a widget image is cross-origin, and keeps nosniff and the sandbox", async () => {
    for (const name of ["widget/hero.jpg", "widget/logo.PNG"]) {
      const r = await wget(name);
      expect(r.status, name).toBe(200);
      expect(r.headers["cross-origin-resource-policy"], name).toBe("cross-origin");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["content-security-policy"]).toBe("sandbox");
    }
  });

  it("every other upload stays same-origin: outside widget/, deeper in it, or not an image", async () => {
    for (const name of ["other.jpg", "widget/x.html", "widget/deep/y.jpg"]) {
      expect((await wget(name)).headers["cross-origin-resource-policy"], name).toBe("same-origin");
    }
  });

  it("★ a cache holding the old same-origin copy gets a full 200 with the new header, not a 304", async () => {
    const first = await wget("widget/hero.jpg");
    expect(first.headers.etag).toMatch(/-xo"$/);
    // The validator a cache stored before this change: express's default.
    const stat = fs.statSync(path.join(wdir, "widget/hero.jpg"));
    const old = `W/"${stat.size.toString(16)}-${stat.mtime.getTime().toString(16)}"`;
    const r = await request(wapp).get("/api/uploads/widget/hero.jpg").set("If-None-Match", old);
    expect(r.status).toBe(200);
    expect(r.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    // ...and its own validator still revalidates cheaply.
    expect((await request(wapp).get("/api/uploads/widget/hero.jpg").set("If-None-Match", first.headers.etag)).status).toBe(304);
  });

  it("the folder is the one the widget-image route writes to", () => {
    const src = fs.readFileSync(path.join(__dirname, "../routes/widget-images.ts"), "utf-8");
    expect(src).toContain('export const WIDGET_IMAGE_DIR = "widget";');
  });
});
