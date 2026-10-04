/**
 * WooCommerce "Connect" through the store's own authorization screen.
 *
 * WooCommerce has no OAuth server; it has the REST API key-generation flow
 * (/wc-auth/v1/authorize): the merchant logs into THEIR store, approves, and
 * the store POSTs a freshly generated consumer key/secret to our callback,
 * then sends the browser to our return URL. Nobody types or pastes a key.
 *
 *   GET  /api/integrations/woocommerce/oauth/init      (authenticated)
 *        ?storeUrl=https://shop.example&flow=redesign_studio[&format=json]
 *        -> 302 to {store}/wc-auth/v1/authorize (or JSON { url } for a BFF client)
 *   POST /api/integrations/woocommerce/oauth/callback  (from the store, unauthenticated)
 *        body { key_id, user_id, consumer_key, consumer_secret, key_permissions }
 *        user_id IS our signed single-use state - the only thing that ties the
 *        POST to a tenant. Keys are VALIDATED against the store before the
 *        connection is CONNECTED, and stored with encryptCredentials.
 *   GET  /api/integrations/woocommerce/oauth/return    (the browser, from the store)
 *        ?success=0|1&user_id=<state> -> the app.
 *
 * Mounted BEFORE the authenticated integrations router, like crm-oauth and
 * calendar-oauth, so the store's callback is not caught by the admin gate.
 */
import { Router, Request, Response } from "express";
import express from "express";
import jwt from "jsonwebtoken";
import {
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant,
  requirePermission,
  mintOAuthState,
  consumeOAuthState,
  getOAuthStateSecret,
  encryptCredentials,
  resolveAppPublicUrl,
  assertPublicUrl,
  getRedis,
} from "@chatcenter/shared";
import { findCatalog, upsertConnection } from "../services/connector-connection.service";
import { normalizeStoreUrl, validateWooKeys } from "../services/connectors/woocommerce.adapter";

export { normalizeStoreUrl, validateWooKeys };

const router = Router();

const PROVIDER = "woocommerce";
/** The merchant may have to log into their store first; give the round-trip room. */
const STATE_TTL_SECONDS = 1800;
const RESULT_TTL_SECONDS = 1800;
const resultKey = (jti: string) => `woo_oauth:result:${jti}`;

const WOO_FLOWS = new Set(["redesign_studio"]);
function parseWooFlow(raw: unknown): string | undefined {
  return typeof raw === "string" && WOO_FLOWS.has(raw) ? raw : undefined;
}

/** Closed list of what a return may carry in `error`. */
export const WOO_ERROR_CODES = new Set([
  "denied",
  "invalid_store_url",
  "validation_failed",
  "insufficient_permissions",
  "callback_not_received",
  "invalid_state",
  "callback_error",
]);

const canConnectSystems = requirePermission("integrations:connections:connect", "business-systems:connections:connect");

function publicApiBase(): string {
  return `${resolveAppPublicUrl(process.env)}/api/integrations/woocommerce/oauth`;
}

/** Where the browser lands. Fixed paths; nothing from the request. */
export function wooReturnUrl(flow: string | undefined, result: { error?: string }): string {
  const origin = resolveAppPublicUrl(process.env);
  if (flow === "redesign_studio") {
    const p = new URLSearchParams({ system: PROVIDER });
    if (result.error) p.set("error", WOO_ERROR_CODES.has(result.error) ? result.error : "callback_error");
    else p.set("connected", "1");
    return `${origin}/v2/studio/capabilities?${p.toString()}`;
  }
  const p = new URLSearchParams(result.error ? { status: "error", error: result.error } : { status: "connected" });
  return `${origin}/ai-studio/marketplace/${PROVIDER}?${p.toString()}`;
}

/** Signature-only read of a state we issued (no consume). For choosing a landing. */
function readSignedState(raw: unknown): { jti?: string; flow?: string } | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const c: any = jwt.verify(raw, getOAuthStateSecret(), { ignoreExpiration: true });
    return c?.provider === PROVIDER ? { jti: c.jti, flow: c.flow } : null;
  } catch {
    return null;
  }
}

// ─── Init ────────────────────────────────────────────────────

