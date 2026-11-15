/**
 * SYSTEM_ADMIN console: GOTCHA's own WhatsApp alerts number (2026-11-15).
 * Contract: docs/api/platform-whatsapp-contract.md and
 * packages/shared/src/whatsapp/platform-contract.ts.
 *
 * The number is connected by Embedded Signup with the same Meta app and
 * configuration as tenants (signup-connect), but it is stored in
 * platform_whatsapp_senders, never as a ChannelAccount. Connect refuses any
 * number or WABA a workspace uses, which is what keeps the GOTCHA sales
 * number (a tenant's) out of here. The register PIN is random, not "000000".
 *
 * These routes are the only writers of the platform tables; every write bumps
 * the resolver's version and writes one audit row (tenantId "platform", actor
 * the admin). No response or log carries the access token or the PIN.
 */
import crypto from "crypto";
import { Router, Request, Response } from "express";
import { z } from "zod";
import axios from "axios";
import {
  prisma,
  authenticate,
  requireSystemAdmin,
  validate,
  crossTenantMiddleware,
  writeAudit,
  AuditAction,
  encryptCredentials,
  decryptCredentials,
  metaGraphBaseUrl,
  buildEmbeddedSignupLaunch,
  EMBEDDED_SIGNUP_DIALOG_VERSION,
  resolveAppPublicUrl,
  exchangeSignupCode,
  signupTokenWabaIds,
  subscribeSignupWaba,
  listSignupPhoneIds,
  getSignupPhoneDetails,
  registerSignupPhone,
  PLATFORM_SENDER_ID,
  bumpPlatformSenderVersion,
  envPlatformSender,
  rowCanSend,
  isMetaTokenError,
  seedPlatformTemplateRows,
  buildPlatformTemplateViews,
  applyPlatformTemplateStatus,
  metaTemplateStatus,
  platformLanguage,
  platformBodyProblem,
  platformTemplateDefinition,
  platformTemplateCatalogue,
  bothApproved,
  enabledMap,
  PLATFORM_WHATSAPP_ERRORS,
  type PlatformWhatsAppErrorCode,
  type PlatformWhatsAppStatus,
  type PlatformTemplateView,
  type PlatformTemplateRow,
  type PlatformSenderRow,
  type TemplateLocale,
} from "@chatcenter/shared";
import { withErrorCode, splitErrorCode } from "../lib/error-code";

const router = Router();
// The admin session belongs to no tenant, and the connect checks read every
// tenant's WhatsApp rows (to refuse a workspace's number).
router.use("/platform-whatsapp", authenticate, requireSystemAdmin(), crossTenantMiddleware);

const META_APP_ID = process.env.META_APP_ID || "";
const META_APP_SECRET = process.env.META_APP_SECRET || "";
const FB_API_URL = metaGraphBaseUrl(process.env.FACEBOOK_API_URL);
const TAG = "[PLATFORM-WA]";
const db = () => prisma as any;

class Refusal extends Error {
  constructor(readonly code: PlatformWhatsAppErrorCode, message: string, readonly meta?: { code?: number; message?: string }) {
    super(message);
  }
}

function send(res: Response, err: unknown): void {
  if (err instanceof Refusal) {
    res.status(PLATFORM_WHATSAPP_ERRORS[err.code]).json({ error: err.code, message: err.message, ...(err.meta ? { meta: err.meta } : {}) });
    return;
  }
  const e: any = err;
  if (e?.code === "P2021" || /does not exist/i.test(String(e?.message ?? "")) && /platform_whatsapp/i.test(String(e?.message ?? ""))) {
    res.status(503).json({ error: "platform_store_unavailable", message: "The platform WhatsApp tables are not migrated yet." });
    return;
  }
  const metaErr = e?.response?.data?.error;
  if (metaErr) {
    res.status(502).json({ error: "meta_error", message: "Meta refused the request.", meta: { code: metaErr.code, message: metaErr.error_user_msg || metaErr.message } });
    return;
  }
  console.error(`${TAG} error:`, e?.message);
  res.status(500).json({ error: "internal_error", message: "Something went wrong." });
}

/** "[CODE] sentence", the lastError format splitErrorCode reads (codes of this number only). */
const coded = (code: "TOKEN_INVALID" | "DISCONNECT_NOTE", sentence: string) => `[${code}] ${sentence}`;

const actorOf = (req: Request): string | null => (req as any).user?.userId ?? null;

