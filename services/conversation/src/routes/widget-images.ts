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
import { authenticate, resolveTenant, requireActiveTenant, requirePermission, requireInternalKey } from "@chatcenter/shared";
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

        res.status(201).json({ data: store(dir, req.tenantId!, slot, source, bytes, checked.facts) });
      } catch (err) {
        console.error("[widget-image] failed:", (err as Error)?.message);
        res.status(500).json({ error: "Could not store the image" });
      }
    },
  );
  /**
   * POST /widget-image/internal - the same check and the same storage, for a
   * server-side copy: the onboarding scan's widget fill (2026-11-11). The
   * merchant route above keeps its paid-product gate; a tenant still in
   * onboarding has its widget designed by the scan, which copies the chosen
   * images through here. Internal key only, never routed for the public: the
   * gateway sends /api/uploads to this service, so the key is the gate.
   * The tenant is named explicitly (x-tenant-id) and logged with the file.
   */
  router.post("/widget-image/internal", requireInternalKey, async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.headers["x-tenant-id"] || "");
      if (!/^[a-z0-9]{10,40}$/i.test(tenantId)) { res.status(400).json({ error: "x-tenant-id is required", code: "TENANT_REQUIRED" }); return; }
      if (!String(req.headers["content-type"] || "").includes("multipart/form-data")) { res.status(400).json({ error: "multipart/form-data is required", code: "MULTIPART_REQUIRED" }); return; }
      const read = await readMultipart(req, WIDGET_IMAGE_MAX_BYTES);
      const slot = read.slot;
      if (!isWidgetImageSlot(slot)) { res.status(400).json({ error: "slot must be logo or cover", code: "SLOT_INVALID" }); return; }
      if (read.truncated) { tooLarge(res, slot); return; }
      const bytes = read.file;
      if (!bytes || !bytes.length) { res.status(400).json({ error: "No file uploaded", code: "NO_FILE" }); return; }
      const checked = checkWidgetImage(bytes, slot);
      if (!checked.ok) { const { ok: _ok, ...why } = checked; res.status(422).json({ error: "The image was refused", ...why, slot }); return; }
      res.status(201).json({ data: store(dir, tenantId, slot, "internal", bytes, checked.facts) });
    } catch (err) {
      console.error("[widget-image] internal failed:", (err as Error)?.message);
      res.status(500).json({ error: "Could not store the image" });
    }
  });
  return router;
}

/** One checked image, stored under a random name; the same for every way in. */
function store(dir: string, tenantId: string, slot: WidgetImageSlot, source: string, bytes: Buffer, facts: { type: keyof typeof WIDGET_IMAGE_EXTENSION; width: number; height: number }) {
  const name = `${crypto.randomUUID()}${WIDGET_IMAGE_EXTENSION[facts.type]}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), bytes);
  const url = `${publicBase()}/api/uploads/${WIDGET_IMAGE_DIR}/${name}`;
  console.log(`[widget-image] tenant ${tenantId} ${slot} ${source} ${facts.type} ${facts.width}x${facts.height} ${bytes.length}B -> ${name}`);
  return { url, slot, type: facts.type, width: facts.width, height: facts.height, bytes: bytes.length };
}

function tooLarge(res: Response, slot: WidgetImageSlot) {
  res.status(422).json({ error: "The image file is too large", code: "IMAGE_TOO_LARGE", maxBytes: WIDGET_IMAGE_LIMITS[slot].maxBytes, slot });
}
