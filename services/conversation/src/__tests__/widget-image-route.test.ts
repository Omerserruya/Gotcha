/**
 * ★ POST /api/uploads/widget-image (W3/W4), through the real route and the
 * real static serving behind it:
 *   - an upload or a link (a Drive share link becomes its direct download);
 *     the stored copy is served back from /api/uploads/widget/<random name>
 *     with the right type and nosniff
 *   - the bytes decide: SVG / HTML under an image name is refused, over the
 *     slot's bytes or size is refused with the limit, nothing is written
 *   - the permission to save the widget is needed
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";

const H = vi.hoisted(() => {
  const os = require("os"); const p = require("path"); const f = require("fs");
  return { dir: f.mkdtempSync(p.join(os.tmpdir(), "wimg-")), perms: ["channels:manage:update"] as string[], fetched: [] as any[], fetchResult: null as any };
});

vi.mock("@chatcenter/shared", () => ({
  authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1" }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
  requirePermission: (p: string) => (_q: any, res: any, n: any) => (H.perms.includes(p) ? n() : res.status(403).json({ error: "forbidden" })),
}));
vi.mock("@chatcenter/shared/src/lib/safe-fetch", () => ({
  safeFetchBuffer: async (url: string, opts: any) => { H.fetched.push({ url, opts }); return H.fetchResult; },
}));

import { widgetImagesRouter } from "../routes/widget-images";
import { uploadsStatic } from "../lib/uploads-static";

const FX = path.resolve(__dirname, "../../../../packages/shared/src/lib/__tests__/fixtures/widget-image");
const png = fs.readFileSync(path.join(FX, "p-320x180.png"));
const webp = fs.readFileSync(path.join(FX, "w-322x182-lossy.webp"));
const gif = (w: number, h: number) => { const b = Buffer.alloc(13); b.write("GIF89a", 0, "latin1"); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b; };

const app = express();
app.use(express.json());
app.use("/api/uploads", widgetImagesRouter(H.dir));
app.use("/api/uploads", uploadsStatic(H.dir));
const upload = (slot: string, buf: Buffer, name = "logo.png") =>
  request(app).post("/api/uploads/widget-image").field("slot", slot).attach("file", buf, { filename: name, contentType: "image/png" });
const byLink = (body: any) => request(app).post("/api/uploads/widget-image").send(body);
const stored = () => (fs.existsSync(path.join(H.dir, "widget")) ? fs.readdirSync(path.join(H.dir, "widget")) : []);

beforeEach(() => {
  process.env.PUBLIC_URL = "https://dev.gotcha.co.il/";
  H.perms = ["channels:manage:update"]; H.fetched = []; H.fetchResult = null;
  fs.rmSync(path.join(H.dir, "widget"), { recursive: true, force: true });
});
afterAll(() => { fs.rmSync(H.dir, { recursive: true, force: true }); });

describe("★ an upload", () => {
  it("stored under a random name by its real type, served back as that image", async () => {
    const r = await upload("logo", png, "my logo.exe");
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ slot: "logo", type: "png", width: 320, height: 180, bytes: png.length });
    expect(r.body.data.url).toMatch(/^https:\/\/dev\.gotcha\.co\.il\/api\/uploads\/widget\/[0-9a-f-]{36}\.png$/);
    const served = await request(app).get(new URL(r.body.data.url).pathname).buffer(true);
    expect(served.status).toBe(200);
    expect(served.headers["content-type"]).toBe("image/png");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.compare(served.body, png)).toBe(0);
  });

  it("★ the bytes decide: SVG or HTML named .png is refused and nothing is written", async () => {
    for (const bad of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), Buffer.from("<!doctype html><p>hi")]) {
      const r = await upload("logo", bad);
      expect(r.status).toBe(422);
      expect(r.body.code).toBe("NOT_AN_IMAGE");
    }
    expect(stored()).toEqual([]);
  });

  it("★ the slot's limits, with the limit in the answer", async () => {
    let r = await upload("logo", gif(1500, 200));
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: "IMAGE_DIMENSIONS_TOO_LARGE", maxWidth: 1024, maxHeight: 1024, width: 1500, slot: "logo" });
    expect((await upload("cover", gif(1500, 200))).status).toBe(201);
    // Over the logo's bytes, within the cover's.
    const heavy = Buffer.concat([png, Buffer.alloc(1024 * 1024)]);
    r = await upload("logo", heavy);
    expect(r.body).toMatchObject({ code: "IMAGE_TOO_LARGE", maxBytes: 1048576 });
    expect((await upload("cover", heavy)).status).toBe(201);
    // Over every slot: cut off while reading.
    r = await upload("cover", Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)]));
    expect(r.body).toMatchObject({ code: "IMAGE_TOO_LARGE", maxBytes: 3145728 });
    expect(stored()).toHaveLength(2);
  });

  it("a bad slot or no file: 400; without the permission: 403", async () => {
    expect((await upload("banner", png)).body.code).toBe("SLOT_INVALID");
    expect((await request(app).post("/api/uploads/widget-image").field("slot", "logo")).body.code).toBe("NO_FILE");
    H.perms = [];
    expect((await upload("logo", png)).status).toBe(403);
    expect(stored()).toEqual([]);
  });
});

describe("★ a link", () => {
  it("a Drive share link is fetched as its direct download, capped at the slot's bytes, re-hosted", async () => {
    H.fetchResult = { ok: true, status: 200, buffer: webp };
    const r = await byLink({ slot: "cover", url: "https://drive.google.com/file/d/1AbC_dEf-GhIjKlMnOp/view?usp=sharing" });
    expect(r.status).toBe(201);
    expect(H.fetched).toEqual([{ url: "https://drive.google.com/uc?export=download&id=1AbC_dEf-GhIjKlMnOp", opts: { maxBytes: 3145728, timeoutMs: 15000 } }]);
    expect(r.body.data).toMatchObject({ type: "webp", width: 322, height: 182 });
    expect(r.body.data.url).toMatch(/\/api\/uploads\/widget\/[0-9a-f-]{36}\.webp$/);
  });

  it("a Drive file not shared (an HTML page) is refused, saying why", async () => {
    H.fetchResult = { ok: true, status: 200, buffer: Buffer.from("<!DOCTYPE html><title>Google Drive - Sign in</title>") };
    const r = await byLink({ slot: "logo", url: "https://drive.google.com/open?id=1AbC_dEf-GhIjKlMnOp" });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("NOT_AN_IMAGE");
    expect(r.body.error).toMatch(/shared with anyone who has the link/);
    expect(stored()).toEqual([]);
  });

  it("too large, unreachable / blocked, not https", async () => {
    H.fetchResult = { ok: false, status: 200, buffer: null, tooLarge: true };
    expect((await byLink({ slot: "logo", url: "https://cdn.example.com/a.png" })).body).toMatchObject({ code: "IMAGE_TOO_LARGE", maxBytes: 1048576 });
    expect(H.fetched.at(-1).opts.maxBytes).toBe(1048576);
    H.fetchResult = { ok: false, status: 0, buffer: null, error: "blocked address" };
    expect((await byLink({ slot: "logo", url: "https://cdn.example.com/a.png" })).body.code).toBe("FETCH_FAILED");
    const before = H.fetched.length;
    for (const url of ["http://cdn.example.com/a.png", "javascript:alert(1)", "", 42]) {
      expect((await byLink({ slot: "logo", url })).body.code).toBe("URL_INVALID");
    }
    expect(H.fetched.length).toBe(before);
  });
});
