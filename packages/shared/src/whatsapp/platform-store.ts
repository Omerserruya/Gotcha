/**
 * The platform alerts number's template rows (platform_whatsapp_templates):
 * seeding from code, applying Meta's status (webhook or sync), switching an
 * alert off when Meta pauses, disables or rejects its template, and the
 * console's view. Shared by auth (the console routes) and webhook (Meta's
 * template status updates for the platform WABA). 2026-11-15.
 */
import { prisma } from "../lib/prisma";
import { writeAudit, AuditAction } from "../lib/audit";
import {
  platformTemplateCatalogue,
  platformTemplateDefinition,
  TEMPLATE_LOCALES,
  type TemplateLocale,
} from "./platform-templates";
import type { PlatformTemplateStatusValue, PlatformTemplateView } from "./platform-contract";
import { bumpPlatformSenderVersion, PLATFORM_SENDER_ID, rowCanSend, type PlatformSenderRow } from "./platform-sender";

const db = () => prisma as any;

export interface PlatformTemplateRow {
  id: string;
  eventType: string;
  language: string;
  name: string;
  category: string;
  body: string;
  status: PlatformTemplateStatusValue;
  rejectedReason: string | null;
  metaTemplateId: string | null;
  draftBody: string | null;
  submittedAt: Date | null;
  lastSyncedAt: Date | null;
}

/** One row per (template, language); the code's body only on create, never over an edited one. */
export async function seedPlatformTemplateRows(): Promise<PlatformTemplateRow[]> {
  for (const d of platformTemplateCatalogue()) {
    for (const language of TEMPLATE_LOCALES) {
      await db().platformWhatsAppTemplate.upsert({
        where: { eventType_language: { eventType: d.eventType, language } },
        create: { eventType: d.eventType, language, name: d.name, category: d.category, body: d.body[language] },
        update: { name: d.name, category: d.category },
      });
    }
  }
  return db().platformWhatsAppTemplate.findMany({});
}

/**
 * Meta's word for a template status, as our enum. Webhook events and the
 * template list's `status` both come through here. null: not a status change
 * we store (FLAGGED is a quality warning and the template still sends).
 */
export function metaTemplateStatus(raw: unknown): PlatformTemplateStatusValue | null {
  const v = String(raw ?? "").toUpperCase();
  switch (v) {
    case "APPROVED": case "REINSTATED": return "APPROVED";
    case "PENDING": case "IN_REVIEW": return "PENDING";
    case "REJECTED": return "REJECTED";
    case "PAUSED": return "PAUSED";
    case "DISABLED": return "DISABLED";
    case "IN_APPEAL": return "IN_APPEAL";
    case "PENDING_DELETION": return "PENDING_DELETION";
    case "DELETED": return "NOT_SUBMITTED";
    default: return null;
  }
}

const STOPS_SENDING = new Set<PlatformTemplateStatusValue>(["PAUSED", "DISABLED", "REJECTED"]);

/** Meta's language code to ours ("en_US" -> "en"); null when it is neither. */
export function platformLanguage(raw: unknown): TemplateLocale | null {
  const v = String(raw ?? "").toLowerCase().split(/[_-]/)[0];
  return v === "he" || v === "en" ? v : null;
}

/**
 * Apply one Meta status to the matching row (by Meta's template id, else by
 * name and language). When the status stops sending and the template's alert
 * is on, the alert is switched off and audited. Returns whether a row changed.
 */
export async function applyPlatformTemplateStatus(u: {
  name: string;
  language: string | null;
  metaTemplateId: string | null;
  status: PlatformTemplateStatusValue;
  rejectedReason?: string | null;
  source: "webhook" | "sync" | "submit";
}): Promise<boolean> {
  const lang = platformLanguage(u.language);
  const rows: PlatformTemplateRow[] = await db().platformWhatsAppTemplate.findMany({
    where: u.metaTemplateId ? { OR: [{ metaTemplateId: u.metaTemplateId }, ...(lang ? [{ name: u.name, language: lang }] : [])] } : { name: u.name, ...(lang ? { language: lang } : {}) },
  });
  const row = rows.find((r) => u.metaTemplateId && r.metaTemplateId === u.metaTemplateId) ?? rows.find((r) => r.name === u.name && (!lang || r.language === lang));
  if (!row) return false;
  const reason = u.status === "APPROVED" || u.status === "PENDING" ? null : (u.rejectedReason && u.rejectedReason !== "NONE" ? String(u.rejectedReason) : row.rejectedReason ?? null);
  await db().platformWhatsAppTemplate.update({
    where: { id: row.id },
    data: {
      status: u.status,
      rejectedReason: reason,
      ...(u.metaTemplateId ? { metaTemplateId: u.metaTemplateId } : {}),
      ...(u.status === "NOT_SUBMITTED" ? { metaTemplateId: null } : {}),
      lastSyncedAt: new Date(),
    },
  });
  if (STOPS_SENDING.has(u.status)) await switchOffFor(row.eventType, `${row.name} (${row.language}) is ${u.status} at Meta${reason ? `: ${reason}` : ""}`);
  return row.status !== u.status;
}

