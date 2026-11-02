/**
 * The mobile app's phones, for push.
 *
 *   POST   /notifications/devices          { token, platform: "ios" | "android" }
 *   DELETE /notifications/devices/:token   (or DELETE /notifications/devices { token })
 *
 * A registration token names an app INSTALL, not a person. One phone can be
 * signed out and signed in as someone else (a shared shop phone, a teammate's
 * spare), and from then on its pushes must reach the new person only. So POST
 * upserts by token and re-points the row to whoever is calling, in whichever
 * tenant they are calling from: the previous owner silently stops receiving
 * there, which is exactly what signing out of the phone means.
 *
 * DELETE removes only the caller's own row. A token is not a secret worth
 * guessing, but "unregister someone else's phone" is still not a thing a
 * colleague may do, and it answers 204 either way so it says nothing about
 * whose token it was.
 *
 * Support mode is refused (support_denied:ownership, also in the shared deny
 * table): a GOTCHA admin acting as the workspace must never register their own
 * phone as the support actor and start receiving the workspace's customer
 * messages on it, nor remove a member's phone.
 */
import { Router, type Request, type Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant } from "@chatcenter/shared";

const router = Router();
router.use("/notifications/devices", authenticate, resolveTenant, requireActiveTenant());

const PLATFORMS = new Set(["ios", "android"]);
/** FCM tokens are ~150-250 chars; anything far outside that is not one. */
const MAX_TOKEN = 4096;

function caller(req: Request, res: Response): { userId: string; tenantId: string } | null {
  const u = req.user as any;
  if (u?.support) {
    res.status(403).json({ error: "Not available in support mode", code: "support_denied:ownership" });
    return null;
  }
  if (!u?.userId || u?.isInternal) {
    res.status(403).json({ error: "Devices are per-user" });
    return null;
  }
  return { userId: u.userId, tenantId: req.tenantId as string };
}

const tokenOf = (v: unknown): string | null =>
  typeof v === "string" && v.trim() && v.trim().length <= MAX_TOKEN ? v.trim() : null;

router.post("/notifications/devices", async (req: Request, res: Response) => {
  const me = caller(req, res);
  if (!me) return;
  const token = tokenOf(req.body?.token);
  const platform = typeof req.body?.platform === "string" ? req.body.platform.toLowerCase() : "";
  if (!token) {
    res.status(400).json({ error: "token is required" });
    return;
  }
  if (!PLATFORMS.has(platform)) {
    res.status(400).json({ error: "platform must be \"ios\" or \"android\"" });
    return;
  }
  try {
    const now = new Date();
    const row = await (prisma as any).pushDevice.upsert({
      where: { token },
      create: { token, platform, userId: me.userId, tenantId: me.tenantId, lastSeenAt: now },
      update: { platform, userId: me.userId, tenantId: me.tenantId, lastSeenAt: now },
      select: { id: true, platform: true, createdAt: true, lastSeenAt: true },
    });
    res.json({ data: row });
  } catch (err) {
    console.error("Register push device error:", err);
    res.status(500).json({ error: "Failed to register device" });
  }
});

async function remove(req: Request, res: Response, raw: unknown) {
  const me = caller(req, res);
  if (!me) return;
  const token = tokenOf(raw);
  if (!token) {
    res.status(400).json({ error: "token is required" });
    return;
  }
  try {
    await (prisma as any).pushDevice.deleteMany({ where: { token, userId: me.userId, tenantId: me.tenantId } });
    res.status(204).end();
  } catch (err) {
    console.error("Remove push device error:", err);
    res.status(500).json({ error: "Failed to remove device" });
  }
}

router.delete("/notifications/devices/:token", (req, res) => remove(req, res, req.params.token));
router.delete("/notifications/devices", (req, res) => remove(req, res, req.body?.token));

export default router;