async function audit(req: Request, action: string, targetId: string, metadata: Record<string, unknown>): Promise<void> {
  await writeAudit({ tenantId: "platform", actorType: "user", actorId: actorOf(req), action, targetType: "platform_whatsapp", targetId, metadata });
}

async function readRow(): Promise<PlatformSenderRow | null> {
  return (await db().platformWhatsAppSender.findUnique({ where: { id: PLATFORM_SENDER_ID } })) ?? null;
}

function tokenOf(row: PlatformSenderRow | null): string | null {
  if (!row?.credentials) return null;
  try {
    const c = decryptCredentials(String(row.credentials));
    return typeof c?.accessToken === "string" && c.accessToken ? c.accessToken : null;
  } catch {
    return null;
  }
}

async function statusView(row: PlatformSenderRow | null): Promise<PlatformWhatsAppStatus> {
  const env = envPlatformSender();
  const r: any = row;
  let connectedBy: PlatformWhatsAppStatus["connectedBy"] = null;
  if (r?.connectedBy) {
    const u = await db().user.findUnique({ where: { id: r.connectedBy }, select: { id: true, name: true } }).catch(() => null);
    connectedBy = { id: r.connectedBy, name: u?.name ?? null };
  }
  const split = splitErrorCode(r?.lastError ?? null);
  return {
    status: (r?.status ?? "DISCONNECTED") as PlatformWhatsAppStatus["status"],
    source: rowCanSend(row) && tokenOf(row) ? "db" : env ? "env" : "none",
    envPresent: !!env,
    number: r?.phoneNumberId
      ? {
          display: r.displayPhoneNumber ?? null,
          verifiedName: r.verifiedName ?? null,
          phoneNumberId: r.phoneNumberId,
          wabaId: r.wabaId ?? null,
          qualityRating: r.qualityRating ?? null,
          messagingLimitTier: r.messagingLimitTier ?? null,
        }
      : null,
    connectedAt: r?.connectedAt ? new Date(r.connectedAt).toISOString() : null,
    connectedBy,
    disconnectedAt: r?.disconnectedAt ? new Date(r.disconnectedAt).toISOString() : null,
    lastErrorCode: split.lastErrorCode,
    lastError: split.lastError,
    launch: buildEmbeddedSignupLaunch(process.env),
  };
}

const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");

/** 409 when a workspace uses this number (any state) or this WABA. */
async function refuseWorkspaceNumber(phoneNumberId: string, wabaId: string, displayPhone: string | null): Promise<void> {
  const account = await db().channelAccount.findFirst({ where: { channel: "WHATSAPP", externalId: phoneNumberId }, select: { id: true } });
  const number = await db().whatsAppNumber.findFirst({ where: { phoneNumberId }, select: { id: true } });
  let byDisplay = false;
  const d = digits(displayPhone);
  if (d.length >= 8) {
    const nums: Array<{ displayPhoneNumber: string | null }> = await db().whatsAppNumber.findMany({ where: { displayPhoneNumber: { not: null } }, select: { displayPhoneNumber: true } });
    byDisplay = nums.some((n) => digits(n.displayPhoneNumber).endsWith(d.slice(-9)));
  }
  if (account || number || byDisplay) {
    throw new Refusal("number_belongs_to_workspace", "This number is connected to a workspace (for example the GOTCHA sales number). The alerts number must be a separate number.");
  }
  const wabaNumber = await db().whatsAppNumber.findFirst({ where: { wabaId }, select: { id: true } });
  let wabaAccount = false;
  if (!wabaNumber) {
    const accounts: Array<{ credentials: unknown }> = await db().channelAccount.findMany({ where: { channel: "WHATSAPP" }, select: { credentials: true } });
    wabaAccount = accounts.some((a) => {
      try { return String(decryptCredentials(a.credentials as any)?.wabaId ?? "") === wabaId; } catch { return false; }
    });
  }
  if (wabaNumber || wabaAccount) {
    throw new Refusal("waba_belongs_to_workspace", "This WhatsApp Business Account holds a workspace's number. Create a separate account (e.g. \"GOTCHA Alerts\") for the alerts number.");
  }
}

// ─── Status ──────────────────────────────────────────────────

router.get("/platform-whatsapp", async (_req: Request, res: Response) => {
  try {
    res.json(await statusView(await readRow()));
  } catch (err) {
    send(res, err);
  }
});

