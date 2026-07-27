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

export async function authorizeCheckout(
  req: Request,
  checkout: { id: string; tenantId: string | null },
): Promise<CheckoutAuth> {
  const rawToken =
    typeof req.query.token === "string"
      ? req.query.token
      : typeof (req.body as any)?.token === "string"
        ? (req.body as any).token
        : null;

  if (rawToken) {
    const resolved = await resolveContinuationLink(rawToken);
    if (resolved.ok && resolved.checkout.id === checkout.id) {
      await markLinkUsed(resolved.link.id);
      return { ok: true, via: "continuation_link" };
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
