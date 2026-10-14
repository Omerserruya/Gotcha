/**
 * POST /api/uploads/widget-image - the widget's logo or cover (W3/W4, 2026-10-14).
 *
 * Two ways in, one way out:
 *   - multipart/form-data: `slot` ("logo" | "cover") and one `file`
 *   - application/json: { slot, url }: an https link (a Google Drive share
 *     link becomes its direct download), fetched by us with the public-address
 *     guard on every redirect and the slot's byte cap while reading
 * Either way the bytes are checked (type from the signature, size from the
 * header, SVG never) and stored under a random name in the public uploads
 * directory, so the merchant's site loads OUR copy, never a hotlink.
 *
 * Answers { url, slot, type, width, height, bytes }; the client saves `url`
 * through PUT /api/website-widget (logo: appearance.logoUrl, cover:
 * ux.hero.mediaUrl). Refusals are 422 with a code and the limit that was broken.
 *
 * Mounted at /api/uploads BEFORE the static files: the existing gateway route
 * already sends /api/uploads to this service, so nothing new is routed.
 */
import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { authenticate, resolveTenant, requireActiveTenant, requirePermission } from "@chatcenter/shared";
// Deep imports: the pure rules, because this service's tests mock the barrel.
import {
  WIDGET_IMAGE_LIMITS,
  WIDGET_IMAGE_MAX_BYTES,
  WIDGET_IMAGE_EXTENSION,
  isWidgetImageSlot,
  checkWidgetImage,
  driveDirectUrl,
  type WidgetImageSlot,
} from "@chatcenter/shared/src/lib/widget-image";
import { safeFetchBuffer } from "@chatcenter/shared/src/lib/safe-fetch";

export const WIDGET_IMAGE_DIR = "widget";

function publicBase(): string {
  return String(process.env.PUBLIC_URL || process.env.APP_PUBLIC_URL || "").replace(/\/+$/, "");
}

/** Read one file from a multipart body, never holding more than `max` + 1 bytes. */
async function readMultipart(req: Request, max: number): Promise<{ slot: string; file: Buffer | null; truncated: boolean }> {
  const busboy = (await import("busboy")).default;
  const bb = busboy({ headers: req.headers, limits: { fileSize: max, files: 1, fields: 4 } });
  let slot = "";
  let file: Buffer | null = null;
  let truncated = false;
  await new Promise<void>((resolve, reject) => {
    bb.on("file", (_name: string, stream: any) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("limit", () => { truncated = true; });
      stream.on("end", () => { file = Buffer.concat(chunks); });
    });
    bb.on("field", (name: string, val: string) => { if (name === "slot") slot = val; });
    bb.on("finish", resolve);
    bb.on("error", reject);
    req.pipe(bb);
  });
  return { slot, file, truncated };
}

export function widgetImagesRouter(uploadsDir: string) {
  const router = Router();
  const dir = path.join(uploadsDir, WIDGET_IMAGE_DIR);

  router.post(
    "/widget-image",
    authenticate,
    resolveTenant,
    requireActiveTenant(),
    // The same permission as saving the widget the image is for.
    requirePermission("channels:manage:update"),
    async (req: Request, res: Response) => {
      try {
        const contentType = String(req.headers["content-type"] || "");
        let slot: unknown;
        let bytes: Buffer | null = null;
        let source: "upload" | "url";

        if (contentType.includes("multipart/form-data")) {
          source = "upload";
          const read = await readMultipart(req, WIDGET_IMAGE_MAX_BYTES);
          slot = read.slot;
          if (!isWidgetImageSlot(slot)) { res.status(400).json({ error: "slot must be logo or cover", code: "SLOT_INVALID" }); return; }
          if (read.truncated) { tooLarge(res, slot); return; }
          bytes = read.file;
          if (!bytes || !bytes.length) { res.status(400).json({ error: "No file uploaded", code: "NO_FILE" }); return; }
        } else {
          source = "url";
          slot = (req.body as any)?.slot;
          if (!isWidgetImageSlot(slot)) { res.status(400).json({ error: "slot must be logo or cover", code: "SLOT_INVALID" }); return; }
          const raw = typeof (req.body as any)?.url === "string" ? (req.body as any).url.trim() : "";
          let link: URL | null = null;
          try { link = raw ? new URL(driveDirectUrl(raw)) : null; } catch { link = null; }
          if (!link || link.protocol !== "https:") { res.status(400).json({ error: "An https link is needed", code: "URL_INVALID" }); return; }
          const got = await safeFetchBuffer(link.toString(), { maxBytes: WIDGET_IMAGE_LIMITS[slot].maxBytes, timeoutMs: 15_000 });
          if (got.tooLarge) { tooLarge(res, slot); return; }
          if (!got.ok || !got.buffer) {
            res.status(422).json({ error: "The link could not be fetched", code: "FETCH_FAILED", status: got.status || null });
            return;
          }
          bytes = got.buffer;
        }

        const checked = checkWidgetImage(bytes, slot);
        if (!checked.ok) {
          const { ok: _ok, ...why } = checked;
          const error = why.code === "NOT_AN_IMAGE"
            ? source === "url"
              ? "The link is not a PNG, JPEG, GIF or WebP image (a Drive file must be shared with anyone who has the link)"
              : "The file is not a PNG, JPEG, GIF or WebP image"
            : why.code === "IMAGE_TOO_LARGE"
              ? "The image file is too large"
              : "The image is too large in width or height";
          res.status(422).json({ error, ...why, slot });
          return;
        }

        const name = `${crypto.randomUUID()}${WIDGET_IMAGE_EXTENSION[checked.facts.type]}`;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, name), bytes);
        const url = `${publicBase()}/api/uploads/${WIDGET_IMAGE_DIR}/${name}`;
        console.log(`[widget-image] tenant ${req.tenantId} ${slot} ${source} ${checked.facts.type} ${checked.facts.width}x${checked.facts.height} ${bytes.length}B -> ${name}`);
        res.status(201).json({ data: { url, slot, type: checked.facts.type, width: checked.facts.width, height: checked.facts.height, bytes: bytes.length } });
      } catch (err) {
        console.error("[widget-image] failed:", (err as Error)?.message);
        res.status(500).json({ error: "Could not store the image" });
      }
    },
  );
  return router;
}

function tooLarge(res: Response, slot: WidgetImageSlot) {
  res.status(422).json({ error: "The image file is too large", code: "IMAGE_TOO_LARGE", maxBytes: WIDGET_IMAGE_LIMITS[slot].maxBytes, slot });
}
