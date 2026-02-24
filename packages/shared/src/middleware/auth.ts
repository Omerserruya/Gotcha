import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid authorization header" });
    return;
  }

  try {
    const token = header.slice(7);
    const payload = verifyToken(token);
    req.user = payload;
    req.tenantId = payload.tenantId;

    // Verify user is still active (lightweight DB check)
    prisma.user.findUnique({
      where: { id: payload.userId },
      select: { isActive: true },
    }).then((user) => {
      if (!user || !user.isActive) {
        res.status(401).json({ error: "Account has been deactivated" });
        return;
      }
      next();
    }).catch(() => {
      // If DB check fails, allow request to proceed (fail-open for availability)
      next();
    });
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
