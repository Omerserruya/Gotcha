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
import { EVENT_PREFS_KEY, type EventChannels } from "../services/personal-preferences.service";
import { receivableEvents } from "../services/receivable-events";
import { EVENT_CATALOGUE } from "../services/event-catalogue";
import { platformSenderFor } from "../services/platform-whatsapp";
import { VERIFICATION_EVENT } from "@chatcenter/shared";
import { startVerification, confirmVerification } from "../services/whatsapp-verify.service";

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
  // On like in-app: a phone only gets push once its owner signed in on it and
  // allowed notifications there, which is the opt-in.
  push: true,
  approvals: true,
  quietHoursFrom: null as string | null,
  quietHoursTo: null as string | null,
};

/** "HH:MM", 24-hour. Anything else is rejected rather than coerced. */
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function shape(row: Record<string, unknown> | null, whatsappAvailable: boolean) {
  const r = { ...DEFAULTS, ...(row ?? {}) } as typeof DEFAULTS;
  return {
    inApp: r.inApp,
    email: r.email,
    whatsapp: r.whatsapp,
    push: r.push,
    approvals: r.approvals,
    // A window needs both ends to mean anything, so it is one nullable object
    // rather than two independent fields the client has to correlate.
    quietHours:
      r.quietHoursFrom && r.quietHoursTo ? { from: r.quietHoursFrom, to: r.quietHoursTo } : null,
    // WhatsApp alerts (2026-11-02): offered only when GOTCHA's number is set
    // up; on only with a number confirmed by code.
    whatsappAvailable,
    whatsappPhone: ((row ?? {}) as any).whatsappPhone ?? null,
    whatsappOptedInAt: ((row ?? {}) as any).whatsappOptedInAt ?? null,
  };
}

function currentUser(req: Request): { userId: string; tenantId: string } | null {
  const userId = (req.user as any)?.userId as string | undefined;
  if (!userId || (req.user as any)?.isInternal) return null;
  return { userId, tenantId: req.tenantId as string };
}

/**
 * Per event (2026-10-11): `eventTypes` lists what can reach this person and on
 * which channels; `events` is the switch for each, an override if they set one,
 * else on - exactly what was sent before anyone touched it.
 */
async function eventsFor(me: { userId: string; tenantId: string }) {
  const [types, stored] = await Promise.all([
    receivableEvents(me.tenantId, me.userId),
    prisma.tenantSetting.findFirst({ where: { tenantId: me.tenantId, key: EVENT_PREFS_KEY(me.userId) }, select: { value: true } }),
  ]);
  const own = (((stored?.value as any)?.events ?? {}) as Record<string, EventChannels>);
  const events: Record<string, EventChannels> = {};
  for (const t of types) {
    events[t.type] = {
      ...(t.channels.includes("email") ? { email: own[t.type]?.email ?? true } : {}),
      ...(t.channels.includes("in_app") ? { inApp: own[t.type]?.inApp ?? true } : {}),
      ...(t.channels.includes("whatsapp") ? { whatsapp: own[t.type]?.whatsapp ?? true } : {}),
      ...(t.channels.includes("push") ? { push: own[t.type]?.push ?? true } : {}),
    };
  }
  return { events, eventTypes: types };
}

