import { verifyAccessToken } from "./jwt";
import { prisma } from "./prisma";
import type { JwtPayload } from "./jwt";

/**
 * Turn an Authentik access token into a GOTCHA principal.
 *
 * This is the one place where "Authentik says this is subject X" becomes
 * "GOTCHA says this is user U, in tenant T, with role R". HTTP requests
 * (middleware/auth.ts) and WebSocket handshakes (conversation + notifications)
 * all funnel through it, so there is a single definition of who a caller is
 * and a single set of rules for rejecting them.
 *
 * Throws on every failure; there is no partial success. Callers must map a
 * throw to a rejection and never continue.
 */
export class AuthError extends Error {
  constructor(message: string, readonly code: "invalid_token" | "no_account" | "inactive") {
    super(message);
  }
}

export async function resolvePrincipal(token: string): Promise<JwtPayload> {
  const identity = await verifyAccessToken(token).catch(() => {
    throw new AuthError("Invalid or expired token", "invalid_token");
  });

  const user = await prisma.user.findUnique({
    where: { authentikSubject: identity.subject },
    select: {
      id: true,
      email: true,
      tenantId: true,
      role: true,
      isActive: true,
      departmentMember: { select: { departmentId: true, departmentRole: true } },
    },
  });

  if (!user) throw new AuthError("No GOTCHA account is linked to this identity", "no_account");
  if (!user.isActive) throw new AuthError("Account has been deactivated", "inactive");

  return {
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
    email: user.email,
    departmentId: user.departmentMember?.departmentId,
    departmentRole: user.departmentMember?.departmentRole,
  };
}
