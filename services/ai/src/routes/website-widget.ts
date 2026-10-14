/**
 * The Website widget admin API (docs/api/website-widget-v1.md): one settings
 * object over every place the widget is installed, and the Install state per
 * platform. Read needs channels:manage:read, write channels:manage:update.
 */
import { Router, type Request, type Response } from "express";
import {
  authenticate,
  resolveTenant,
  requireActiveTenant,
  requirePermission,
  requireRole,
  asksToHidePoweredBy,
  POWERED_BY_LOCKED_CODE,
} from "@chatcenter/shared";
import { getWidget, putWidget, installOf, WidgetInputError, type WidgetSettings } from "../services/website-widget.service";
import { readAssignment, writeAssignment, AssignmentError } from "../services/widget-assignment.service";

const router = Router();
router.use(authenticate, resolveTenant, requireActiveTenant());

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** Only the four shared sections, each an object; anything else is dropped (never a 400). */
function patchOf(body: unknown): Partial<WidgetSettings> {
  const out: Partial<WidgetSettings> = {};
  if (!isObj(body)) return out;
  if (isObj(body.appearance)) out.appearance = body.appearance as any;
  if (isObj(body.ux)) out.ux = body.ux as any;
  if (isObj(body.handoff) && typeof body.handoff.allowHumanHandoff === "boolean") out.handoff = { allowHumanHandoff: body.handoff.allowHumanHandoff };
  if (isObj(body.offline) && typeof body.offline.message === "string") out.offline = { message: body.offline.message };
  return out;
}

router.get("/", requirePermission("channels:manage:read"), async (req: Request & { tenantId?: string }, res: Response) => {
  try {
    res.json({ data: await getWidget(req.tenantId!) });
  } catch (err) {
    console.error("[website-widget] get failed:", (err as Error)?.message);
    res.status(500).json({ error: "Could not load the widget" });
  }
});

router.put("/", requirePermission("channels:manage:update"), async (req: Request & { tenantId?: string }, res: Response) => {
  try {
    // "Powered by GOTCHA" stays on (W8): refused, never silently ignored.
    if (asksToHidePoweredBy((req.body as any)?.appearance)) {
      res.status(403).json({ error: "Powered by GOTCHA cannot be turned off", code: POWERED_BY_LOCKED_CODE, field: "appearance.showPoweredBy" });
      return;
    }
    const data = await putWidget(req.tenantId!, patchOf(req.body));
    if (!data) {
      res.status(409).json({ error: "Create the widget first", code: "WIDGET_NOT_CREATED" });
      return;
    }
    res.json({ data });
  } catch (err) {
    if (err instanceof WidgetInputError) {
      const error = err.code === "WHATSAPP_KIND_NEEDS_NUMBER"
        ? "The WhatsApp widget needs Continue on WhatsApp on, with a connected number"
        : "This WhatsApp number is not one of this workspace's";
      res.status(422).json({ error, code: err.code, field: err.field });
      return;
    }
    console.error("[website-widget] put failed:", (err as Error)?.message);
    res.status(500).json({ error: "Could not save the widget" });
  }
});

/**
 * Who answers the widget's channels (§4): read from and written to the
 * playbook, the one place that decides. Role ADMIN, like the playbook editor.
 */
router.get("/assignment", requireRole("ADMIN"), async (req: Request & { tenantId?: string }, res: Response) => {
  try {
    res.json({ data: await readAssignment(req.tenantId!) });
  } catch (err) {
    console.error("[website-widget] assignment read failed:", (err as Error)?.message);
    res.status(500).json({ error: "Could not read who answers the widget" });
  }
});

router.put("/assignment", requireRole("ADMIN"), async (req: Request & { tenantId?: string }, res: Response) => {
  try {
    res.json({ data: await writeAssignment(req.tenantId!, (req as any).user?.userId ?? null, req.body ?? {}) });
  } catch (err) {
    if (err instanceof AssignmentError) {
      const words: Record<string, string> = {
        WIDGET_NOT_CREATED: "Create the widget first",
        EMPLOYEE_NOT_FOUND: "Choose an active employee of this workspace",
        NO_WIDGET_CHANNEL: "None of these channels is one of the widget's",
        PLAYBOOK_CONDITIONAL: "Conditions in the playbook decide who answers this channel: change it in the playbook",
        PLAYBOOK_SHARED: "This also changes who answers other channels",
      };
      res.status(err.status).json({ error: words[err.code] ?? err.code, code: err.code, ...err.extra });
      return;
    }
    console.error("[website-widget] assignment write failed:", (err as Error)?.message);
    res.status(500).json({ error: "Could not change who answers the widget" });
  }
});

router.get("/install", requirePermission("channels:manage:read"), async (req: Request & { tenantId?: string }, res: Response) => {
  try {
    res.json({ data: await installOf(req.tenantId!) });
  } catch (err) {
    console.error("[website-widget] install failed:", (err as Error)?.message);
    res.status(500).json({ error: "Could not load the install state" });
  }
});

export default router;
