import { JwtPayload } from "../lib/jwt";

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
      tenantId?: string;
      rawBody?: Buffer;
    }
  }
}
