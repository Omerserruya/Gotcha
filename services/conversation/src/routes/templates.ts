import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole, decryptCredentials } from "@chatcenter/shared";

const router = Router();

const FB_API_URL = process.env.FACEBOOK_API_URL || "https://graph.facebook.com/v21.0";
const META_APP_ID = process.env.META_APP_ID || process.env.FACEBOOK_APP_ID || "";

/**
 * Upload a media file to Meta via the Resumable Upload API and return the
 * `h` handle suitable for `example.header_handle` on template submission.
 *
 * Two-step protocol:
 *   1. POST /{APP_ID}/uploads?file_name=…&file_length=…&file_type=…   → upload session id
 *   2. POST /{upload-session-id}  with body = file bytes              → handle
 *
 * Returns null (with a console.warn) on any failure so the caller can fall
 * back to submitting without the example — Meta will still reject media
 * templates without it, but the failure is at the Meta layer and surfaced
 * by the existing 400 path rather than throwing here.
 */
async function uploadMediaForTemplateExample(
  url: string,
  accessToken: string,
): Promise<string | null> {
  if (!META_APP_ID) {
    console.warn("[meta-template-upload] META_APP_ID not configured");
    return null;
  }
  try {
    // 1. Download the example file.
    const fileRes = await fetch(url);
    if (!fileRes.ok) {
      console.warn("[meta-template-upload] download failed", url, fileRes.status);
      return null;
    }
    const ab = await fileRes.arrayBuffer();
    const buf = Buffer.from(ab);
    const guessedType = fileRes.headers.get("content-type") || guessMimeFromUrl(url);
    const fileName = (() => {
      try {
        const u = new URL(url);
        const n = u.pathname.split("/").filter(Boolean).pop();
        return n || "example";
      } catch {
        return "example";
      }
    })();

    // 2. Open the upload session.
    const sessionQs = new URLSearchParams({
      file_name: fileName,
      file_length: String(buf.length),
      file_type: guessedType,
      access_token: accessToken,
    });
    const sessRes = await fetch(`${FB_API_URL}/${META_APP_ID}/uploads?${sessionQs.toString()}`, {
      method: "POST",
    });
    const sessJson = (await sessRes.json()) as any;
    if (!sessRes.ok || !sessJson?.id) {
      console.warn("[meta-template-upload] open session failed", sessJson);
      return null;
    }
    const sessionId = String(sessJson.id);

    // 3. Stream the bytes (single chunk — example files are small).
    const upRes = await fetch(`${FB_API_URL}/${sessionId}`, {
      method: "POST",
      headers: {
        Authorization: `OAuth ${accessToken}`,
        file_offset: "0",
      },
      body: buf,
    });
    const upJson = (await upRes.json()) as any;
    if (!upRes.ok || !upJson?.h) {
      console.warn("[meta-template-upload] upload failed", upJson);
      return null;
    }
    return String(upJson.h);
  } catch (err) {
    console.warn("[meta-template-upload] threw:", (err as { message?: string })?.message);
    return null;
  }
}

function guessMimeFromUrl(url: string): string {
  const ext = (url.split("?")[0]?.split(".").pop() || "").toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "mp4") return "video/mp4";
  if (ext === "mov") return "video/quicktime";
  if (ext === "pdf") return "application/pdf";
  return "application/octet-stream";
}

async function resolveWabaCreds(tenantId: string, template: { channelAccountId: string | null }) {
  const channelAccount = template.channelAccountId
    ? await prisma.channelAccount.findFirst({
        where: {
          id: template.channelAccountId,
          tenantId,
          channel: "WHATSAPP",
          isActive: true,
          connectionStatus: "CONNECTED",
        },
      })
    : await prisma.channelAccount.findFirst({
        where: { tenantId, channel: "WHATSAPP", isActive: true, connectionStatus: "CONNECTED" },
      });
  if (!channelAccount) return { error: "No connected WhatsApp channel found for this template" as const };
  const creds = decryptCredentials(channelAccount.credentials as any);
  const accessToken = creds?.accessToken;
  const wabaId = creds?.wabaId;
  if (!accessToken || !wabaId) return { error: "WhatsApp channel missing credentials" as const };
  return { channelAccount, accessToken, wabaId };
}

async function deleteMetaTemplate(wabaId: string, accessToken: string, name: string, hsmId?: string | null) {
  const qs = new URLSearchParams({ name });
  if (hsmId) qs.set("hsm_id", hsmId);
  const url = `${FB_API_URL}/${wabaId}/message_templates?${qs.toString()}`;
  const res = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } });
  const data: any = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function normalizeMetaName(raw: string): string {
  return (raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 512);
}