// ─── Connect ─────────────────────────────────────────────────

const connectSchema = z.object({
  code: z.string().min(1),
  wabaId: z.string().min(1).optional(),
  phoneNumberId: z.string().min(1).optional(),
});

router.post("/platform-whatsapp/connect", validate(connectSchema), async (req: Request, res: Response) => {
  try {
    const { code, wabaId: sessionWabaId, phoneNumberId: sessionPhone } = req.body as z.infer<typeof connectSchema>;
    const signup = {
      http: axios,
      graphUrl: FB_API_URL,
      sdkGraphUrl: `https://graph.facebook.com/${EMBEDDED_SIGNUP_DIALOG_VERSION}`,
      appId: META_APP_ID,
      appSecret: META_APP_SECRET,
      tag: TAG,
    };
    const accessToken = await exchangeSignupCode(signup, code);
    if (!accessToken) throw new Refusal("code_exchange_failed", "Meta did not accept the signup code. Run the connect again.");

    let wabaId = sessionWabaId;
    if (!wabaId) {
      const ids = await signupTokenWabaIds(signup, accessToken);
      if (ids.length > 1) throw new Refusal("choose_one_number", "The signup granted several WhatsApp Business Accounts. Run it again and choose only the alerts account.");
      wabaId = ids[0];
    }
    if (!wabaId) throw new Refusal("no_waba", "No WhatsApp Business Account came back from the signup.");

    let phoneNumberId = sessionPhone;
    if (!phoneNumberId) {
      const ids = await listSignupPhoneIds(signup, wabaId, accessToken);
      if (ids.length > 1) throw new Refusal("choose_one_number", "This WhatsApp Business Account has several numbers. Run the signup again and pick the alerts number.");
      phoneNumberId = ids[0];
    }
    if (!phoneNumberId) throw new Refusal("no_phone_numbers", "The WhatsApp Business Account has no phone number.");

    const details = await getSignupPhoneDetails(signup, phoneNumberId, accessToken);
    // Before anything changes at Meta: a workspace's number or WABA is refused.
    await refuseWorkspaceNumber(phoneNumberId, wabaId, details?.display_phone_number ?? null);

    const { subscribed, error: subscribeError } = await subscribeSignupWaba(signup, wabaId, accessToken);
    // GOTCHA's own number: a random two-step PIN, never the tenant path's "000000".
    const pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    await registerSignupPhone(signup, phoneNumberId, accessToken, pin);

    const data = {
      status: subscribed ? "CONNECTED" : "PENDING_WEBHOOK",
      wabaId,
      phoneNumberId,
      displayPhoneNumber: details?.display_phone_number ?? null,
      verifiedName: details?.verified_name ?? null,
      qualityRating: details?.quality_rating ?? null,
      credentials: encryptCredentials({ accessToken, pin }),
      lastError: subscribed ? null : withErrorCode("SUBSCRIBE_FAILED", `Webhook subscription failed - approval replies cannot arrive yet: ${subscribeError}`),
      connectedAt: new Date(),
      connectedBy: actorOf(req),
      disconnectedAt: null,
    };
    const row = await db().platformWhatsAppSender.upsert({ where: { id: PLATFORM_SENDER_ID }, create: { id: PLATFORM_SENDER_ID, ...data }, update: data });
    await seedPlatformTemplateRows();
    await bumpPlatformSenderVersion();
    await audit(req, AuditAction.PLATFORM_WHATSAPP_CONNECTED, phoneNumberId, { wabaId, status: data.status, display: data.displayPhoneNumber });
    console.log(`${TAG} connected ${phoneNumberId} (WABA ${wabaId}) status=${data.status}`);
    res.status(201).json(await statusView(row));
  } catch (err) {
    send(res, err);
  }
});

// ─── Recheck ─────────────────────────────────────────────────

