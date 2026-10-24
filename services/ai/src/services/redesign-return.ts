/**
 * Where an OAuth round-trip started from the redesigned app lands.
 *
 * One closed list and one URL shape for the capability connectors that do not
 * live in connectors-admin (Zoho, Google Calendar, Calendly). The destination
 * is fixed - the app origin (the app is at the root), which must equal frontend-v2's
 * NEXT_PUBLIC_BASE_PATH - and never a URL from the request; the error is a
 * code from the list below, never a provider's own text.
 */
import { Request, Response } from "express";
import { consumeOAuthState, resolveAppPublicUrl } from "@chatcenter/shared";

export const REDESIGN_FLOW = "redesign_studio";
/** Onboarding's systems step: the same answers, on its own page. */
export const ONBOARDING_SYSTEMS_FLOW = "onboarding_systems";
// The app has been at the root since 2026-10-21 (it was under /v2; the
// gateway 301s any old /v2 link).
const REDESIGN_BASE_PATH = "";

/**
 * The redesigned app's flows and the FIXED page each lands on. A flow is only
 * ever a key here, signed into the state; no path comes from a request.
 */
const REDESIGN_SYSTEMS_PATHS: Record<string, string> = {
  [REDESIGN_FLOW]: "/studio/capabilities",
  [ONBOARDING_SYSTEMS_FLOW]: "/onboarding/systems",
};

/** Whether a flow lands in the redesigned app (and so speaks its query). */
export function isRedesignSystemsFlow(flow: unknown): flow is string {
  return typeof flow === "string" && Object.hasOwn(REDESIGN_SYSTEMS_PATHS, flow);
}

/** The redesigned app's landing path for a flow, base path included; the studio by default. */
export function redesignSystemsPath(flow?: string): string {
  return `${REDESIGN_BASE_PATH}${REDESIGN_SYSTEMS_PATHS[isRedesignSystemsFlow(flow) ? flow : REDESIGN_FLOW]}`;
}

export const CAPABILITY_FAILURE_CODES: ReadonlySet<string> = new Set([
  "denied",
  "not_configured",
  "token_exchange_failed",
  "catalog_missing",
  "callback_error",
]);

/** A flow from a closed list; anything else is dropped. */
export function parseConnectFlow(raw: unknown, allowed: readonly string[] = ["onboarding", REDESIGN_FLOW, ONBOARDING_SYSTEMS_FLOW]): string | undefined {
  return typeof raw === "string" && allowed.includes(raw) ? raw : undefined;
}

export function redesignCapabilitiesUrl(system: string, result: { error?: string } = {}, flow?: string): string {
  const params = new URLSearchParams({ system });
  if (result.error) params.set("error", CAPABILITY_FAILURE_CODES.has(result.error) ? result.error : "callback_error");
  else params.set("connected", "1");
  return `${resolveAppPublicUrl(process.env)}${redesignSystemsPath(flow)}?${params.toString()}`;
}

/**
 * Cancel at the provider: `?error=` with no code. Verify and spend the state
 * to learn the flow; the redesign flow lands on error=denied. Returns false
 * (and does NOT answer) for every other case, so the caller's existing
 * response runs unchanged. Spending the state is harmless: the provider has
 * already ended the round-trip.
 */
export async function redirectRedesignDenied(
  req: Request,
  res: Response,
  stateProvider: string,
  system: string,
): Promise<boolean> {
  const state = req.query.state;
  if (!req.query.error || req.query.code || typeof state !== "string" || !state) return false;
  const consumed = await consumeOAuthState<{ flow?: string }>(state, stateProvider);
  if (!consumed.ok || !isRedesignSystemsFlow(consumed.claims?.flow)) return false;
  res.redirect(redesignCapabilitiesUrl(system, { error: "denied" }, consumed.claims.flow));
  return true;
}
