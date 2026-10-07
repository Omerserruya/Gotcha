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
} from "@chatcenter/shared";
import { getWidget, putWidget, installOf, type WidgetSettings } from "../services/website-widget.service";

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
    const data = await putWidget(req.tenantId!, patchOf(req.body));
    if (!data) {
      res.status(409).json({ error: "Create the widget first", code: "WIDGET_NOT_CREATED" });
      return;
    }
    res.json({ data });
  } catch (err) {
    console.error("[website-widget] put failed:", (err as Error)?.message);
    res.status(500).json({ error: "Could not save the widget" });
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