/** Extract `{{var}}` placeholder keys from a Meta template text in order
 *  of appearance. Duplicates are collapsed (Meta wants one example per
 *  unique placeholder). */
function extractPlaceholders(text: string): string[] {
  const re = /\{\{\s*([\w-]+)\s*\}\}/g;
  const seen = new Set<string>();
  const order: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const key = m[1];
    if (!seen.has(key)) {
      seen.add(key);
      order.push(key);
    }
  }
  return order;
}

/** Build the Meta `example` object for a component that contains placeholders.
 *  Picks positional format when the placeholders are all numeric ({{1}}),
 *  named-params format otherwise ({{first_name}}). */
function buildExample(
  text: string,
  declaredVariables: Array<{ key?: string; sample?: string }> | undefined,
  scope: "header" | "body",
): Record<string, unknown> | null {
  const keys = extractPlaceholders(text);
  if (keys.length === 0) return null;

  const sampleByKey = new Map<string, string>();
  if (Array.isArray(declaredVariables)) {
    for (const v of declaredVariables) {
      if (v && typeof v.key === "string") {
        sampleByKey.set(v.key, v.sample && String(v.sample).trim() ? String(v.sample) : `sample_${v.key}`);
      }
    }
  }
  const sampleFor = (key: string): string =>
    sampleByKey.get(key) || (/^\d+$/.test(key) ? `sample_${key}` : `sample_${key}`);

  const allNumeric = keys.every((k) => /^\d+$/.test(k));

  if (allNumeric) {
    // Positional: {{1}}, {{2}} → example.body_text = [[v1, v2]] (or header_text = [v1, ...]).
    const sortedKeys = [...keys].sort((a, b) => Number(a) - Number(b));
    const values = sortedKeys.map((k) => sampleFor(k));
    if (scope === "header") return { header_text: values };
    return { body_text: [values] };
  }

  // Named params (newer Meta format).
  const namedParams = keys.map((k) => ({ param_name: k, example: sampleFor(k) }));
  if (scope === "header") return { header_text_named_params: namedParams };
  return { body_text_named_params: namedParams };
}

function buildMetaComponents(template: any, mediaHeaderHandle?: string | null) {
  const components: any[] = [];
  const declaredVars = Array.isArray(template.variables) ? template.variables : [];

  if (template.headerType && template.headerType !== "NONE") {
    if (template.headerType === "TEXT") {
      const headerText = template.headerContent || "";
      const headerExample = buildExample(headerText, declaredVars, "header");
      components.push({
        type: "HEADER",
        format: "TEXT",
        text: headerText,
        ...(headerExample ? { example: headerExample } : {}),
      });
    } else {
      // MEDIA headers — Meta requires example.header_handle with a handle
      // from the Resumable Upload API. The caller uploads the example URL
      // (stored on the template's headerContent) before calling us and
      // passes the resulting handle here.
      components.push({
        type: "HEADER",
        format: template.headerType,
        ...(mediaHeaderHandle ? { example: { header_handle: [mediaHeaderHandle] } } : {}),
      });
    }
  }

  const bodyText = template.body || "";
  const bodyExample = buildExample(bodyText, declaredVars, "body");
  components.push({
    type: "BODY",
    text: bodyText,
    ...(bodyExample ? { example: bodyExample } : {}),
  });

  if (template.footer) components.push({ type: "FOOTER", text: template.footer });

  // BUTTONS — Meta accepts up to 3 buttons in a template. QUICK_REPLY is
  // the common case for "tap to re-open the 24h window" flows; URL and
  // PHONE_NUMBER are also supported. Mixed types are NOT allowed: all
  // QUICK_REPLY OR all URL/PHONE_NUMBER (Meta enforces this and will
  // reject mixed sets at registration time).
  const rawButtons = Array.isArray(template.buttons) ? template.buttons : [];
  const buttons = rawButtons
    .filter((b: any) => b && typeof b === "object" && typeof b.text === "string" && b.text.trim())
    .slice(0, 3)
    .map((b: any) => {
      const text = String(b.text).trim();
      const type = String(b.type || "QUICK_REPLY").toUpperCase();
      if (type === "URL") {
        return { type: "URL", text, url: String(b.url || "").trim() };
      }
      if (type === "PHONE_NUMBER" || type === "PHONE") {
        return { type: "PHONE_NUMBER", text, phone_number: String(b.phoneNumber || b.phone_number || "").trim() };
      }
      return { type: "QUICK_REPLY", text };
    });
  if (buttons.length > 0) {
    components.push({ type: "BUTTONS", buttons });
  }
  return components;
}

