/**
 * ★ Widget images are judged by their bytes (W3/W4). The fixtures were made
 * by Chromium's own encoders (canvas.toDataURL) and their sizes confirmed by
 * Chromium's decoder, so the expected sizes do not come from this code. The
 * "-simple" WebPs are the same image chunk without the extended header.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { probeImage, checkWidgetImage, driveDirectUrl, WIDGET_IMAGE_LIMITS } from "../widget-image";

const fx = (n: string) => fs.readFileSync(path.join(__dirname, "fixtures/widget-image", n));

/** A minimal GIF89a header of the given size (the rest of the file is not read). */
const gif = (w: number, h: number) => { const b = Buffer.alloc(13); b.write("GIF89a", 0, "latin1"); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b; };

describe("★ type and size from the bytes", () => {
  it.each([
    ["p-320x180.png", "png", 320, 180],
    ["j-321x181.jpg", "jpeg", 321, 181],
    ["w-322x182-lossy.webp", "webp", 322, 182],
    ["w-323x183-lossless.webp", "webp", 323, 183],
    ["w-322x182-lossy-simple.webp", "webp", 322, 182],
    ["w-323x183-lossless-simple.webp", "webp", 323, 183],
  ])("%s", (name, type, width, height) => {
    expect(probeImage(fx(name))).toEqual({ type, width, height });
  });

  it("GIF; a progressive JPEG frame header (SOF2) too", () => {
    expect(probeImage(gif(566, 404))).toEqual({ type: "gif", width: 566, height: 404 });
    const j = Buffer.from(fx("j-321x181.jpg"));
    const sof = j.indexOf(Buffer.from([0xff, 0xc0]));
    j[sof + 1] = 0xc2;
    expect(probeImage(j)).toEqual({ type: "jpeg", width: 321, height: 181 });
  });

  it("whatever the name says: SVG, an HTML page (a Drive file not shared), junk, a cut-off file are not images", () => {
    expect(probeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>'))).toBeNull();
    expect(probeImage(Buffer.from("<!DOCTYPE html><html><head><title>Google Drive</title></head></html>"))).toBeNull();
    expect(probeImage(Buffer.from("not an image at all"))).toBeNull();
    expect(probeImage(fx("j-321x181.jpg").subarray(0, 20))).toBeNull();
    expect(probeImage(Buffer.alloc(0))).toBeNull();
  });
});

describe("★ the slot's limits", () => {
  it("within: the facts", () => {
    expect(checkWidgetImage(fx("p-320x180.png"), "logo")).toEqual({ ok: true, facts: { type: "png", width: 320, height: 180 } });
  });

  it("over the byte cap; over the size (with both numbers); not an image", () => {
    const big = Buffer.concat([fx("p-320x180.png"), Buffer.alloc(WIDGET_IMAGE_LIMITS.logo.maxBytes)]);
    expect(checkWidgetImage(big, "logo")).toEqual({ ok: false, code: "IMAGE_TOO_LARGE", maxBytes: 1048576 });
    expect(checkWidgetImage(big, "cover").ok).toBe(true);
    expect(checkWidgetImage(gif(1025, 10), "logo")).toEqual({ ok: false, code: "IMAGE_DIMENSIONS_TOO_LARGE", maxWidth: 1024, maxHeight: 1024, width: 1025, height: 10 });
    expect(checkWidgetImage(gif(2400, 1600), "cover").ok).toBe(true);
    expect(checkWidgetImage(gif(2400, 1601), "cover")).toMatchObject({ ok: false, code: "IMAGE_DIMENSIONS_TOO_LARGE" });
    expect(checkWidgetImage(Buffer.from("<svg/>"), "cover")).toEqual({ ok: false, code: "NOT_AN_IMAGE" });
  });
});

describe("Google Drive links", () => {
  it("share links become the direct download; anything else is unchanged", () => {
    const want = "https://drive.google.com/uc?export=download&id=1AbC_dEf-GhIjKlMnOp";
    expect(driveDirectUrl("https://drive.google.com/file/d/1AbC_dEf-GhIjKlMnOp/view?usp=sharing")).toBe(want);
    expect(driveDirectUrl("https://drive.google.com/open?id=1AbC_dEf-GhIjKlMnOp")).toBe(want);
    expect(driveDirectUrl("https://drive.google.com/uc?id=1AbC_dEf-GhIjKlMnOp&export=view")).toBe(want);
    for (const u of ["https://cdn.example.com/logo.png", "https://drive.google.com/drive/folders/1AbC_dEf-GhIjKlMnOp", "https://drive.google.com/file/d/x/view", "not a url"]) {
      expect(driveDirectUrl(u)).toBe(u);
    }
  });
});