async function switchOffFor(eventType: string, why: string): Promise<void> {
  const governedBy = platformTemplateDefinition(eventType)?.governedBy;
  if (!governedBy) return;
  const sender = await db().platformWhatsAppSender.findUnique({ where: { id: PLATFORM_SENDER_ID } });
  const enabled = enabledMap(sender?.alertsEnabled);
  if (enabled[governedBy] !== true) return;
  await db().platformWhatsAppSender.update({ where: { id: PLATFORM_SENDER_ID }, data: { alertsEnabled: { ...enabled, [governedBy]: false } } });
  await bumpPlatformSenderVersion();
  await writeAudit({
    tenantId: "platform",
    actorType: "system",
    action: AuditAction.PLATFORM_WHATSAPP_ALERT_AUTO_DISABLED,
    targetType: "platform_whatsapp_alert",
    targetId: governedBy,
    metadata: { reason: why },
  });
}

export function enabledMap(v: unknown): Record<string, boolean> {
  return v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, boolean>) } : {};
}

/** Every template in both languages APPROVED. */
export function bothApproved(rows: PlatformTemplateRow[], eventType: string): boolean {
  return TEMPLATE_LOCALES.every((l) => rows.some((r) => r.eventType === eventType && r.language === l && r.status === "APPROVED"));
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** The console's list: all eight, in order, each with both languages. */
export function buildPlatformTemplateViews(rows: PlatformTemplateRow[], sender: PlatformSenderRow | null): PlatformTemplateView[] {
  const enabled = enabledMap(sender?.alertsEnabled);
  const connected = rowCanSend(sender);
  return platformTemplateCatalogue().map((d) => {
    const languages = Object.fromEntries(TEMPLATE_LOCALES.map((l) => {
      const r = rows.find((x) => x.eventType === d.eventType && x.language === l);
      return [l, {
        body: r?.body ?? d.body[l],
        draftBody: r?.draftBody ?? null,
        status: (r?.status ?? "NOT_SUBMITTED") as PlatformTemplateStatusValue,
        rejectedReason: r?.rejectedReason ?? null,
        metaTemplateId: r?.metaTemplateId ?? null,
        submittedAt: iso(r?.submittedAt),
        lastSyncedAt: iso(r?.lastSyncedAt),
      }];
    })) as PlatformTemplateView["languages"];
    return {
      eventType: d.eventType,
      name: d.name,
      category: d.category,
      parameterCount: d.parameterCount,
      buttons: d.buttons,
      alertEnabled: d.governedBy ? enabled[d.governedBy] === true : true,
      toggleable: d.toggleable,
      editable: d.editable,
      canEnable: connected && bothApproved(rows, d.eventType),
      languages,
    };
  });
}

/**
 * Meta's body rules for an edited template: exactly {{1}}..{{n}}, each once,
 * and neither starting nor ending with a variable. null when valid, else why.
 */
export function platformBodyProblem(body: unknown, parameterCount: number): string | null {
  const text = String(body ?? "").trim();
  if (!text) return "The body is empty.";
  if (text.length > 1024) return "The body is longer than Meta's 1024 characters.";
  const found = [...text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  const want = Array.from({ length: parameterCount }, (_, i) => i + 1);
  const sorted = [...found].sort((a, b) => a - b);
  if (sorted.length !== want.length || sorted.some((n, i) => n !== want[i])) {
    return parameterCount === 0
      ? "This template takes no variables; remove every {{n}}."
      : `The body must use ${want.map((n) => `{{${n}}}`).join(", ")} exactly once each.`;
  }
  if (/^\{\{\s*\d+\s*\}\}/.test(text) || /\{\{\s*\d+\s*\}\}[.!?\s]*$/.test(text)) return "Meta refuses a body that starts or ends with a variable.";
  if (/\{\{[^}]*\}\}/.test(text.replace(/\{\{\s*\d+\s*\}\}/g, ""))) return "Only numbered variables like {{1}} are allowed.";
  return null;
}

/**
 * Meta's phone_number_quality_update for the platform number: the messaging
 * limit tier (current_limit) and, when Meta names it, the quality rating.
 */
export async function notePlatformPhoneQuality(v: { current_limit?: unknown; event?: unknown; quality_rating?: unknown }): Promise<void> {
  const data: Record<string, string> = {};
  if (v.current_limit) data.messagingLimitTier = String(v.current_limit);
  if (v.quality_rating) data.qualityRating = String(v.quality_rating);
  if (!Object.keys(data).length) return;
  await db().platformWhatsAppSender.updateMany({ where: { id: PLATFORM_SENDER_ID }, data });
  await bumpPlatformSenderVersion();
}
