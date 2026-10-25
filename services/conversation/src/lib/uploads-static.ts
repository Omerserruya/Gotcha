import path from "path";
import express from "express";
// Deep import: the pure rule, because this service's tests mock the barrel.
import { uploadServingHeaders } from "@chatcenter/shared/src/lib/upload-safety";

/**
 * /api/uploads, served with nosniff and a sandbox policy on every file, and
 * as an attachment unless it is an image, audio or video (2026-10-09: a
 * customer's "x.html" was served as a page on the app's own domain).
 *
 * Widget images (widget/, the header image and the logo) are drawn on the
 * merchant's own site, so they are served Cross-Origin-Resource-Policy:
 * cross-origin (2026-10-25: helmet's same-origin made Chromium block the
 * header image on every store, while the same-origin settings preview showed
 * it). Every other upload keeps same-origin.
 */
export function uploadsStatic(dir: string) {
  const root = path.resolve(dir);
  return express.static(dir, {
    setHeaders(res, filePath, stat) {
      for (const [k, v] of Object.entries(uploadServingHeaders(path.extname(filePath)))) res.setHeader(k, v);
      if (isWidgetImage(root, filePath)) {
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        // Its own validator: the edge revalidates a cached copy, and a 304 on
        // the old ETag kept the old same-origin header in its cache. `send`
        // keeps an ETag already set, so this one is what is compared.
        res.setHeader("ETag", `W/"${stat.size.toString(16)}-${stat.mtime.getTime().toString(16)}-xo"`);
      }
    },
  });
}

const WIDGET_IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);

/** A file directly under <uploads>/widget/ with an image extension. */
export function isWidgetImage(root: string, filePath: string): boolean {
  const rel = path.relative(root, path.resolve(filePath));
  const parts = rel.split(path.sep);
  return parts.length === 2 && parts[0] === "widget" && WIDGET_IMAGE_EXT.has(path.extname(parts[1]).toLowerCase());
}
