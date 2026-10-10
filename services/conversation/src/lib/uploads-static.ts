import path from "path";
import express from "express";
// Deep import: the pure rule, because this service's tests mock the barrel.
import { uploadServingHeaders } from "@chatcenter/shared/src/lib/upload-safety";

/**
 * /api/uploads, served with nosniff and a sandbox policy on every file, and
 * as an attachment unless it is an image, audio or video (2026-10-09: a
 * customer's "x.html" was served as a page on the app's own domain).
 */
export function uploadsStatic(dir: string) {
  return express.static(dir, {
    setHeaders(res, filePath) {
      for (const [k, v] of Object.entries(uploadServingHeaders(path.extname(filePath)))) res.setHeader(k, v);
    },
  });
}
