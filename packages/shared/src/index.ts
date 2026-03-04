// Types
export type { JwtPayload } from "./lib/jwt";
export type { ServiceEvent } from "./lib/event-bus";
export type { ServiceConfig } from "./lib/service-app";
export type {
  IncomingMessageJob,
  OutgoingMessageJob,
  AnalyticsJob,
} from "./lib/queue";

// Channel types & adapters
export type {
  ChannelType,
  NormalizedInboundMessage,
  NormalizedStatusUpdate,
  MessageContent,
  OutboundMessagePayload,
  ChannelCredentials,
  InboundAdapter,
  OutboundAdapter,
} from "./channels";
export {
  detectInboundAdapter,
  getOutboundAdapter,
  getInboundAdapters,
  getSupportedChannels,
  whatsAppInboundAdapter,
  whatsAppOutboundAdapter,
  messengerInboundAdapter,
  messengerOutboundAdapter,
  instagramInboundAdapter,
  instagramOutboundAdapter,
  emailInboundAdapter,
  emailOutboundAdapter,
  gmailInboundAdapter,
  gmailOutboundAdapter,
  outlookInboundAdapter,
  outlookOutboundAdapter,
  slackInboundAdapter,
  slackOutboundAdapter,
} from "./channels";

// Lib
export { prisma } from "./lib/prisma";
export { getRedis, closeRedis } from "./lib/redis";
export { signToken, verifyToken, generateRefreshToken, getJwtExpiresInMs } from "./lib/jwt";
export { encryptCredentials, decryptCredentials, isEncrypted } from "./lib/encryption";
export {
  incomingMessageQueue,
  outgoingMessageQueue,
  analyticsQueue,
  channelHealthQueue,
  idleConversationQueue,
  createWorker,
} from "./lib/queue";
export { publishEvent, subscribeToEvents, closeEventBus } from "./lib/event-bus";
export { createServiceApp, startService } from "./lib/service-app";

// Middleware
export { authenticate } from "./middleware/auth";
export { requireRole, requireSystemAdmin, requireDepartmentRole } from "./middleware/rbac";
export { resolveTenant } from "./middleware/tenant";
export { requireActiveTenant } from "./middleware/tenant-status";
export { validate } from "./middleware/validate";

// Types import (side-effect for Express augmentation)
import "./types/express.d";
