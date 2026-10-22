import { describe, it, expect } from "vitest";
import { safeUploadExtension, uploadServingHeaders } from "../upload-safety";

/**
 * ★ A stored upload never keeps an extension a browser would run
 * (2026-10-09: a customer's "x.html" was served as a page on the app domain).
 */
describe("★ safeUploadExtension", () => {
  it("keeps an allowlisted extension, case-insensitively", () => {
    expect(safeUploadExtension(".JPG")).toBe(".jpg");
    expect(safeUploadExtension(".pdf")).toBe(".pdf");
    expect(safeUploadExtension(" .ogg ")).toBe(".ogg");
  });

  it("anything a browser could run is .bin", () => {
    for (const bad of [".html", ".htm", ".svg", ".xhtml", ".xml", ".js", ".mjs", ".exe", ".php"]) {
      expect(safeUploadExtension(bad), bad).toBe(".bin");
    }
  });

  it("the first non-empty candidate decides: a guessed one never overrides the sender's", () => {
    expect(safeUploadExtension(".html", ".pdf")).toBe(".bin");
    expect(safeUploadExtension("", undefined, ".png")).toBe(".png");
    expect(safeUploadExtension(null, "", "")).toBe(".bin");
  });
});

describe("★ uploadServingHeaders", () => {
  it("every upload: nosniff and a sandbox policy", () => {
    for (const ext of [".jpg", ".pdf", ".bin", ".html"]) {
      expect(uploadServingHeaders(ext)).toMatchObject({ "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox" });
    }
  });

  it("images, audio and video inline; documents and anything else download", () => {
    for (const ext of [".jpg", ".PNG", ".webp", ".ogg", ".mp3", ".mp4"]) {
      expect(uploadServingHeaders(ext)).not.toHaveProperty("Content-Disposition");
    }
    for (const ext of [".pdf", ".docx", ".bin", ".html", ".svg", ""]) {
      expect(uploadServingHeaders(ext)["Content-Disposition"], ext).toBe("attachment");
    }
  });
});
