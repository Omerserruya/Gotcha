import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "change-me";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "24h";

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
