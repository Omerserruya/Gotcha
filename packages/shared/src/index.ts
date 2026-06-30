// Types
export type { JwtPayload } from "./lib/jwt";
export type { ServiceEvent } from "./lib/event-bus";
export type { ServiceConfig } from "./lib/service-app";
export type {
  IncomingMessageJob,
  IncomingCommentJob,
  WebhookTriggerJob,
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
export {
  AI_FEATURE_CATEGORIES,
  AI_CATEGORY_ORDER,
  categorizeFeature,
  categoryLabel,
  categorySqlCase,
} from "./lib/ai-feature-categories";
export type { AiFeatureCategory, AiFeatureCategoryDef } from "./lib/ai-feature-categories";
export { getRedis, closeRedis } from "./lib/redis";
export { signToken, verifyToken, generateRefreshToken, getJwtExpiresInMs } from "./lib/jwt";
export {
  FEATURES,
  FEATURE_METADATA,
  ALL_FEATURES,
  isFeature,
  getFeatureMetadata,
  listFeaturesByCategory,
} from "./lib/features";
export type { Feature, FeatureCategory, FeatureMetadata } from "./lib/features";
export {
  hasFeature,
  isFeatureEnabledForTenant,
  getUserFeatures,
  getTenantFeatures,
  assertFeature,
  invalidatePermissionsCache,
  FeatureGateError,
  // Hierarchical permission resolver (canonical RBAC path).
  hasPermission,
  assertPermission,
  getUserPermissions,
  getEffectiveAccess,
  getEffectiveBuiltinRole,
  resolveUserScope,
  isPermissionLicensed,
  scopeToDb,
  PermissionDeniedError,
} from "./lib/permissions";
export type { PermissionUser, PermissionPrincipal } from "./lib/permissions";

// Permission catalog — single source of truth for RBAC, licensing, packaging.
export {
  PERMISSIONS,
  ALL_PERMISSION_KEYS,
  ALL_LICENSE_KEYS,
  SCOPE_ORDER,
  BUILTIN_ROLES,
  BUILTIN_ROLE_ORDER,
  isPermissionKey,
  getPermission,
  listPermissionsByDomain,
  expandPermissionPattern,
  expandPermissionPatterns,
  featureLicenseKey,
  subFeatureLicenseKey,
  licenseKeysFor,
  builtinRoleForLegacy,
  maxScope,
} from "./lib/permission-catalog";
export type {
  PermissionDef,
  PermissionScope,
  PermissionKind,
  PermissionDomain,
  PermissionKey,
  BuiltinRoleKey,
  BuiltinRoleDef,
} from "./lib/permission-catalog";

// RBAC seed + backfill.
export {
  seedTenantRoles,
  backfillTenantAssignments,
  seedTenantRbac,
  seedAllTenantsRbac,
} from "./lib/rbac-seed";

// Packaging / plans (License layer presets).
export {
  PLAN_PRESETS,
  PLAN_ORDER,
  PLAN_DOMAINS,
  applyPlanToTenant,
  planDomains,
} from "./lib/plans";
export type { PlanKey, PlanDef } from "./lib/plans";
export { encryptCredentials, decryptCredentials, isEncrypted } from "./lib/encryption";
export { redact, safeLogger } from "./lib/log-redact";
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
  INTEGRATION_CREATE_LEAD_TOOL,
  INTEGRATION_CREATE_CONTACT_TOOL,
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
  RescheduleMeetingArgs,
  RescheduleMeetingResult,
  CancelMeetingResult,
  CheckAvailabilityArgs,
  CheckAvailabilityResult,
  WorkingHoursWindow,
} from "./lib/agent-tools";

// Secrets
export { getSecret, requireSecret, setSecretProvider, resetSecretProvider } from "./secrets";
export type { SecretProvider } from "./secrets";