router.get(
  "/woocommerce/oauth/init",
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant(),
  canConnectSystems,
  async (req: Request, res: Response) => {
    const storeUrl = normalizeStoreUrl(req.query.storeUrl);
    if (!storeUrl) {
      res.status(400).json({ error: "invalid_store_url", message: "Enter the store's https:// address" });
      return;
    }
    try {
      // The keys will be used against this address; refuse a private one now
      // rather than after the merchant has approved.
      await assertPublicUrl(storeUrl);
    } catch {
      res.status(400).json({ error: "invalid_store_url", message: "The store address must be publicly reachable" });
      return;
    }
    const cat = await findCatalog(PROVIDER);
    if (!cat) {
      res.status(500).json({ error: "woocommerce_catalog_missing" });
      return;
    }

    const { state } = mintOAuthState(
      {
        tenantId: req.tenantId!,
        provider: PROVIDER,
        userId: (req as any).user?.userId,
        flow: parseWooFlow(req.query.flow),
        storeUrl,
      },
      STATE_TTL_SECONDS,
    );

    const base = publicApiBase();
    const params = new URLSearchParams({
      app_name: "GOTCHA",
      scope: "read_write",
      user_id: state,
      return_url: `${base}/return`,
      callback_url: `${base}/callback`,
    });
    const url = `${storeUrl}/wc-auth/v1/authorize?${params.toString()}`;
    if (req.query.format === "json") {
      res.json({ url });
      return;
    }
    res.redirect(url);
  },
);

// ─── Callback (server to server, from the store) ─────────────

router.post(
  "/woocommerce/oauth/callback",
  express.json({ limit: "16kb" }),
  async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const consumed = await consumeOAuthState<{ tenantId: string; userId?: string; flow?: string; storeUrl: string }>(
      typeof body.user_id === "string" ? body.user_id : String(body.user_id ?? ""),
      PROVIDER,
      STATE_TTL_SECONDS,
    );
    if (!consumed.ok) {
      // Not ours, or already used. Nothing is stored. A 400 makes the store
      // show its own error instead of sending the merchant on.
      console.warn(`[woocommerce oauth] callback state rejected: ${consumed.reason}`);
      res.status(400).json({ error: "invalid_state" });
      return;
    }
    const claims = consumed.claims;
    const record = async (outcome: string) => {
      await getRedis().set(resultKey(claims.jti), outcome, "EX", RESULT_TTL_SECONDS).catch(() => undefined);
    };

    try {
      const consumerKey = typeof body.consumer_key === "string" ? body.consumer_key : "";
      const consumerSecret = typeof body.consumer_secret === "string" ? body.consumer_secret : "";
      if (!consumerKey || !consumerSecret) {
        await record("error:callback_error");
        res.status(200).json({ ok: false });
        return;
      }
      if (body.key_permissions !== "read_write") {
        await record("error:insufficient_permissions");
        res.status(200).json({ ok: false });
        return;
      }

      // Proof before CONNECTED: a key the store minted is not yet a key that works.
      const valid = await validateWooKeys(claims.storeUrl, consumerKey, consumerSecret);
      if (!valid.ok) {
        console.warn(`[woocommerce oauth] key validation failed: ${valid.reason}`);
        await record("error:validation_failed");
        // 200 on purpose: the store then sends the merchant to the return URL,
        // which explains what happened. A non-200 strands them on a WordPress
        // error page with nowhere to go.
        res.status(200).json({ ok: false });
        return;
      }

      const cat = await findCatalog(PROVIDER);
      if (!cat) {
        await record("error:callback_error");
        res.status(200).json({ ok: false });
        return;
      }
      await upsertConnection({
        tenantId: claims.tenantId,
        catalogId: cat.id,
        status: "CONNECTED",
        credentialsBlob: encryptCredentials({ consumerKey, consumerSecret, keyId: body.key_id ?? null }),
        config: { storeUrl: claims.storeUrl, connectedVia: "wc_auth" },
        connectedBy: claims.userId,
      });
      await record("connected");
      res.status(200).json({ ok: true });
    } catch (err: any) {
      console.error("[woocommerce oauth] callback failed:", err?.message);
      await record("error:callback_error");
      res.status(200).json({ ok: false });
    }
  },
);

// ─── Return (the browser) ────────────────────────────────────

router.get("/woocommerce/oauth/return", async (req: Request, res: Response) => {
  // The store echoes our state back as user_id. Read it by signature only -
  // the callback already spent it - to learn where to land and which result
  // belongs to this round-trip.
  const signed = readSignedState(req.query.user_id);
  if (!signed?.jti) {
    res.redirect(wooReturnUrl(undefined, { error: "invalid_state" }));
    return;
  }
  const flow = parseWooFlow(signed.flow);
  if (req.query.success !== "1") {
    res.redirect(wooReturnUrl(flow, { error: "denied" }));
    return;
  }
  const outcome = await getRedis().get(resultKey(signed.jti)).catch(() => null);
  if (outcome === "connected") {
    res.redirect(wooReturnUrl(flow, {}));
    return;
  }
  const error = typeof outcome === "string" && outcome.startsWith("error:") ? outcome.slice(6) : "callback_not_received";
  res.redirect(wooReturnUrl(flow, { error }));
});

export default router;
