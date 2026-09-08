/**
 * A person's own notification settings.
 *
 *   GET   /notification-preferences/me
 *   PATCH /notification-preferences/me
 *
 * Deliberately a SEPARATE row from NotificationPreference, which is tenant-admin
 * ROUTING - which events go to whom, scoped by department, with conditions and
 * recipient rules. That is the organisation's decision. This is the person's:
 * which channels reach me, and when not to. An admin editing a routing rule
 * must not silently erase somebody's quiet hours, and the only way to guarantee
 * that is for the two never to share a row.
 *
 * Every field has a defensible default, so a user who has never opened this
 * page has preferences rather than nulls - see DEFAULTS below.
 */
import { Router, type Request, type Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant } from "@chatcenter/shared";

const router = Router();
router.use("/notification-preferences/me", authenticate, resolveTenant, requireActiveTenant());

/**
 * What someone gets before they have chosen anything.
 *
 * `whatsapp` is the one that is off: it costs money to send and it arrives on a
 * personal phone, and neither is something to opt somebody into on their
 * behalf. `approvals` is the one that is on and stays opt-OUT by default - an
 * action waiting on you is the single notification whose default cannot be
 * silence.
 */
const DEFAULTS = {
  inApp: true,
  email: true,
  whatsapp: false,
  approvals: true,
  quietHoursFrom: null as string | null,
  quietHoursTo: null as string | null,
};

/** "HH:MM", 24-hour. Anything else is rejected rather than coerced. */
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function shape(row: Record<string, unknown> | null) {
  const r = { ...DEFAULTS, ...(row ?? {}) } as typeof DEFAULTS;
  return {
    inApp: r.inApp,
    email: r.email,
    whatsapp: r.whatsapp,
    approvals: r.approvals,
    // A window needs both ends to mean anything, so it is one nullable object
    // rather than two independent fields the client has to correlate.
    quietHours:
      r.quietHoursFrom && r.quietHoursTo ? { from: r.quietHoursFrom, to: r.quietHoursTo } : null,
  };
}

function currentUser(req: Request): { userId: string; tenantId: string } | null {
  const userId = (req.user as any)?.userId as string | undefined;
  if (!userId || (req.user as any)?.isInternal) return null;
  return { userId, tenantId: req.tenantId as string };
}

router.get("/notification-preferences/me", async (req: Request, res: Response) => {
  const me = currentUser(req);
  if (!me) {
    res.status(403).json({ error: "Preferences are per-user" });
    return;
  }
  try {
    // No row is not an error and not an empty object: it means "has not chosen",
    // and the honest answer is the defaults they are actually living under.
    const row = await prisma.userNotificationPreference.findUnique({
      where: { userId: me.userId },
    });
    res.json({ data: shape(row as never) });
  } catch (err) {
    console.error("Get own notification preferences error:", err);
    res.status(500).json({ error: "Failed to get notification preferences" });
  }
});

router.patch("/notification-preferences/me", async (req: Request, res: Response) => {
  const me = currentUser(req);
  if (!me) {
    res.status(403).json({ error: "Preferences are per-user" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const data: Record<string, unknown> = {};

  for (const key of ["inApp", "email", "whatsapp", "approvals"] as const) {
    if (key in body) {
      if (typeof body[key] !== "boolean") {
        res.status(400).json({ error: `${key} must be a boolean` });
        return;
      }
      data[key] = body[key];
    }
  }

  if ("quietHours" in body) {
    const q = body.quietHours;
    if (q === null) {
      // Explicitly turning quiet hours off. Both ends clear together - half a
      // window is not a state this can be left in.
      data.quietHoursFrom = null;
      data.quietHoursTo = null;
    } else if (q && typeof q === "object") {
      const from = (q as Record<string, unknown>).from;
      const to = (q as Record<string, unknown>).to;
      if (typeof from !== "string" || typeof to !== "string" || !HHMM.test(from) || !HHMM.test(to)) {
        res.status(400).json({ error: "quietHours must be { from: \"HH:MM\", to: \"HH:MM\" }" });
        return;
      }
      // from === to would be a zero-length window or a whole day depending on
      // how the reader interprets it, and neither is what anyone means.
      if (from === to) {
        res.status(400).json({ error: "quietHours from and to cannot be the same" });
        return;
      }
      // A window that wraps midnight (22:00 to 07:00) is the COMMON case, so
      // from > to is valid and deliberately not rejected.
      data.quietHoursFrom = from;
      data.quietHoursTo = to;
    } else {
      res.status(400).json({ error: "quietHours must be an object or null" });
      return;
    }
  }

  if (Object.keys(data).length === 0) {
    res.status(400).json({ error: "No recognised preference fields in the request" });
    return;
  }

  try {
    const row = await prisma.userNotificationPreference.upsert({
      where: { userId: me.userId },
      create: { ...DEFAULTS, ...data, userId: me.userId, tenantId: me.tenantId } as never,
      update: data as never,
    });
    res.json({ data: shape(row as never) });
  } catch (err) {
    console.error("Update own notification preferences error:", err);
    res.status(500).json({ error: "Failed to update notification preferences" });
  }
});

export default router;