// Middleware
export { authenticate } from "./middleware/auth";
export { requireRole, requireSystemAdmin, requireDepartmentRole } from "./middleware/rbac";
export { requireFeature, requireTenantFeature } from "./middleware/feature-gate";
export { requirePermission } from "./middleware/permission-gate";
export { resolveTenant, assertTenantId } from "./middleware/tenant";
export { requireActiveTenant, requireOnboardingOrActiveTenant } from "./middleware/tenant-status";
export { validate } from "./middleware/validate";

// Shared CRM client - used by AI tools, outbound, broadcast, and any
// caller that needs CRM lookup/segmentation. Provider-agnostic.
export {
  getConnectedCrm,
  searchLeads,
  searchContacts,
  getContactByPhone,
  getContactByEmail,
  getCrmSchema,
} from "./lib/crm";
export type {
  CrmRecord,
  CrmConnection,
  CrmLookupArgs,
  CrmFieldDef,
  CrmFieldType,
  CrmModuleSchema,
} from "./lib/crm";

// Audience resolver - explicit targeting for outbound/broadcast.
export { resolveAudience, previewAudience } from "./lib/audience";
export type {
  AudienceDefinition,
  AudienceFilter,
  AudienceFilterGroup,
  AudienceResolveResult,
  FilterOp,
  ResolvedRecipient,
} from "./lib/audience";

// Conversation intelligence schemas (canonical shapes shared across services + frontend)
export {
  TranscriptUtteranceSchema,
  type TranscriptUtterance,
} from "./schemas/transcript";
export {
  ConversationStateFrameSchema,
  type ConversationStateFrame,
} from "./schemas/conversation-frame";
export {
  CopilotConfigSchema,
  CopilotQuestionSchema,
  CopilotDataFieldSchema,
  EMPTY_COPILOT_CONFIG,
  parseCopilotConfig,
  StageCopilotConfigSchema,
  StageExitCriteriaSchema,
  EMPTY_STAGE_COPILOT_CONFIG,
  parseStageCopilotConfig,
  type CopilotConfig,
  type CopilotQuestion,
  type CopilotDataField,
  type StageCopilotConfig,
  type StageExitCriteria,
} from "./schemas/copilot-config";

// AI Worker - unified config (Phase 0: types only)
export {
  AIWorkerModeSchema,
  AISkillKindSchema,
  AISkillSchema,
  AIWorkerIdentitySchema,
  AIWorkerGuardrailsSchema,
  AIWorkerConfigSchema,
  AIWorkerSessionProfileSchema,
  type AIWorkerMode,
  type AISkillKind,
  type AISkill,
  type AIWorkerIdentity,
  type AIWorkerGuardrails,
  type AIWorkerConfig,
  type AIWorkerSessionProfile,
  type AIWorkerPromptFingerprint,
} from "./schemas/ai-worker";

export { normalizePhone, isValidPhone, listSupportedCountries } from "./lib/phone";

// Voice call state machine + persistence helpers (Phase 1)
export {
  canTransition,
  assertTransition,
  toLegacyStatus,
  fromLegacyStatus,
  appendHistory,
  makeHistoryEntry,
  InvalidTransitionError,
  TERMINAL_STATES,
  LIVE_STATES,
  type CallState,
  type LegacyCallStatus,
  type StateHistoryEntry,
} from "./lib/call-state-machine";
export {
  transitionVoiceCallSessionState,
  claimIncomingCall,
  agentBusyOnLiveCall,
  type TransitionFailure,
  type ClaimFailure,
} from "./lib/voice-session-store";
export {
  setPresence,
  markBusy,
  markOnline,
  heartbeat,
  type AgentPresenceStatus,
} from "./lib/agent-presence";
export {
  resolveEffectiveLocale,
  resolveConversationLocale,
  coerceLocale,
  isSupportedLocale,
  SUPPORTED_LOCALES,
  SYSTEM_FALLBACK_LOCALE,
  type SupportedLocale,
  type ResolvedLocale,
} from "./lib/locale";

// Capability Runtime (operation contracts + pure resolver). Strategy/provider
// impls live in services/ai and are injected via RuntimeBindings.
export * from "./lib/capability-runtime";

// Types import (side-effect for Express augmentation)
import "./types/express.d";
