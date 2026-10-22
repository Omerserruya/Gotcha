/**
 * A channel's HTML email template: read, save, test (2026-10-22).
 *
 * Mounted inside the channels router, so it lives at
 * /api/channels/:channelAccountId/email-template. Stored as a durable tenant
 * setting (`emailTemplate:<channelAccountId>`), sanitized on save, applied
 * where email leaves (packages/shared/src/channels/email-template-apply.ts).
 *
 * Contract (agreed with Frontend):
 *   GET  -> { enabled, html, updatedAt }
 *   PUT  { enabled, html? } -> { enabled, html, updatedAt, removed }
 *        422 EMAIL_TEMPLATE_TOO_LARGE {max} | EMAIL_TEMPLATE_CONTENT_PLACEHOLDER_MISSING | EMAIL_TEMPLATE_NOT_SET
 *   POST .../test (no body, no recipient: the signed-in user's own address)
 *        -> { sentTo } | 422 EMAIL_TEMPLATE_NOT_SET | 409 EMAIL_TEMPLATE_CHANNEL_NOT_CONNECTED
 *        | 502 EMAIL_TEMPLATE_TEST_SEND_FAILED {detail}
 *   404 CHANNEL_NOT_FOUND / EMAIL_TEMPLATE_NOT_EMAIL_CHANNEL
 */
import crypto from "crypto";
import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  prisma,
  authenticate,
  resolveTenant,
  requirePermission,
  readDurableSetting,
  writeDurableSetting,
  writeAudit,
  decryptCredentials,
  getOutboundAdapter,
  emailTemplateKey,
  parseStoredEmailTemplate,
  prepareEmailTemplate,
  type StoredEmailTemplate,
} from "@chatcenter/shared";

const EMAIL_CHANNELS = new Set(["EMAIL", "GMAIL", "OUTLOOK"]);

const router = Router();

/** The tenant's email channel account, or the error response already sent. */
async function emailAccount(req: Request, res: Response) {
  const account = await prisma.channelAccount.findFirst({
    where: { id: String(req.params.channelAccountId), tenantId: req.tenantId! },
    select: { id: true, tenantId: true, channel: true, externalId: true, isActive: true, connectionStatus: true, credentials: true },
  });
  if (!account) {
    res.status(404).json({ error: "CHANNEL_NOT_FOUND" });
    return null;
  }
  if (!EMAIL_CHANNELS.has(account.channel)) {
    res.status(404).json({ error: "EMAIL_TEMPLATE_NOT_EMAIL_CHANNEL" });
    return null;
  }
  return account;
}

async function readTemplate(tenantId: string, channelAccountId: string): Promise<StoredEmailTemplate | null> {
  return parseStoredEmailTemplate(await readDurableSetting(tenantId, emailTemplateKey(channelAccountId)));
}

function view(t: StoredEmailTemplate | null) {
  return t ? { enabled: t.enabled, html: t.html, updatedAt: t.updatedAt } : { enabled: false, html: null, updatedAt: null };
}

router.get(
  "/:channelAccountId/email-template",
  authenticate, resolveTenant, requirePermission("channels:manage:read"),
  async (req: Request, res: Response) => {
    try {
      const account = await emailAccount(req, res);
      if (!account) return;
      res.json(view(await readTemplate(account.tenantId, account.id)));
    } catch (err: any) {
      console.error("[email-template] read failed:", err?.message);
      res.status(500).json({ error: "EMAIL_TEMPLATE_READ_FAILED" });
    }
  },
);

const putSchema = z.object({ enabled: z.boolean(), html: z.string().optional() }).strict();

