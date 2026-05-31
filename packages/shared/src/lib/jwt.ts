import jwt from "jsonwebtoken";
import crypto from "crypto";

/**
 * JWT signing secret.
 *
 * In production we refuse to start with the placeholder — the previous
 * fallback (`"change-me"`) meant a missing env var silently produced a
 * verifiable token any attacker could forge. Dev/test still gets the
 * placeholder so the toolchain boots without env wiring.
 */
function resolveJwtSecret(): string {
  const v = process.env.JWT_SECRET;
  if (v && v.length >= 16) return v;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[jwt] JWT_SECRET is required in production (>=16 chars). Refusing to boot with a default secret.",
    );
  }
  return v || "change-me";
}
const JWT_SECRET = resolveJwtSecret();
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "24h";
const REFRESH_TOKEN_DAYS = parseInt(process.env.REFRESH_TOKEN_DAYS || "30", 10);

export interface JwtPayload {
  userId: string;
  tenantId: string;
  role: string;
  email: string;
  departmentId?: string;
  departmentRole?: string;
}

export interface SystemAdminJwtPayload {
  userId: string;
  role: "SYSTEM_ADMIN";
  email: string;
  tenantId: string; // system tenant
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN } as any);
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

export function generateRefreshToken(): { token: string; expiresAt: Date } {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
  return { token, expiresAt };
}

export function getJwtExpiresInMs(): number {
  const match = JWT_EXPIRES_IN.match(/^(\d+)(h|m|d|s)?$/);
  if (!match) return 24 * 60 * 60 * 1000; // default 24h
  const value = parseInt(match[1], 10);
  const unit = match[2] || "s";
  const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return value * (multipliers[unit] || 1000);
}
