/**
 * Which events can reach THIS person, and on which channels (2026-10-11): the
 * rows of the per-event settings matrix. Read from the same routing the
 * fan-out uses - the workspace's enabled rules for each event, else the
 * built-in route - so the screen never offers a switch for something that
 * could never arrive.
 *
 * Approximation, stated: a department-scoped rule is resolved for the rule's
 * own department, and the built-in "conversation.assigned" route goes to
 * whoever is assigned, so it counts for everyone.
 */
import { prisma } from "@chatcenter/shared";
import { EVENT_CATALOGUE } from "./event-catalogue";
import { defaultRoute, DELIVERABLE_CHANNELS } from "./notification-engine.service";
import { wantsWhatsApp } from "./whatsapp-notice.service";
import { getPlatformWhatsAppSender } from "./platform-whatsapp";
import { resolveRecipients, type RecipientSpec } from "./recipient-resolver.service";

export interface ReceivableEvent { type: string; label: string; group: string; channels: string[] }

/** The two channels a person switches per event; WhatsApp is added where it can be sent (a template, the platform number). */
const PER_EVENT_CHANNELS = ["email", "in_app"];

export async function receivableEvents(tenantId: string, userId: string): Promise<ReceivableEvent[]> {
  const rules: any[] = await (prisma as any).notificationPreference.findMany({ where: { tenantId, enabled: true } });
  const resolved = new Map<string, boolean>();
  const reaches = async (spec: RecipientSpec, departmentId: string | null): Promise<boolean> => {
    const key = `${JSON.stringify(spec)}|${departmentId ?? ""}`;
    if (!resolved.has(key)) {
      const users = await resolveRecipients({ tenantId, departmentId: departmentId ?? undefined, spec }).catch(() => []);
      resolved.set(key, users.some((u) => u.id === userId));
    }
    return resolved.get(key)!;
  };
  const deliverable = new Set<string>(DELIVERABLE_CHANNELS as readonly string[]);
  const whatsappReady = !!getPlatformWhatsAppSender();
  const out: ReceivableEvent[] = [];
  for (const entry of EVENT_CATALOGUE) {
    if (!entry.emitted) continue;
    let routes: Array<{ recipients: RecipientSpec; channels: string[]; departmentId: string | null }> = rules
      .filter((r) => r.eventType === entry.key)
      .map((r) => ({ recipients: r.recipients as RecipientSpec, channels: Array.isArray(r.channels) ? r.channels : ["email", "in_app"], departmentId: r.departmentId ?? null }));
    if (routes.length === 0) {
      // The built-in route, from the one definition the fan-out uses (an
      // assignment counts as this person's).
      const fb = defaultRoute({ type: entry.key, tenantId, metadata: { userId } } as any);
      if (fb) routes = [{ recipients: fb.recipients, channels: fb.channels, departmentId: null }];
    }
    const channels = new Set<string>();
    for (const r of routes) {
      if (!r.recipients?.type) continue;
      if (await reaches(r.recipients, r.departmentId)) for (const c of r.channels) if (PER_EVENT_CHANNELS.includes(c) && deliverable.has(c)) channels.add(c);
    }
    if (channels.size) {
      const list = PER_EVENT_CHANNELS.filter((c) => channels.has(c));
      // WhatsApp per event: only where a template exists and GOTCHA's number is set up.
      if (whatsappReady && wantsWhatsApp(entry.key)) list.push("whatsapp");
      out.push({ type: entry.key, label: entry.label, group: entry.group, channels: list });
    }
  }
  return out;
}
