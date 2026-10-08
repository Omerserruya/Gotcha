/**
 * A person's own notification settings, applied (design 15, Step 0).
 *
 * user_notification_preferences (in-app / email / WhatsApp / approvals /
 * quiet hours) was saved by GET/PATCH /notification-preferences/me and read
 * by NOTHING: the fan-out routed only by the workspace's routing rules, so
 * every switch on the settings screen changed nothing (2026-10-08). The
 * fan-out now asks this, per recipient and channel:
 *   - the channel's own switch (in-app, email; WhatsApp is not deliverable);
 *   - "approvals": off silences approval notices on every channel;
 *   - quiet hours (the workspace's timezone): no email; the in-app row is
 *     still written, silently, so nothing is lost. One
 *     exception: an action that failed with money involved (a refund, a
 *     discount) still reaches email.
 * No row means the defaults the settings screen shows.
 */
import { prisma, readDurableSetting, parseBusinessHours } from "@chatcenter/shared";

export interface Personal { inApp: boolean; email: boolean; whatsapp: boolean; approvals: boolean; quietHoursFrom: string | null; quietHoursTo: string | null }

/** The same defaults as routes/notification-preferences-me.ts. */
export const PERSONAL_DEFAULTS: Personal = { inApp: true, email: true, whatsapp: false, approvals: true, quietHoursFrom: null, quietHoursTo: null };

const MONEY_KINDS = new Set(["refund.issued", "discount.applied"]);

export async function loadPersonal(userIds: string[]): Promise<Map<string, Personal>> {
  const out = new Map<string, Personal>();
  if (!userIds.length) return out;
  const rows = await (prisma as any).userNotificationPreference.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, inApp: true, email: true, whatsapp: true, approvals: true, quietHoursFrom: true, quietHoursTo: true },
  });
  for (const r of rows) out.set(r.userId, { ...PERSONAL_DEFAULTS, ...r });
  return out;
}

/** The workspace's timezone (its business hours), else UTC. */
export async function workspaceTimeZone(tenantId: string): Promise<string> {
  try {
    return parseBusinessHours(await readDurableSetting(tenantId, "businessHours"))?.timezone || "UTC";
  } catch {
    return "UTC";
  }
}

/** "HH:MM" now in this timezone. */
export function localTime(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(now);
  } catch {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }).format(now);
  }
}

/** Inside a quiet window ("22:00" to "07:00" wraps midnight; from is inside, to is not). */
export function inQuietHours(p: Personal, hhmm: string): boolean {
  const { quietHoursFrom: from, quietHoursTo: to } = p;
  if (!from || !to || from === to) return false;
  return from < to ? hhmm >= from && hhmm < to : hhmm >= from || hhmm < to;
}

/** Whether this person gets this event on this channel now. */
export function personalAllows(p: Personal, channel: string, event: { type: string; data?: Record<string, unknown> }, hhmm: string): boolean {
  if (event.type === "tool.approval_required" && !p.approvals) return false;
  if (channel === "in_app") return p.inApp;
  if (channel === "email") {
    if (!p.email) return false;
    const moneyFailed = event.type === "tool.action_failed" && MONEY_KINDS.has(String(event.data?.kind ?? ""));
    return moneyFailed || !inQuietHours(p, hhmm);
  }
  if (channel === "whatsapp") return p.whatsapp && !inQuietHours(p, hhmm);
  // Any other channel: not the person's to switch (the dispatcher records it as undeliverable).
  return true;
}