router.get("/", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const { channel, channelAccountId, status, category, page, limit } = req.query;
    const pageNum = page ? parseInt(page as string, 10) : 1;
    const limitNum = limit ? parseInt(limit as string, 10) : 50;
    const skip = (pageNum - 1) * limitNum;

    const where: any = { tenantId: req.tenantId! as string };
    if (channel) where.channel = channel;
    if (channelAccountId) where.channelAccountId = channelAccountId;
    if (status) where.status = status;
    if (category) where.category = category;

    const [items, total] = await Promise.all([
      prisma.messageTemplate.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip,
        take: limitNum,
      }),
      prisma.messageTemplate.count({ where }),
    ]);

    res.json({ data: items, total, page: pageNum, limit: limitNum });
  } catch (err) {
    console.error("List templates error:", err);
    res.status(500).json({ error: "Failed to list templates" });
  }
});

router.get("/:id", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const template = await prisma.messageTemplate.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! as string },
    });
    if (!template) { res.status(404).json({ error: "Template not found" }); return; }
    res.json({ data: template });
  } catch (err) {
    console.error("Get template error:", err);
    res.status(500).json({ error: "Failed to get template" });
  }
});

router.post("/", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const {
      name,
      body,
      category = "general",
      language = "en",
      channel,
      channelAccountId,
      headerType,
      headerContent,
      footer,
      buttons = [],
      variables = [],
      status = "DRAFT",
    } = req.body;

    if (!name || !body) {
      res.status(400).json({ error: "name and body are required" });
      return;
    }

    let resolvedChannel: string | null = channel ?? null;
    if (channelAccountId) {
      const account = await prisma.channelAccount.findFirst({
        where: { id: channelAccountId, tenantId: req.tenantId! as string },
      });
      if (!account) {
        res.status(400).json({ error: "Invalid channelAccountId" });
        return;
      }
      resolvedChannel = account.channel;
    }

    const template = await prisma.messageTemplate.create({
      data: {
        tenantId: req.tenantId! as string,
        name,
        body,
        category,
        language,
        channel: (resolvedChannel as any) ?? null,
        channelAccountId: channelAccountId ?? null,
        headerType: headerType ?? null,
        headerContent: headerContent ?? null,
        footer: footer ?? null,
        buttons,
        variables,
        status,
      },
    });

    res.status(201).json({ data: template });
  } catch (err) {
    console.error("Create template error:", err);
    res.status(500).json({ error: "Failed to create template" });
  }
});

router.patch("/:id", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const existing = await prisma.messageTemplate.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! as string },
    });
    if (!existing) { res.status(404).json({ error: "Template not found" }); return; }

    const data: any = { ...req.body };
    // The UI sends "" when the picker is cleared; only null is valid as
    // "unset" for the FK column. Treat both as detach.
    if (data.channelAccountId === "" || data.channelAccountId === undefined) {
      // Leave the field alone if the caller didn't touch it; explicitly clear
      // when they sent "".
      if (Object.prototype.hasOwnProperty.call(req.body, "channelAccountId") && data.channelAccountId === "") {
        data.channelAccountId = null;
      } else {
        delete data.channelAccountId;
      }
    } else if (data.channelAccountId) {
      const account = await prisma.channelAccount.findFirst({
        where: { id: data.channelAccountId, tenantId: req.tenantId! as string },
      });
      if (!account) {
        res.status(400).json({ error: "Invalid channelAccountId" });
        return;
      }
      data.channel = account.channel;
    }

    const template = await prisma.messageTemplate.update({
      where: { id: existing.id },
      data,
    });

    res.json({ data: template });
  } catch (err) {
    console.error("Update template error:", err);
    res.status(500).json({ error: "Failed to update template" });
  }
});

router.delete("/:id", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const existing = await prisma.messageTemplate.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! as string },
    });
    if (!existing) { res.status(404).json({ error: "Template not found" }); return; }

    const broadcastCount = await prisma.broadcast.count({
      where: { tenantId: req.tenantId! as string, templateId: existing.id },
    });
    if (broadcastCount > 0 && req.query.force !== "true") {
      res.status(409).json({ error: "Template is used by one or more broadcasts and cannot be deleted. Add ?force=true to force delete." });
      return;
    }

    // Unlink broadcasts before deleting
    if (broadcastCount > 0) {
      await prisma.broadcast.updateMany({
        where: { tenantId: req.tenantId! as string, templateId: existing.id },
        data: { templateId: null },
      });
    }

    // Cascade delete on Meta for WhatsApp templates that have been submitted
    let metaDeleteResult: any = null;
    if (existing.channel === "WHATSAPP" && existing.status !== "DRAFT") {
      try {
        const resolved = await resolveWabaCreds(req.tenantId! as string, existing);
        if (!("error" in resolved)) {
          const metaName = normalizeMetaName(existing.name);
          const del = await deleteMetaTemplate(resolved.wabaId, resolved.accessToken, metaName, existing.metaTemplateId);
          metaDeleteResult = { ok: del.ok, status: del.status };
          if (!del.ok && del.status !== 404) {
            console.warn("[delete template] Meta delete non-ok:", del.status, del.data);
          }
        }
      } catch (metaErr) {
        console.error("[delete template] Meta delete threw:", metaErr);
      }
    }

    await prisma.messageTemplate.delete({ where: { id: existing.id } });

    res.json({ data: { deleted: true, id: existing.id, meta: metaDeleteResult } });
  } catch (err) {
    console.error("Delete template error:", err);
    res.status(500).json({ error: "Failed to delete template" });
  }
});