router.post("/platform-whatsapp/recheck", async (req: Request, res: Response) => {
  try {
    const row = await readRow();
    const token = tokenOf(row);
    if (!row?.phoneNumberId || !row.wabaId || !token || row.status === "DISCONNECTED") throw new Refusal("no_platform_number", "No alerts number is connected.");
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const data: Record<string, unknown> = {};
    try {
      const phone = (await axios.get(`${FB_API_URL}/${row.phoneNumberId}`, { params: { fields: "id,display_phone_number,verified_name,quality_rating,messaging_limit_tier" }, ...auth })).data ?? {};
      Object.assign(data, {
        displayPhoneNumber: phone.display_phone_number ?? row.displayPhoneNumber ?? null,
        verifiedName: phone.verified_name ?? row.verifiedName ?? null,
        qualityRating: phone.quality_rating ?? null,
        messagingLimitTier: phone.messaging_limit_tier ?? null,
      });
      const apps: any[] = (await axios.get(`${FB_API_URL}/${row.wabaId}/subscribed_apps`, auth)).data?.data ?? [];
      const ours = apps.some((a) => String(a?.whatsapp_business_api_data?.id ?? a?.id ?? "") === META_APP_ID);
      let subscribed = ours;
      let subErr: string | null = null;
      if (!ours) {
        const r = await subscribeSignupWaba({ http: axios, graphUrl: FB_API_URL, sdkGraphUrl: FB_API_URL, appId: META_APP_ID, appSecret: META_APP_SECRET, tag: TAG }, row.wabaId, token);
        subscribed = r.subscribed;
        subErr = r.error;
      }
      data.status = subscribed ? "CONNECTED" : "PENDING_WEBHOOK";
      data.lastError = subscribed ? null : withErrorCode("SUBSCRIBE_FAILED", `Webhook subscription failed - approval replies cannot arrive yet: ${subErr}`);
    } catch (e: any) {
      if (!isMetaTokenError(e)) throw e;
      data.status = "TOKEN_INVALID";
      data.lastError = coded("TOKEN_INVALID", String(e?.response?.data?.error?.message ?? "Meta refused the access token.").slice(0, 300));
    }
    const updated = await db().platformWhatsAppSender.update({ where: { id: PLATFORM_SENDER_ID }, data });
    await bumpPlatformSenderVersion();
    await audit(req, AuditAction.PLATFORM_WHATSAPP_RECHECKED, row.phoneNumberId, { status: data.status });
    res.json(await statusView(updated));
  } catch (err) {
    send(res, err);
  }
});

// ─── Disconnect ──────────────────────────────────────────────

const disconnectSchema = z.object({ deregister: z.boolean().optional() });

router.post("/platform-whatsapp/disconnect", validate(disconnectSchema), async (req: Request, res: Response) => {
  try {
    const row = await readRow();
    if (!row || row.status === "DISCONNECTED") throw new Refusal("no_platform_number", "No alerts number is connected.");
    const token = tokenOf(row);
    const deregister = req.body?.deregister === true;
    const notes: string[] = [];
    if (token && row.wabaId) {
      // Only the platform's own WABA can be here: connect refused a shared one.
      await axios.delete(`${FB_API_URL}/${row.wabaId}/subscribed_apps`, { headers: { Authorization: `Bearer ${token}` } })
        .catch((e: any) => notes.push(`unsubscribe: ${e?.response?.data?.error?.message ?? e?.message}`));
    }
    if (deregister && token && row.phoneNumberId) {
      await axios.post(`${FB_API_URL}/${row.phoneNumberId}/deregister`, {}, { headers: { Authorization: `Bearer ${token}` } })
        .catch((e: any) => notes.push(`deregister: ${e?.response?.data?.error?.message ?? e?.message}`));
    }
    // Local unlink: no token kept, sends stop now. The number, the templates
    // at Meta and their rows stay, so a reconnect needs no OTP or new templates.
    const updated = await db().platformWhatsAppSender.update({
      where: { id: PLATFORM_SENDER_ID },
      data: { status: "DISCONNECTED", credentials: null, disconnectedAt: new Date(), lastError: notes.length ? coded("DISCONNECT_NOTE", notes.join("; ").slice(0, 300)) : null },
    });
    await bumpPlatformSenderVersion();
    await audit(req, AuditAction.PLATFORM_WHATSAPP_DISCONNECTED, String(row.phoneNumberId ?? ""), { deregister, notes });
    res.json(await statusView(updated));
  } catch (err) {
    send(res, err);
  }
});

// ─── Templates ───────────────────────────────────────────────

async function views(): Promise<PlatformTemplateView[]> {
  const rows = await seedPlatformTemplateRows();
  return buildPlatformTemplateViews(rows, await readRow());
}
async function viewOf(eventType: string): Promise<PlatformTemplateView> {
  return (await views()).find((v) => v.eventType === eventType)!;
}

