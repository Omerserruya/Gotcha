import path from "path";
import type { Request, Response } from "express";
import { prisma } from "@chatcenter/shared";
// Deep imports: the pure rules, because this service's tests mock the barrel.
import { uploadServingHeaders } from "@chatcenter/shared/src/lib/upload-safety";
import { STORED_UPLOAD_NAME, mediaSignatureShapeOk, storedUploadName, verifyMediaSignature } from "@chatcenter/shared/src/lib/media-url";

/**
 * Serving a stored upload through a checked route instead of the public
 * /api/uploads (2026-10-10, uploads plan steps 2-3). Both routes answer a bare
 * 404 for every refusal, so a caller learns nothing about which check failed
 * or whether the message exists.
 */

const NO_STORE = "private, no-store";

export function mediaNotFound(res: Response): void {
  res.setHeader("Cache-Control", NO_STORE);
  res.sendStatus(404);
}

/**
 * Send <dir>/<storedName>. Range (206) and ETag come from res.sendFile; every
 * response is private, no-store (Cloudflare cached /api/uploads), nosniff,
 * sandboxed, and an attachment unless the extension may render inline.
 */
export function serveStoredUpload(res: Response, dir: string, storedName: string): void {
  if (!STORED_UPLOAD_NAME.test(storedName)) return mediaNotFound(res);
  res.sendFile(storedName, {
    root: dir,
    dotfiles: "deny",
    cacheControl: false,
    headers: { "Cache-Control": NO_STORE, ...uploadServingHeaders(path.extname(storedName)) },
  }, (err) => {
    if (err && !res.headersSent) mediaNotFound(res);
  });
}

/**
 * GET /api/media/s/:messageId?exp=&sig= for a provider that fetches with no
 * login (Meta, Slack). Mounted before any auth. The tenant is the message
 * row's own, so a signature for one tenant can never open another's file.
 */
export function signedMediaHandler(dir: string) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const messageId = String(req.params.messageId ?? "");
      const { exp, sig } = req.query;
      // Garbage and expired links never reach the database.
      if (!messageId || !mediaSignatureShapeOk({ exp, sig })) return mediaNotFound(res);
      // By primary key: the one lookup the tenant guard allows without a
      // tenant, which is exactly what is unknown until the row is read.
      const message = await prisma.message.findUnique({
        where: { id: messageId },
        select: { tenantId: true, mediaUrl: true },
      });
      if (!message || !verifyMediaSignature({ messageId, tenantId: message.tenantId, exp, sig })) return mediaNotFound(res);
      const name = storedUploadName(message.mediaUrl);
      if (!name) return mediaNotFound(res);
      serveStoredUpload(res, dir, name);
    } catch {
      mediaNotFound(res);
    }
  };
}