router.put(
  "/:channelAccountId/email-template",
  authenticate, resolveTenant, requirePermission("channels:manage:update"),
  async (req: Request, res: Response) => {
    const parsed = putSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() });
      return;
    }
    try {
      const account = await emailAccount(req, res);
      if (!account) return;
      const current = await readTemplate(account.tenantId, account.id);

      let html: string;
      let removed: string[] = [];
      if (parsed.data.html !== undefined) {
        const prepared = prepareEmailTemplate(parsed.data.html);
        if (!prepared.ok) {
          res.status(422).json({ error: prepared.error.code, ...("max" in prepared.error ? { max: prepared.error.max } : {}) });
          return;
        }
        html = prepared.html;
        removed = prepared.removed;
      } else if (current) {
        html = current.html;
      } else {
        // Nothing stored and nothing sent: only "off" is meaningful.
        if (parsed.data.enabled) {
          res.status(422).json({ error: "EMAIL_TEMPLATE_NOT_SET" });
          return;
        }
        res.json({ ...view(null), removed });
        return;
      }

      const next: StoredEmailTemplate = {
        html,
        enabled: parsed.data.enabled,
        updatedAt: new Date().toISOString(),
        updatedBy: req.user?.userId ?? null,
      };
      await writeDurableSetting(account.tenantId, emailTemplateKey(account.id), JSON.stringify(next), req.user?.userId);

      // Every change is audited: who, what state, and a fingerprint of the
      // html (not the html itself - it can be 100 KB and is in the setting).
      void writeAudit({
        tenantId: account.tenantId, actorType: "user", actorId: req.user?.userId ?? null,
        action: "channel.email_template_updated", targetType: "channel_account", targetId: account.id,
        metadata: {
          channel: account.channel,
          enabled: next.enabled,
          wasEnabled: current?.enabled ?? null,
          htmlChanged: parsed.data.html !== undefined,
          bytes: Buffer.byteLength(html, "utf8"),
          sha256: crypto.createHash("sha256").update(html).digest("hex"),
          removed,
        },
      });

      res.json({ ...view(next), removed });
    } catch (err: any) {
      console.error("[email-template] save failed:", err?.message);
      res.status(500).json({ error: "EMAIL_TEMPLATE_SAVE_FAILED" });
    }
  },
);

const SAMPLE_TEXT = [
  "Hi,",
  "",
  // No placeholder syntax in here: this text IS the content, and inserted
  // content is never re-read for placeholders, so "{{content}}" would arrive
  // literally (it did, in the first live test on 2026-10-22).
  "This is a test of your email template. Your real replies will appear here, inside the template, where the message goes.",
  "",
  "Thanks!",
].join("\n");

router.post(
  "/:channelAccountId/email-template/test",
  authenticate, resolveTenant, requirePermission("channels:manage:update"),
  async (req: Request, res: Response) => {
    try {
      const account = await emailAccount(req, res);
      if (!account) return;
      const stored = await readTemplate(account.tenantId, account.id);
      if (!stored) {
        res.status(422).json({ error: "EMAIL_TEMPLATE_NOT_SET" });
        return;
      }
      if (!account.isActive || account.connectionStatus === "DISCONNECTED") {
        res.status(409).json({ error: "EMAIL_TEMPLATE_CHANNEL_NOT_CONNECTED" });
        return;
      }
      // Only ever the caller's own address: the test cannot be aimed at anyone.
      const me = req.user?.userId
        ? await prisma.user.findUnique({ where: { id: req.user.userId }, select: { email: true, name: true } })
        : null;
      if (!me?.email) {
        res.status(422).json({ error: "EMAIL_TEMPLATE_NO_SENDER_ADDRESS" });
        return;
      }
      const adapter = getOutboundAdapter(account.channel as any);
      if (!adapter) {
        res.status(409).json({ error: "EMAIL_TEMPLATE_CHANNEL_NOT_CONNECTED" });
        return;
      }
      const raw = account.credentials as unknown;
      const credentials = (typeof raw === "string" ? decryptCredentials(raw) : raw) as any;

      let externalId: string | null = null;
      let detail = "The provider refused the message.";
      try {
        // Through the same wrapped adapter real sends use, with the stored
        // template forced on, so the test shows exactly what customers get.
        externalId = await adapter.sendTextMessage(credentials, account.externalId, me.email, SAMPLE_TEXT, undefined, {
          subject: "Test: your email template",
          templateOverride: stored.html,
          senderName: me.name || undefined,
          customerName: "Sample customer",
        });
      } catch (err: any) {
        detail = String(err?.message || detail).slice(0, 300);
      }
      void writeAudit({
        tenantId: account.tenantId, actorType: "user", actorId: req.user?.userId ?? null,
        action: "channel.email_template_test_sent", targetType: "channel_account", targetId: account.id,
        metadata: { channel: account.channel, ok: Boolean(externalId) },
      });
      if (!externalId) {
        res.status(502).json({ error: "EMAIL_TEMPLATE_TEST_SEND_FAILED", detail });
        return;
      }
      res.json({ sentTo: me.email });
    } catch (err: any) {
      console.error("[email-template] test send failed:", err?.message);
      res.status(500).json({ error: "EMAIL_TEMPLATE_TEST_FAILED" });
    }
  },
);

/** Drop a deleted channel account's template (tenant-scoped). */
export async function deleteEmailTemplateFor(tenantId: string, channelAccountId: string): Promise<void> {
  await writeDurableSetting(tenantId, emailTemplateKey(channelAccountId), null);
}

export default router;
