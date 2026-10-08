/**
 * "GOTCHA for WooCommerce" (docs/api/woocommerce-plugin-v1.md).
 *
 *   POST   /api/woocommerce-plugin/bind      (authenticated: connect systems)
 *   POST   /api/woocommerce-plugin/exchange  (the store's server; the one-time code is the credential)
 *   POST   /api/woocommerce-plugin/signal    (the store's server; Bearer site key)
 *   DELETE /api/woocommerce-plugin/sites/:id (authenticated: disconnect systems)
 *   GET    /api/woocommerce-plugin/download  (authenticated: connect systems) → the zip
 */
import { Router, type Request, type Response } from "express";
import express from "express";
import fs from "fs";
import path from "path";
import { authenticate, resolveTenant, requireOnboardingOrActiveTenant, requirePermission, resolveAppPublicUrl } from "@chatcenter/shared";
import { bindSite, exchangeCode, signal, removeSite, PluginError } from "../services/woocommerce-plugin.service";
import { zipStored } from "../lib/zip";

const router = Router();
const canConnect = requirePermission("integrations:connections:connect", "business-systems:connections:connect");
const canDisconnect = requirePermission("integrations:connections:disconnect", "business-systems:connections:manage");
const authed = [authenticate, resolveTenant, requireOnboardingOrActiveTenant()];

export const PLUGIN_SLUG = "gotcha-for-woocommerce";
export const PLUGIN_DIR = path.join(__dirname, "..", "assets", "woocommerce-plugin", PLUGIN_SLUG);

const WORDS: Record<string, string> = {
  STORE_NOT_CONNECTED: "Connect this store to the workspace first",
  BAD_RETURN_URL: "The plugin's address is not on this store",
  BAD_NONCE: "The connection link is not valid; press Connect again in WordPress",
  WIDGET_NOT_CREATED: "Create the website chat first",
  CODE_EXPIRED: "This connection has expired; press Connect again in WordPress",
  SITE_MISMATCH: "This connection belongs to another site",
  UNKNOWN_SITE: "This site is not connected",
  UNKNOWN_EVENT: "Unknown event",
};

function fail(res: Response, err: unknown, what: string): void {
  if (err instanceof PluginError) {
    res.status(err.status).json({ error: WORDS[err.code] ?? err.code, code: err.code });
    return;
  }
  console.error(`[woocommerce-plugin] ${what} failed:`, (err as Error)?.message);
  res.status(500).json({ error: "Something went wrong" });
}

router.post("/bind", express.json(), ...authed, canConnect, async (req: Request & { tenantId?: string }, res: Response) => {
  try {
    res.json({ data: await bindSite(req.tenantId!, req.body ?? {}) });
  } catch (err) { fail(res, err, "bind"); }
});

router.post("/exchange", express.json(), async (req: Request, res: Response) => {
  try {
    res.json(await exchangeCode(req.body ?? {}, resolveAppPublicUrl(process.env)));
  } catch (err) { fail(res, err, "exchange"); }
});

router.post("/signal", express.json(), async (req: Request, res: Response) => {
  try {
    await signal(req.headers.authorization, req.body ?? {});
    res.status(204).end();
  } catch (err) { fail(res, err, "signal"); }
});

router.delete("/sites/:id", ...authed, canDisconnect, async (req: Request & { tenantId?: string }, res: Response) => {
  try {
    const ok = await removeSite(req.tenantId!, String(req.params.id), (req as any).user?.userId ?? null);
    if (!ok) { res.status(404).json({ error: "Site not found", code: "SITE_NOT_FOUND" }); return; }
    res.json({ data: { removed: true } });
  } catch (err) { fail(res, err, "remove"); }
});

/** Written into the plugin's PHP when it is served: the serving GOTCHA's own address. */
export const APP_URL_PLACEHOLDER = "__GOTCHA_APP_URL__";

/**
 * The plugin's files, in its folder, as WordPress expects ("Upload Plugin"),
 * with the serving environment's public origin as the plugin's GOTCHA (a dev
 * install must never talk to production).
 */
export function pluginZip(origin: string, dir = PLUGIN_DIR): Buffer {
  if (!/^https?:\/\/[^\s'"]+$/.test(origin)) throw new Error("plugin zip: no public origin");
  const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort();
  return zipStored(files.map((f) => {
    let data = fs.readFileSync(path.join(dir, f));
    if (f.endsWith(".php")) data = Buffer.from(data.toString("utf8").split(APP_URL_PLACEHOLDER).join(origin.replace(/\/+$/, "")), "utf8");
    return { name: `${PLUGIN_SLUG}/${f}`, data };
  }));
}

router.get("/download", ...authed, canConnect, (_req: Request, res: Response) => {
  try {
    const zip = pluginZip(resolveAppPublicUrl(process.env));
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${PLUGIN_SLUG}.zip"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(zip);
  } catch (err) { fail(res, err, "download"); }
});

export default router;