const KNOWN_EVENTS = new Set(EVENT_CATALOGUE.map((e) => e.key));

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
    res.json({ data: { ...shape(row as never, !!(await platformSenderFor(VERIFICATION_EVENT, null))), ...(await eventsFor(me)) } });
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

  for (const key of ["inApp", "email", "whatsapp", "push", "approvals"] as const) {
    if (key in body) {
      if (typeof body[key] !== "boolean") {
        res.status(400).json({ error: `${key} must be a boolean` });
        return;
      }
      data[key] = body[key];
    }
  }

  // WhatsApp needs a number confirmed by code (POST .../whatsapp/confirm);
  // { whatsappPhone: null } removes it and turns WhatsApp off.
  if ("whatsappPhone" in body) {
    if (body.whatsappPhone !== null) {
      res.status(400).json({ error: "whatsappPhone is set by confirming a code", code: "whatsapp_phone_requires_code" });
      return;
    }
    data.whatsappPhone = null;
    data.whatsappOptedInAt = null;
    data.whatsapp = false;
  }
  if (data.whatsapp === true) {
    const cur = await prisma.userNotificationPreference.findUnique({ where: { userId: me.userId } }).catch(() => null) as any;
    if (!cur?.whatsappPhone || !cur?.whatsappOptedInAt) {
      res.status(422).json({ error: "Confirm a WhatsApp number first", code: "whatsapp_phone_required" });
      return;
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

  // { events: { "<eventType>": { email?: boolean, inApp?: boolean, whatsapp?: boolean, push?: boolean } } }
  let eventPatch: Record<string, EventChannels> | null = null;
  if ("events" in body) {
    const ev = body.events;
    if (!ev || typeof ev !== "object" || Array.isArray(ev)) {
      res.status(400).json({ error: "events must be an object of { email?, inApp?, whatsapp?, push? } by event type" });
      return;
    }
    eventPatch = {};
    for (const [type, v] of Object.entries(ev as Record<string, unknown>)) {
      if (!KNOWN_EVENTS.has(type)) {
        res.status(400).json({ error: `unknown event type: ${type}`, code: "UNKNOWN_EVENT" });
        return;
      }
      if (!v || typeof v !== "object") {
        res.status(400).json({ error: `events.${type} must be { email?, inApp?, whatsapp?, push? }` });
        return;
      }
      const entry: EventChannels = {};
      for (const ch of ["email", "inApp", "whatsapp", "push"] as const) {
        if (ch in (v as object)) {
          const b = (v as Record<string, unknown>)[ch];
          if (typeof b !== "boolean") {
            res.status(400).json({ error: `events.${type}.${ch} must be a boolean` });
            return;
          }
          entry[ch] = b;
        }
      }
      eventPatch[type] = entry;
    }
  }

  if (Object.keys(data).length === 0 && !eventPatch) {
    res.status(400).json({ error: "No recognised preference fields in the request" });
    return;
  }

  try {
    const row = Object.keys(data).length
      ? await prisma.userNotificationPreference.upsert({
          where: { userId: me.userId },
          create: { ...DEFAULTS, ...data, userId: me.userId, tenantId: me.tenantId } as never,
          update: data as never,
        })
      : await prisma.userNotificationPreference.findUnique({ where: { userId: me.userId } });
    if (eventPatch) {
      const key = EVENT_PREFS_KEY(me.userId);
      const stored = await prisma.tenantSetting.findFirst({ where: { tenantId: me.tenantId, key }, select: { value: true } });
      const merged: Record<string, EventChannels> = { ...(((stored?.value as any)?.events ?? {}) as Record<string, EventChannels>) };
      for (const [type, entry] of Object.entries(eventPatch)) merged[type] = { ...(merged[type] ?? {}), ...entry };
      await prisma.tenantSetting.upsert({
        where: { tenantId_key: { tenantId: me.tenantId, key } },
        create: { tenantId: me.tenantId, key, value: { events: merged } as never, updatedBy: me.userId },
        update: { value: { events: merged } as never, updatedBy: me.userId },
      });
    }
    res.json({ data: { ...shape(row as never, !!(await platformSenderFor(VERIFICATION_EVENT, null))), ...(await eventsFor(me)) } });
  } catch (err) {
    console.error("Update own notification preferences error:", err);
    res.status(500).json({ error: "Failed to update notification preferences" });
  }
});

router.post("/notification-preferences/me/whatsapp/verify", async (req: Request, res: Response) => {
  const me = currentUser(req);
  if (!me) { res.status(403).json({ error: "Preferences are per-user" }); return; }
  try {
    const r = await startVerification(me, (req.body ?? {}).phone);
    if (!r.ok) {
      const status = r.code === "whatsapp_rate_limited" ? 429 : r.code === "whatsapp_unavailable" ? 409 : r.code === "whatsapp_send_failed" ? 502 : 422;
      res.status(status).json({ error: "Could not send a code", code: r.code });
      return;
    }
    res.status(202).json({ data: { expiresInSeconds: r.expiresInSeconds } });
  } catch (err) {
    console.error("WhatsApp verify error:", err);
    res.status(500).json({ error: "Failed to send a code" });
  }
});

router.post("/notification-preferences/me/whatsapp/confirm", async (req: Request, res: Response) => {
  const me = currentUser(req);
  if (!me) { res.status(403).json({ error: "Preferences are per-user" }); return; }
  try {
    const r = await confirmVerification(me, (req.body ?? {}).phone, (req.body ?? {}).code);
    if (!r.ok) { res.status(422).json({ error: "The code did not confirm the number", code: r.code }); return; }
    const row = await prisma.userNotificationPreference.findUnique({ where: { userId: me.userId } });
    res.json({ data: { ...shape(row as never, !!(await platformSenderFor(VERIFICATION_EVENT, null))), ...(await eventsFor(me)) } });
  } catch (err) {
    console.error("WhatsApp confirm error:", err);
    res.status(500).json({ error: "Failed to confirm the code" });
  }
});

export default router;
