// Types
export type { JwtPayload } from "./lib/jwt";
export type { ServiceEvent } from "./lib/event-bus";
export type { ServiceConfig } from "./lib/service-app";
export type {
  IncomingMessageJob,
  OutgoingMessageJob,
  AnalyticsJob,
} from "./lib/queue";

// Lib
export { prisma } from "./lib/prisma";
export { getRedis, closeRedis } from "./lib/redis";
export { signToken, verifyToken } from "./lib/jwt";
export {
  incomingMessageQueue,
  outgoingMessageQueue,
  analyticsQueue,
  createWorker,
} from "./lib/queue";
export { publishEvent, subscribeToEvents, closeEventBus } from "./lib/event-bus";
export { createServiceApp, startService } from "./lib/service-app";

// Middleware
export { authenticate } from "./middleware/auth";
export { requireRole } from "./middleware/rbac";
export { resolveTenant } from "./middleware/tenant";
export { validate } from "./middleware/validate";

// Types import (side-effect for Express augmentation)
import "./types/express.d";
