// Types
export type { JwtPayload } from "./lib/jwt";
export type { ServiceEvent } from "./lib/event-bus";
export type { ServiceConfig } from "./lib/service-app";
export type {
  IncomingMessageJob,
  IncomingCommentJob,
  OutgoingMessageJob,
  AnalyticsJob,
  BroadcastJob,
  ScheduledMessageJob,
  FlowResumeJob,
} from "./lib/queue";

// Channel types & adapters
export type {
  ChannelType,
  NormalizedInboundMessage,
  NormalizedStatusUpdate,
  NormalizedCommentEvent,
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
  gmailResolveAccessToken,
  gmailFetchNewMessages,
  outlookInboundAdapter,
  outlookOutboundAdapter,
  slackInboundAdapter,
  slackOutboundAdapter,
} from "./channels";

// Lib
export { prisma, withCrossTenantAccess, crossTenantMiddleware } from "./lib/prisma";
export {
  resolveContactByChannelId,
  unifyContact,
  findSiblingContacts,
} from "./lib/identity-resolver";
export {
  evaluateToolGate,
  evaluatePolicies,
  getDefaultHighRiskTools,
} from "./lib/tool-gate";
export type {
  ToolGateDecision,
  ToolGateResult,
  PolicyResult,
  PolicySnapshot,
  HitlPolicy,
  HitlMode,
} from "./lib/tool-gate";
export {
  createApprovalRequest,
  findPendingByConversation,
  approveRequest,
  rejectRequest,
} from "./lib/approval-requests";
export type { CreateApprovalRequestInput } from "./lib/approval-requests";
export { trackAIUsage, estimateAICost, AI_MODEL_PRICING } from "./lib/ai-usage";
export type { AIUsageEvent } from "./lib/ai-usage";
export { getRedis, closeRedis } from "./lib/redis";
export { signToken, verifyToken, generateRefreshToken, getJwtExpiresInMs } from "./lib/jwt";
export { encryptCredentials, decryptCredentials, isEncrypted } from "./lib/encryption";
export {
  incomingMessageQueue,
  outgoingMessageQueue,
  analyticsQueue,
  channelHealthQueue,
  idleConversationQueue,
  broadcastQueue,
  scheduledMessageQueue,
  flowResumeQueue,
  createWorker,
  CHANNEL_RATE_LIMITS,
} from "./lib/queue";
export { publishEvent, subscribeToEvents, closeEventBus } from "./lib/event-bus";
export { createServiceApp, startService } from "./lib/service-app";
export {
  LINK_IDENTIFIER_TOOL,
  ESCALATE_TOOL,
  buildAgentTools,
  buildAgentToolsForAIAgent,
  dispatchToolCall,
} from "./lib/agent-tools";
export type {
  AgentToolContext,
  AgentToolSideEffect,
  AgentToolDispatchResult,
  BuildAgentToolsOptions,
  ToolCallLike,
  ScheduleMeetingArgs,
  ScheduleMeetingResult,
} from "./lib/agent-tools";

// Secrets
export { getSecret, requireSecret, setSecretProvider, resetSecretProvider } from "./secrets";
export type { SecretProvider } from "./secrets";

// Middleware
export { authenticate } from "./middleware/auth";
export { requireRole, requireSystemAdmin, requireDepartmentRole } from "./middleware/rbac";
export { resolveTenant, assertTenantId } from "./middleware/tenant";
export { requireActiveTenant } from "./middleware/tenant-status";
export { validate } from "./middleware/validate";

// Types import (side-effect for Express augmentation)
import "./types/express.d";