router.get("/platform-whatsapp/templates", async (_req: Request, res: Response) => {
  try {
    res.json({ data: await views() });
  } catch (err) {
    send(res, err);
  }
});

function sendingRow(row: PlatformSenderRow | null): { row: PlatformSenderRow; token: string; wabaId: string } {
  const token = tokenOf(row);
  if (!rowCanSend(row) || !token || !row!.wabaId) throw new Refusal("no_platform_number", "Connect the alerts number first.");
  return { row: row!, token, wabaId: row!.wabaId };
}

router.post("/platform-whatsapp/templates/sync", async (req: Request, res: Response) => {
  try {
    const { token, wabaId } = sendingRow(await readRow());
    await seedPlatformTemplateRows();
    const names = new Set(platformTemplateCatalogue().map((d) => d.name));
    let url: string | null = `${FB_API_URL}/${wabaId}/message_templates`;
    let params: Record<string, unknown> | undefined = { fields: "id,name,language,status,rejected_reason,category", limit: 100 };
    let applied = 0;
    for (let page = 0; url && page < 10; page++) {
      const resp: any = (await axios.get(url, { params, headers: { Authorization: `Bearer ${token}` } })).data ?? {};
      for (const t of resp.data ?? []) {
        if (!names.has(t.name)) continue;
        const status = metaTemplateStatus(t.status);
        if (!status || !platformLanguage(t.language)) continue;
        await applyPlatformTemplateStatus({ name: t.name, language: t.language, metaTemplateId: t.id ? String(t.id) : null, status, rejectedReason: t.rejected_reason ?? null, source: "sync" });
        applied++;
      }
      url = resp.paging?.next ?? null;
      params = undefined;
    }
    await audit(req, AuditAction.PLATFORM_WHATSAPP_TEMPLATES_SYNCED, wabaId, { applied });
    res.json({ data: await views() });
  } catch (err) {
    send(res, err);
  }
});

function definitionOr404(eventType: string, lang: string) {
  const d = platformTemplateDefinition(eventType);
  if (!d || (lang !== "he" && lang !== "en")) throw new Refusal("unknown_template", "No such template or language.");
  return { d, lang: lang as TemplateLocale };
}

const editSchema = z.object({ body: z.string().min(1).max(1024) });

router.put("/platform-whatsapp/templates/:eventType/:lang", validate(editSchema), async (req: Request, res: Response) => {
  try {
    const { d, lang } = definitionOr404(String(req.params.eventType), String(req.params.lang));
    if (!d.editable) throw new Refusal("template_not_editable", "Meta writes this template's text; it can only be submitted.");
    const body = String(req.body.body).trim();
    const problem = platformBodyProblem(body, d.parameterCount);
    if (problem) throw new Refusal("template_body_invalid", problem);
    await seedPlatformTemplateRows();
    await db().platformWhatsAppTemplate.update({
      where: { eventType_language: { eventType: d.eventType, language: lang } },
      data: { draftBody: body, updatedBy: actorOf(req) },
    });
    await audit(req, AuditAction.PLATFORM_WHATSAPP_TEMPLATE_EDITED, `${d.eventType}:${lang}`, { name: d.name });
    res.json({ data: await viewOf(d.eventType) });
  } catch (err) {
    send(res, err);
  }
});

/** Meta's components for a create or edit, from code: only the body text is the console's. */
export function platformTemplateComponents(eventType: string, lang: TemplateLocale, body: string): any[] {
  const d = platformTemplateDefinition(eventType)!;
  const he = lang === "he";
  if (d.category === "AUTHENTICATION") {
    return [
      { type: "BODY", add_security_recommendation: true },
      { type: "FOOTER", code_expiration_minutes: 10 },
      { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: he ? "העתקת הקוד" : "Copy code" }] },
    ];
  }
  const out: any[] = [{
    type: "BODY",
    text: body,
    ...(d.parameterCount ? { example: { body_text: [Array.from({ length: d.parameterCount }, (_, i) => (i === 0 ? (he ? "דוגמה" : "example") : "5"))] } } : {}),
  }];
  if (d.buttons.url) {
    const base = resolveAppPublicUrl(process.env).replace(/\/+$/, "");
    // Per language (Frontend, 2026-11-15): /he|en/inbox opens the
    // conversation in the template's language without the locale redirect.
    out.push({ type: "BUTTONS", buttons: [{ type: "URL", text: he ? "פתיחת השיחה" : "Open conversation", url: `${base}/${lang}/inbox?c={{1}}`, example: [`${base}/${lang}/inbox?c=example`] }] });
  }
  if (d.buttons.quickReplies === 2) {
    out.push({ type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: he ? "לאשר" : "Approve" }, { type: "QUICK_REPLY", text: he ? "לדחות" : "Reject" }] });
  }
  return out;
}

