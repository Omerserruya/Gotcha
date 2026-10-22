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
import { getWidget, putWidget, installOf, WidgetInputError, connectedWooStore, type WidgetSettings } from "../services/website-widget.service";
import { storeCoupons, personalCouponIds } from "../services/widget-promotions.service";
import { resolveWooCurrency } from "../services/discovery-integration.service";
import { readAssignment, writeAssignment, AssignmentError } from "../services/widget-assignment.service";

const router = Router();
router.use(authenticate, resolveTenant, requireActiveTenant());

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** Only the shared sections (and the web chat's commerce), each an object; anything else is dropped (never a 400). */
function patchOf(body: unknown): Partial<WidgetSettings> {
  const out: Partial<WidgetSettings> = {};
  if (!isObj(body)) return out;
  if (isObj(body.appearance)) out.appearance = body.appearance as any;
  if (isObj(body.ux)) out.ux = body.ux as any;
  if (isObj(body.handoff) && typeof body.handoff.allowHumanHandoff === "boolean") out.handoff = { allowHumanHandoff: body.handoff.allowHumanHandoff };
  if (isObj(body.offline) && typeof body.offline.message === "string") out.offline = { message: body.offline.message };
  // The website widget's products (W9); normalised against the stored value.
  if (isObj(body.commerce)) out.commerce = body.commerce as any;
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
    // A coupon that belongs to someone (email-restricted, or single-use like a
    // customer's store credit) is never published as a widget deal.
    const chosen = (req.body as any)?.commerce?.promotions?.couponIds;
    if (Array.isArray(chosen) && chosen.length) {
      const ids = chosen.map((v: unknown) => String(v ?? "").trim());
      const personal = await personalCouponIds(req.tenantId!, ids);
      if (personal === null) {
        res.status(502).json({ error: "The store's coupons could not be read to check them", code: "STORE_UNREACHABLE" });
        return;
      }
      if (personal.length) {
        res.status(400).json({ error: "These coupons belong to a customer and cannot be shown on the widget", code: "COUPON_PERSONAL", couponIds: personal });
        return;
      }
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
 * GET /promotions/available?page=1 - the store's coupons for the settings
 * picker (W9 phase d): { connected, coupons: [{ id, code, amount,
 * discountType, expiresAt, minimumAmount, status, usageCount, usageLimit,
 * live }] }, up to 100 a page. `live` = would show on the widget now.
 * connected:false when there is no connected WooCommerce store.
 */
router.get("/promotions/available", requirePermission("channels:manage:read"), async (req: Request & { tenantId?: string }, res: Response) => {
  try {
    if (!(await connectedWooStore(req.tenantId!))) {
      res.json({ data: { connected: false, coupons: [] } });
      return;
    }
    const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
    const coupons = await storeCoupons(req.tenantId!, page);
    if (!coupons) {
      res.status(502).json({ error: "The store's coupons could not be read", code: "STORE_UNREACHABLE" });
      return;
    }
    // The store's currency, for "₪20 off" (null when unknown, never guessed).
    const { currency } = await resolveWooCurrency(req.tenantId!).catch(() => ({ currency: undefined }));
    res.json({ data: { connected: true, currency: currency ?? null, coupons } });
  } catch (err) {
    console.error("[website-widget] promotions list failed:", (err as Error)?.message);
    res.status(500).json({ error: "Could not list the store's coupons" });
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
