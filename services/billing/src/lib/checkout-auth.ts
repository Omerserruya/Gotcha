/**
 * Who may act on a checkout.
 *
 * Extracted so the read-only status route and the mutating session routes
 * cannot drift apart. They face the same visitor - someone who may not be
 * signed in, arriving from an emailed link - and a difference between them
 * would be a difference nobody intended.
 *
 * The governing rule: knowing the opaque reference is NOT authorization. It
 * travels through a browser URL and a third party, so it identifies a checkout
 * and proves nothing about who is asking.
 */
import type { Request, Response } from "express";
import { prisma, authenticate, resolveTenant } from "@chatcenter/shared";
import { resolveContinuationLink, markLinkUsed } from "../services/continuation-link.service";

export type CheckoutAuth =
  | { ok: true; via: "continuation_link" | "platform_admin" | "tenant_member" }
  | { ok: false };

/**
 * Cookie name for one checkout's continuation token.
 *
 * Per reference, so a cookie held for one checkout can never authorize
 * another. The reference is hex-ish and opaque already; anything outside the
 * cookie-name grammar is dropped rather than escaped, because a name that
 * needed escaping would be a reference format nobody intended.
 */
function cookieName(reference: string): string {
  return `gc_co_${reference.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/** Express has no cookie parser in this service, and adding one is not worth a dependency. */
function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim()) || null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Move the continuation token out of the page and into an HttpOnly cookie.
 *
 * The token is a bearer credential: it can show the plan and price, start a
 * payment session and ask the server to charge. It has to arrive in a URL
 * because it comes from an email, but it must not stay anywhere script can
 * read it - sessionStorage is readable by any XSS on the page, and a query
 * string persists in history and in access logs.
 *
 * Scoped to /api/checkout so it is never attached to an unrelated request,
 * and expiring with the link itself so a stale cookie cannot outlive the
 * offer it belongs to.
 */
export function setCheckoutCookie(res: Response, reference: string, token: string, expiresAt: Date) {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  if (maxAge === 0) return;
  // Secure unless someone deliberately turns it off for plaintext local work.
  //
  // Not inferred from the request: TLS terminates at the edge and nginx
  // forwards X-Forwarded-Proto $scheme, so the header reports the internal
  // hop - "http" - even when the customer is on HTTPS. Trusting it would drop
  // Secure on every production request. NODE_ENV is no better, since dev is
  // served over TLS too. So the safe value is the default, and the unsafe one
  // has to be asked for.
  const secure = process.env.CHECKOUT_COOKIE_INSECURE !== "true";
  res.append(
    "Set-Cookie",
    [
      `${cookieName(reference)}=${encodeURIComponent(token)}`,
      "Path=/api/checkout",
      "HttpOnly",
      "SameSite=Lax",
      secure ? "Secure" : "",
      `Max-Age=${maxAge}`,
    ]
      .filter(Boolean)
      .join("; "),
  );
}

/** Drop the cookie once it can no longer be of use. */
export function clearCheckoutCookie(res: Response, reference: string) {
  res.append("Set-Cookie", `${cookieName(reference)}=; Path=/api/checkout; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export async function authorizeCheckout(
  req: Request,
  checkout: { id: string; tenantId: string | null; reference?: string },
  res?: Response,
): Promise<CheckoutAuth> {
  // The cookie is preferred: once the handoff has happened the token should
  // no longer be travelling in URLs or bodies at all.
  const fromCookie = checkout.reference ? readCookie(req, cookieName(checkout.reference)) : null;
  const fromRequest =
    typeof req.query.token === "string"
      ? req.query.token
      : typeof (req.body as any)?.token === "string"
        ? (req.body as any).token
        : null;
  const rawToken = fromCookie ?? fromRequest;

  if (rawToken) {
    const resolved = await resolveContinuationLink(rawToken);
    if (resolved.ok && resolved.checkout.id === checkout.id) {
      await markLinkUsed(resolved.link.id);
      // Only on the first hop, when the token arrived in the open. After that
      // the cookie is already doing the work.
      if (res && !fromCookie && checkout.reference) {
        setCheckoutCookie(res, checkout.reference, rawToken, resolved.link.expiresAt);
      }
      return { ok: true, via: "continuation_link" };
    }
    // A cookie that no longer resolves is spent or revoked; take it away
    // rather than letting it fail every later request in the same session.
    if (res && fromCookie && checkout.reference) clearCheckoutCookie(res, checkout.reference);
    if (fromCookie && fromRequest && fromRequest !== fromCookie) {
      // Fall through to the request-supplied token: the customer may be
      // opening a freshly issued link over a stale cookie.
      const retry = await resolveContinuationLink(fromRequest);
      if (retry.ok && retry.checkout.id === checkout.id) {
        await markLinkUsed(retry.link.id);
        if (res && checkout.reference) setCheckoutCookie(res, checkout.reference, fromRequest, retry.link.expiresAt);
        return { ok: true, via: "continuation_link" };
      }
    }
    return { ok: false };
  }

  const user = (req as any).user;
  if (!user) return { ok: false };
  if (user.role === "SYSTEM_ADMIN") return { ok: true, via: "platform_admin" };

  if (checkout.tenantId && user.userId) {
    const member = await prisma.user.findFirst({
      where: { id: user.userId, tenantId: checkout.tenantId },
      select: { id: true },
    });
    if (member) return { ok: true, via: "tenant_member" };
  }
  return { ok: false };
}

/** Uniform not-found. An unauthorized caller must not learn a reference exists. */
export function checkoutNotFound(res: Response) {
  return res.status(404).json({ error: "checkout_not_found" });
}

/**
 * Optional authentication.
 *
 * `authenticate` rejects an anonymous request, but a customer holding a
 * continuation token legitimately has no session. So authentication is
 * attempted and its failure tolerated; authorization is what actually decides.
 */
export function optionalAuth(req: Request, res: Response, next: () => void) {
  if (!req.headers.authorization) return next();
  authenticate(req as any, res as any, ((err?: unknown) => {
    if (err) return next();
    resolveTenant(req as any, res as any, (() => next()) as any);
  }) as any);
}