router.post("/platform-whatsapp/templates/:eventType/:lang/submit", async (req: Request, res: Response) => {
  try {
    const { d, lang } = definitionOr404(String(req.params.eventType), String(req.params.lang));
    const { token, wabaId } = sendingRow(await readRow());
    await seedPlatformTemplateRows();
    const row: PlatformTemplateRow = await db().platformWhatsAppTemplate.findUnique({ where: { eventType_language: { eventType: d.eventType, language: lang } } });
    const body = d.editable ? (row.draftBody ?? row.body) : row.body;
    if (d.editable) {
      const problem = platformBodyProblem(body, d.parameterCount);
      if (problem) throw new Refusal("template_body_invalid", problem);
    }
    const components = platformTemplateComponents(d.eventType, lang, body);
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    let resp: any;
    try {
      resp = row.metaTemplateId
        ? (await axios.post(`${FB_API_URL}/${row.metaTemplateId}`, { components }, auth)).data
        : (await axios.post(`${FB_API_URL}/${wabaId}/message_templates`, { name: d.name, language: lang, category: d.category, components }, auth)).data;
    } catch (e: any) {
      const m = e?.response?.data?.error;
      const text = String(m?.error_user_msg || m?.message || "");
      if (row.metaTemplateId && /edit/i.test(text) && /(limit|24 hours|30 days|times)/i.test(text)) {
        throw new Refusal("meta_edit_limit", "Meta allows an approved template one edit per 24 hours and 10 per 30 days.", { code: m?.code, message: text });
      }
      throw e;
    }
    const status = metaTemplateStatus(resp?.status) ?? "PENDING";
    await db().platformWhatsAppTemplate.update({
      where: { id: row.id },
      data: {
        body,
        draftBody: null,
        status,
        rejectedReason: null,
        metaTemplateId: resp?.id ? String(resp.id) : row.metaTemplateId,
        submittedAt: new Date(),
        updatedBy: actorOf(req),
      },
    });
    if (status === "REJECTED") {
      await applyPlatformTemplateStatus({ name: d.name, language: lang, metaTemplateId: resp?.id ? String(resp.id) : row.metaTemplateId, status, source: "submit" });
    }
    await audit(req, AuditAction.PLATFORM_WHATSAPP_TEMPLATE_SUBMITTED, `${d.eventType}:${lang}`, { name: d.name, status, edit: !!row.metaTemplateId });
    res.json({ data: await viewOf(d.eventType) });
  } catch (err) {
    send(res, err);
  }
});

// ─── Alert switch ────────────────────────────────────────────

const toggleSchema = z.object({ enabled: z.boolean() });

router.put("/platform-whatsapp/alerts/:eventType", validate(toggleSchema), async (req: Request, res: Response) => {
  try {
    const d = platformTemplateDefinition(String(req.params.eventType));
    if (!d || !d.toggleable) throw new Refusal("unknown_template", "No alert switch by that name.");
    const enabled = req.body.enabled === true;
    const row = await readRow();
    if (enabled) {
      if (!rowCanSend(row)) throw new Refusal("no_platform_number", "Connect the alerts number first.");
      const rows = await seedPlatformTemplateRows();
      if (!bothApproved(rows, d.eventType)) throw new Refusal("template_not_approved", "Both the Hebrew and the English template must be approved by Meta first.");
    }
    const map = enabledMap(row?.alertsEnabled);
    map[d.eventType] = enabled;
    await db().platformWhatsAppSender.upsert({
      where: { id: PLATFORM_SENDER_ID },
      create: { id: PLATFORM_SENDER_ID, alertsEnabled: map },
      update: { alertsEnabled: map },
    });
    await bumpPlatformSenderVersion();
    await audit(req, AuditAction.PLATFORM_WHATSAPP_ALERT_TOGGLED, d.eventType, { enabled });
    res.json({ data: await viewOf(d.eventType) });
  } catch (err) {
    send(res, err);
  }
});

export default router;
