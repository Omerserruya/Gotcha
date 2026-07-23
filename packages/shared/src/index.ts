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
  ProviderSendError,
} from "./channels";
export {
  ChannelSendError,
  describeSendError,
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
  computeOperationKey,
  findPendingByConversation,
  approveRequest,
  rejectRequest,
  claimForExecution,
  recordExecutionOutcome,
  claimCustomerNotification,
  linkCustomerMessage,
} from "./lib/approval-requests";
export type { CreateApprovalRequestInput } from "./lib/approval-requests";
export { sanitizeCustomerText, hasAiSignaturePunctuation, withProtectedAtoms } from "./lib/customer-text";
export { issueCustomerVerification, confirmCustomerVerification } from "./lib/customer-verification";
export {
  getOrCreateActiveSession,
  activeFacts,
  applyExtractedFacts,
  recordQuestionAsked,
  markAnswered,
  computeReadiness,
  shouldBlockQuestion,
  recordActionAttempt,
  buildDiscoverySnapshot,
  type FactSource,
  type ProposedFact,
  type ReadinessResult,
} from "./lib/discovery-state";
export {
  getDiscoveryProfile,
  normalizeFactKey,
  aliasMap,
  PRODUCT_RECOMMENDATION_PROFILE,
  type DiscoveryProfile,
  type FactSpec,
  type FactValueType,
} from "./lib/discovery-profiles";
export {
  evaluateBusinessPolicy,
  evaluateConfig,
  actionKindForTool,
  revalidateBeforeExecution,
} from "./lib/business-policy";
export type {
  BusinessActionKind,
  BusinessPolicyConfig,
  BusinessPolicyFacts,
  BusinessPolicyResult,
  PolicyDecisionKind,
  PolicyEvaluationPoint,
} from "./lib/business-policy";
export type {
  Money,
  ChipTone,
  StatusChip,
  OrderItem,
  TimelineMilestone,
  OrderCard,
  CommerceSummary,
  CommerceCapabilities,
  CommerceContext,
  CommerceContextResponse,
  AICommerceOrder,
  AICommerceSnapshot,
  CommerceActionKind,
  CommerceActionRequest,
  CommerceActionResponse,
} from "./lib/commerce-context.types";
export { trackAIUsage, estimateAICost, computeAICostUsd, resolveModelPricing, AI_MODEL_PRICING, getEmployeeUsageRollup } from "./lib/ai-usage";
export type { AIUsageEvent, EmployeeUsageRollup } from "./lib/ai-usage";
export {
  AI_FEATURE_CATEGORIES,
  AI_CATEGORY_ORDER,
  categorizeFeature,
  categoryLabel,
  categorySqlCase,
} from "./lib/ai-feature-categories";
export type { AiFeatureCategory, AiFeatureCategoryDef } from "./lib/ai-feature-categories";
export { getRedis, closeRedis } from "./lib/redis";
export {
  mintApprovalRefs,
  consumeApprovalRef,
  revokeApprovalRefs,
  isApprovalRef,
  normalizeE164,
} from "./lib/approval-refs";
export type { ApprovalRefBinding, ApprovalDecision } from "./lib/approval-refs";
export {
  resolveApprovalRecipient,
  userMayApprove,
  recipientRejectionMessage,
} from "./lib/approval-recipients";
export type { EligibleRecipient, RecipientRejection } from "./lib/approval-recipients";
export {
  BUSINESS_HOURS_KEY,
  parseBusinessHours,
  evaluateBusinessHours,
  describeNextOpening,
  DAY_KEYS,
} from "./lib/business-hours";
export type { BusinessHoursConfig, BusinessOpenState, DayKey, DaySchedule } from "./lib/business-hours";
export { verifyAccessToken } from "./lib/jwt";
export { resolvePrincipal, AuthError } from "./lib/principal";
export { getOAuthStateSecret } from "./lib/oauth-state";
export { mintOAuthState, consumeOAuthState, returnPathForFlow } from "./lib/oauth-state-store";
export type { OAuthStateClaims, MintedState, ConsumeResult } from "./lib/oauth-state-store";
export { verifyInternalServiceKey, requireInternalKey, getInternalServiceKey } from "./lib/internal-key";
export { safeFetch, assertPublicUrl, isBlockedIp, SsrfError } from "./lib/safe-fetch";
export type { SafeFetchOptions, SafeFetchResult } from "./lib/safe-fetch";
export { verifyWebhookSignature, verifySharedSecretToken, timingSafeEqualStr } from "./lib/webhook-verify";
export type { WebhookVerifyResult } from "./lib/webhook-verify";
export { writeAudit, auditUser, auditSystem, AuditAction } from "./lib/audit";
export type { AuditEventInput, AuditActorType, AuditActionValue } from "./lib/audit";
export {
  ensureIdentity,
  createRecoveryLink,
  deactivateIdentity,
  setIdentityActive,
  deleteIdentity,
  updateIdentity,
  findIdentityBySubject,
  publicAuthentikOrigin,
  listUserSessions,
  terminateSession,
  terminateAllUserSessions,
  listUserLoginEvents,
  listUserDevices,
  deleteUserDevice,
  getMfaEnrollmentMap,
  getUserLastLogin,
  getLastLoginBySubject,
  type AuthentikIdentity,
  type AuthentikSession,
  type AuthentikLoginEvent,
  type AuthentikDevice,
  type AuthentikSecuritySummary,
  type MfaEnrollmentState,
  type RemovableDeviceType,
} from "./lib/authentik";
export {
  mfaRequirementFor,
  isEnrolledWithRecovery,
  type MfaRole,
  type TenantMfaPolicy,
  type MfaRequirement,
  type MfaRequirementReason,
  type MfaFactorCounts,
} from "./lib/mfa";
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

// Permission catalog - single source of truth for RBAC, licensing, packaging.
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

// Outbound-call destination validation (server-side E.164 gate).
export { validateE164 } from "./lib/phone-validation";
export type { E164Validation } from "./lib/phone-validation";

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

// Billing · Subscription · AI Units (pricing engine, wallet, entitlement layering).
export * from "./lib/billing";
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
export { enforceMfaEnrollment } from "./middleware/mfa-guard";
export { requireFeature, requireTenantFeature } from "./middleware/feature-gate";
export { requirePermission, requirePermissionOrRole } from "./middleware/permission-gate";
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

// Agent Contract (FROZEN architecture, Phase 1: envelope only - pure types +
// pure binder + master flag, not wired into the live path). The kernel above
// stays the single execution authority; an Agent only proposes through it.
export * from "./lib/agent";

// Types import (side-effect for Express augmentation)
import "./types/express.d";
