import { Router, Request, Response } from "express";
import {
  authenticate,
  resolveTenant,
  requireActiveTenant,
  previewAudience,
  resolveAudience,
  getConnectedCrm,
  getCrmSchema,
  type AudienceDefinition,
  type CrmFieldDef,
} from "@chatcenter/shared";

/**
 * Audience API for outbound + broadcast targeting.
 *
 *   POST /api/audiences/preview   { audience }
 *     Returns: { recipients, total, truncated, reasoning }
 *     The UI calls this after every change to the audience builder so
 *     the operator sees how many people will be reached.
 *
 *   POST /api/audiences/resolve   { audience, limit? }
 *     Returns the full (or `limit`-capped) recipient list. Used by the
 *     broadcast send worker just before fan-out, and by the audience
 *     "Preview list" expand action in the UI.
 *
 * Both endpoints reuse the shared resolver in `@chatcenter/shared/lib/audience.ts`,
 * so any caller (broadcast, outbound campaign, future workflow) gets the
 * same recipient set for the same definition.
 */

const router = Router();
router.use(authenticate, resolveTenant, requireActiveTenant());

router.post("/preview", async (req: Request, res: Response) => {
  try {
    const audience = parseAudience(req.body?.audience);
    if (!audience) {
      res.status(400).json({ error: "audience body required (type: 'manual'|'filter'|'saved')" });
      return;
    }
    const result = await previewAudience(req.tenantId!, audience);
    res.json({ data: result });
  } catch (err: any) {
    console.error("audiences.preview error:", err);
    res.status(500).json({ error: "Failed to preview audience" });
  }
});

/**
 * Schema discovery for the audience builder. Returns CRM fields only —
 * the platform's local Contact fields are not surfaced here anymore (the
 * platform contact table is a write-side cache, not a source of truth
 * for audience targeting).
 *
 *   GET /api/audiences/schema?module=leads|contacts|accounts|deals
 *
 * The `local` field block is preserved in the response shape (always
 * empty) to keep older clients that destructure `data.local.fields`
 * from crashing.
 */
router.get("/schema", async (req: Request, res: Response) => {
  try {
    const module = (String(req.query.module || "leads").toLowerCase()) as
      "leads" | "contacts" | "accounts" | "deals";

    const conn = await getConnectedCrm(req.tenantId!);
    let crmSchema = null as Awaited<ReturnType<typeof getCrmSchema>> | null;
    if (conn) {
      crmSchema = await getCrmSchema(req.tenantId!, module);
    }

    const _unusedLocalFields: CrmFieldDef[] = [];
    void _unusedLocalFields;

    res.json({
      data: {
        module,
        // Empty-but-present for client back-compat; the audience builder
        // and var picker now read from `crm.schema.fields` only.
        local: { fields: [] as CrmFieldDef[], scope: "platform" },
        crm: conn
          ? {
              connected: true,
              provider: { slug: conn.slug, name: conn.name },
              schema: crmSchema, // null when scope missing or fetch failed
            }
          : { connected: false },
      },
    });
  } catch (err: any) {
    console.error("audiences.schema error:", err);
    res.status(500).json({ error: "Failed to load audience schema" });
  }
});

router.post("/resolve", async (req: Request, res: Response) => {
  try {
    const audience = parseAudience(req.body?.audience);
    if (!audience) {
      res.status(400).json({ error: "audience body required (type: 'manual'|'filter'|'saved')" });
      return;
    }
    const limit = typeof req.body?.limit === "number" ? req.body.limit : 1000;
    const result = await resolveAudience(req.tenantId!, audience, { previewLimit: limit });
    res.json({ data: result });
  } catch (err: any) {
    console.error("audiences.resolve error:", err);
    res.status(500).json({ error: "Failed to resolve audience" });
  }
});

function parseAudience(raw: unknown): AudienceDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as any;
  const module = parseModule(a.module);
  const crmContacts = parseCrmContacts(a.crmContacts);
  if (a.type === "manual" && Array.isArray(a.contactIds)) {
    return {
      type: "manual",
      contactIds: a.contactIds.map(String),
      ...(crmContacts.length > 0 && { crmContacts }),
    };
  }
  if (a.type === "filter" && a.rules && (Array.isArray(a.rules.all) || Array.isArray(a.rules.any))) {
    return {
      type: "filter",
      rules: {
        all: Array.isArray(a.rules.all) ? a.rules.all : undefined,
        any: Array.isArray(a.rules.any) ? a.rules.any : undefined,
      },
      ...(module ? { module } : {}),
    };
  }
  if (a.type === "saved" && typeof a.audienceId === "string") {
    return { type: "saved", audienceId: a.audienceId };
  }
  if (a.type === "composite") {
    const rules = a.rules && (Array.isArray(a.rules.all) || Array.isArray(a.rules.any))
      ? {
          all: Array.isArray(a.rules.all) ? a.rules.all : undefined,
          any: Array.isArray(a.rules.any) ? a.rules.any : undefined,
        }
      : undefined;
    return {
      type: "composite",
      contactIds: Array.isArray(a.contactIds) ? a.contactIds.map(String) : undefined,
      ...(crmContacts.length > 0 && { crmContacts }),
      rules,
      everyone: a.everyone === true,
      channel: typeof a.channel === "string" ? a.channel : undefined,
      ...(module ? { module } : {}),
    };
  }
  return null;
}

function parseCrmContacts(
  raw: unknown,
): Array<{ id: string; displayName?: string; phone?: string; email?: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: string; displayName?: string; phone?: string; email?: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const id = (item as any).id;
    if (typeof id !== "string" || !id) continue;
    out.push({
      id,
      displayName: typeof (item as any).displayName === "string" ? (item as any).displayName : undefined,
      phone: typeof (item as any).phone === "string" ? (item as any).phone : undefined,
      email: typeof (item as any).email === "string" ? (item as any).email : undefined,
    });
  }
  return out;
}

function parseModule(raw: unknown): "leads" | "contacts" | "accounts" | "deals" | undefined {
  if (typeof raw !== "string") return undefined;
  const m = raw.toLowerCase();
  return m === "leads" || m === "contacts" || m === "accounts" || m === "deals" ? m : undefined;
}

export default router;
