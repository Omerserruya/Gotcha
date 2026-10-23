import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { requireInternalKey } from "@chatcenter/shared";

/**
 * Remove stored uploads by name - the tenant delete's last step (auth's
 * eraseTenant), because this service owns the uploads volume and auth does not
 * mount it.
 *
 * Internal key only, and outside /api so the gateway never routes to it. Only
 * a stored name is accepted - a UUID plus a short extension, exactly what the
 * upload paths write - so no caller can reach outside the directory or name a
 * file that was not an upload.
 */
const STORED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/i;
const MAX_FILES = 50_000;

export function internalUploadsRouter(uploadsDir: string): Router {
  const router = Router();
  router.post("/internal/uploads/purge", requireInternalKey, (req: Request, res: Response) => {
    const files = (req.body as { files?: unknown })?.files;
    if (!Array.isArray(files) || files.length > MAX_FILES) {
      res.status(400).json({ error: "files must be an array of stored upload names" });
      return;
    }
    let removed = 0;
    let missing = 0;
    const rejected: string[] = [];
    const failed: string[] = [];
    for (const f of files) {
      if (typeof f !== "string" || !STORED_NAME.test(f)) {
        rejected.push(String(f).slice(0, 80));
        continue;
      }
      try {
        fs.unlinkSync(path.join(uploadsDir, f));
        removed++;
      } catch (err: any) {
        if (err?.code === "ENOENT") missing++;
        else failed.push(f);
      }
    }
    // Rejected or failed names mean the purge was not complete; say so.
    const ok = rejected.length === 0 && failed.length === 0;
    res.status(ok ? 200 : 207).json({ ok, removed, missing, rejected, failed });
  });
  return router;
}