router.post("/:id/duplicate", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const original = await prisma.messageTemplate.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! as string },
    });
    if (!original) { res.status(404).json({ error: "Template not found" }); return; }

    const copy = await prisma.messageTemplate.create({
      data: {
        tenantId: req.tenantId! as string,
        name: `${original.name} (Copy)`,
        body: original.body,
        category: original.category,
        language: original.language,
        channel: original.channel ?? null,
        headerType: original.headerType ?? null,
        headerContent: original.headerContent ?? null,
        footer: original.footer ?? null,
        buttons: original.buttons as any,
        variables: original.variables as any,
        status: "DRAFT",
      },
    });

    res.status(201).json({ data: copy });
  } catch (err) {
    console.error("Duplicate template error:", err);
    res.status(500).json({ error: "Failed to duplicate template" });
  }
});

// ─── Submit Template to Meta ────────────────────────────────
router.post("/:id/submit-to-meta", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const template = await prisma.messageTemplate.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! as string },
    });
    if (!template) { res.status(404).json({ error: "Template not found" }); return; }

    if (template.status !== "DRAFT" && template.status !== "REJECTED") {
      res.status(400).json({ error: "Only DRAFT or REJECTED templates can be submitted to Meta" });
      return;
    }

    if (template.channel !== "WHATSAPP") {
      res.status(400).json({ error: "Only WhatsApp templates can be submitted to Meta" });
      return;
    }

    const resolved = await resolveWabaCreds(req.tenantId! as string, template);
    if ("error" in resolved) { res.status(400).json({ error: resolved.error }); return; }
    const { accessToken, wabaId } = resolved;

    const metaName = normalizeMetaName(template.name);
    if (!metaName) {
      res.status(400).json({ error: "Template name must contain at least one letter or digit" });
      return;
    }

    // For REJECTED resubmit: delete the existing rejected template on Meta so we can re-create with the same name
    if (template.status === "REJECTED") {
      const del = await deleteMetaTemplate(wabaId, accessToken, metaName, template.metaTemplateId);
      if (!del.ok && del.status !== 404) {
        console.warn("[submit-to-meta] prior delete non-ok:", del.status, del.data);
      }
    }

    // Media-header templates need an example handle. Upload the example
    // file (stored on headerContent for IMAGE/VIDEO/DOCUMENT) to Meta's
    // Resumable Upload API before assembling the components.
    let mediaHeaderHandle: string | null = null;
    if (
      template.headerType &&
      template.headerType !== "NONE" &&
      template.headerType !== "TEXT"
    ) {
      const exampleUrl = (template.headerContent || "").trim();
      if (!exampleUrl) {
        res.status(400).json({
          error: `An example media URL is required for ${template.headerType} header templates`,
        });
        return;
      }
      mediaHeaderHandle = await uploadMediaForTemplateExample(exampleUrl, accessToken);
      if (!mediaHeaderHandle) {
        res.status(400).json({
          error:
            "Failed to upload example media to Meta. Verify the URL is publicly reachable and the file format is supported.",
        });
        return;
      }
    }

    const metaPayload = {
      name: metaName,
      category: (template.category || "UTILITY").toUpperCase(),
      language: template.language || "en",
      components: buildMetaComponents(template, mediaHeaderHandle),
    };

    const metaRes = await fetch(`${FB_API_URL}/${wabaId}/message_templates`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(metaPayload),
    });

    const metaData: any = await metaRes.json();

    if (!metaRes.ok) {
      console.error("Meta template submission error:", metaData);
      res.status(400).json({
        error: metaData.error?.message || "Failed to submit template to Meta",
        metaError: metaData.error,
      });
      return;
    }

    const updated = await prisma.messageTemplate.update({
      where: { id: template.id },
      data: {
        status: "PENDING_APPROVAL",
        name: metaName,
        rejectionReason: null,
        metaTemplateId: metaData?.id ? String(metaData.id) : template.metaTemplateId,
      },
    });

    res.json({ data: updated, meta: metaData });
  } catch (err) {
    console.error("Submit template to Meta error:", err);
    res.status(500).json({ error: "Failed to submit template to Meta" });
  }
});

export default router;
