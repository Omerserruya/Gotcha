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
import { defaultRoute, DELIVERABLE_CHANNELS, wantsPush, ASSIGNEE_PUSH_ONLY } from "./notification-engine.service";
import { fcmConfig } from "./push-sender";
import { apnsConfig } from "./apns-sender";
import { wantsWhatsApp } from "./whatsapp-notice.service";
import { platformSenderFor, whatsAppReadiness } from "./platform-whatsapp";
import { resolveRecipients, type RecipientSpec } from "./recipient-resolver.service";

export interface ReceivableEvent { type: string; label: string; group: string; channels: string[] }

/** The two channels a person switches per event; WhatsApp and push are added where they can be sent. */
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
  // A person can only have WhatsApp if they can confirm a number: the
  // verification code must be sendable. Each event is then gated on its own
  // template (approved, alert on) below.
  const whatsappReady = !!(await platformSenderFor("verification", null));
  // Push per event: only where the event pushes and a provider is set up.
  const pushReady = !!fcmConfig() || !!apnsConfig();
  const out: ReceivableEvent[] = [];
  for (const entry of EVENT_CATALOGUE) {
    if (!entry.emitted) continue;
    // An inbound customer message ignores workspace rules (the assignee only).
    let routes: Array<{ recipients: RecipientSpec; channels: string[]; departmentId: string | null }> = rules
      .filter((r) => r.eventType === entry.key && !ASSIGNEE_PUSH_ONLY.has(entry.key))
      .map((r) => ({ recipients: r.recipients as RecipientSpec, channels: Array.isArray(r.channels) ? r.channels : ["email", "in_app"], departmentId: r.departmentId ?? null }));
    if (routes.length === 0) {
      // The built-in route, from the one definition the fan-out uses (an
      // assignment counts as this person's).
      const fb = defaultRoute({ type: entry.key, tenantId, metadata: { userId } } as any);
      if (fb) routes = [{ recipients: fb.recipients, channels: fb.channels, departmentId: null }];
    }
    const channels = new Set<string>();
    // Push needs only that the event reaches this person: it has no rule
    // channel of its own (message.inbound has none at all).
    let reached = false;
    for (const r of routes) {
      if (!r.recipients?.type) continue;
      if (!(await reaches(r.recipients, r.departmentId))) continue;
      reached = true;
      for (const c of r.channels) if (PER_EVENT_CHANNELS.includes(c) && deliverable.has(c)) channels.add(c);
    }
    const list = PER_EVENT_CHANNELS.filter((c) => channels.has(c));
    if (list.length) {
      // WhatsApp per event: only where a template exists and GOTCHA's number is set up.
      if (whatsappReady && wantsWhatsApp(entry.key) && (await whatsAppReadiness(entry.key)).ready) list.push("whatsapp");
    }
    if (reached && pushReady && wantsPush(entry.key)) list.push("push");
    if (list.length) out.push({ type: entry.key, label: entry.label, group: entry.group, channels: list });
  }
  return out;
}
