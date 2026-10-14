// Types
export type { JwtPayload } from "./lib/jwt";
export type { ServiceEvent } from "./lib/event-bus";
export type { ServiceConfig } from "./lib/service-app";
export type {
  IncomingMessageJob,
  IncomingCommentJob,
  OutboundEchoJob,
  WebhookTriggerJob,
  OutgoingMessageJob,
  AnalyticsJob,
  BroadcastJob,
  ScheduledMessageJob,
  FlowResumeJob,
  AutomationEventJob,
  CartEventJob,
  OrderEventJob,
  OrderStatus,
  HistoricalImportChunkJob,
  HistoricalIntelligenceJob,
} from "./lib/queue";
export { tagsAdded, emitTagsAdded } from "./lib/automation-events";

// Historical import: the one mapping between the pipeline's thirteen states and
// the four the customer actually sees.
export {
  historicalImportStage,
  isHistoricalImportTerminal,
  hasHistoricalResults,
  historicalImportPercent,
  historicalAnalysisPercent,
  historicalAnalysisCounts,
  isForwardTransition,
  HISTORICAL_SOURCE_WINDOW_MS,
  HISTORICAL_SOURCE_WINDOW_DAYS,
} from "./lib/historical-import";
export type {
  HistoricalImportStatus,
  HistoricalImportStage,
} from "./lib/historical-import";

// Numbers the owner keeps on their own phone - enforced at ingest, before any
// Conversation, Contact or Message row exists.
export {
  normalizeExclusionValue,
  exclusionDisplayValue,
  isInboundExcluded,
} from "./lib/inbound-exclusions";
export type { ExclusionLookup } from "./lib/inbound-exclusions";

// Attachment storage. The probe exists because an unwritable uploads volume
// failed silently in production and was reported as a download failure.
export {
  probeUploadsDir,
  describeUploadsProbe,
  classifyMediaFailure,
} from "./lib/media-storage";
export type { MediaFailureReason, UploadsProbe } from "./lib/media-storage";

// Channel types & adapters
export type {
  ChannelType,
  NormalizedInboundMessage,
  InboundReferral,
  NormalizedStatusUpdate,
  NormalizedCommentEvent,
  NormalizedOutboundEcho,
  NormalizedHistoryChunk,
  NormalizedHistoricalMessage,
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
  fetchOutlookMessage,
  outlookInboundAdapter,
  outlookOutboundAdapter,
  slackInboundAdapter,
  slackOutboundAdapter,
  // Email threading: turning a reply from the inbox into a reply in the
  // customer's mail client instead of a second, unrelated email.
  resolveEmailThread,
  readEmailMeta,
  replySubject,
  baseSubject,
  buildReferences,
  parseMessageIdList,
  threadHeaderLines,
  safeExtraHeaders,
  outgoingSubject,
  DEFAULT_EMAIL_SUBJECT,
  // Mail no person wrote (bounces, auto-replies, bulk): dropped at ingest.
  autoMailReason,
  parseHeaderBlock,
} from "./channels";
export type {
  EmailThreadContext,
  EmailMessageMeta,
  EmailThreadSourceMessage,
} from "./channels";

// Lib
export { prisma, withCrossTenantAccess, crossTenantMiddleware, withHistoricalRecords } from "./lib/prisma";
export {
  resolveContactByChannelId,
  unifyContact,
  findSiblingContacts,
} from "./lib/identity-resolver";
export {
  linkContacts,
  suggestLink,
  unlinkContacts,
  autoLinkByIdentifier,
  autoLinkByShopifyCustomer,
  suggestBySameName,
  namesLookAlike,
  normalizeName,
  IDENTITY_LINK,
  NOT_SAME_PREFIX,
  pairKey,
  type LinkRecord,
  type LinkSignal,
  type LinkOutcome,
} from "./lib/identity-links";
// Read vs write classification - ONE table, used by the Copilot's
// who-executes decision and by the sandbox write guard in dispatchToolCall.
// Migrating existing tool policy into the three-state model. Conservative by
// construction: never enables a disabled tool, never makes an approval-gated
// tool autonomous, and reports impossible states instead of guessing.
export {
  decideMigration,
  buildMigrationReport,
  migrationWrites,
} from "./lib/tool-policy-migration";
export type {
  ThreeState,
  MigrationOutcome,
  LegacyPolicy,
  MigrationDecision,
  MigrationReport,
} from "./lib/tool-policy-migration";
// Integrations & Tools workspace classification. Strict product boundary:
// Channels owns communication (and is NOT listed here - it surfaces only as a
// dependency note on the tools that deliver over it), Knowledge Manager owns
// knowledge sources, and this workspace owns business systems + tool policy.
export {
  classifyCatalogIntegration,
  classifyKnowledgeSource,
  gotchaEntry,
  buildWorkspaceSidebar,
  governableToolCount,
  channelDependencyFor,
  CHANNEL_DELIVERY_TOOLS,
  GOTCHA_ENTRY_ID,
} from "./lib/integration-workspace";
export type {
  WorkspaceEntry,
  WorkspaceEntryKind,
  WorkspaceSidebar,
  ConnectionState,
  ExternalOwner,
  ChannelDependency,
  CatalogIntegrationInput,
  KnowledgeSourceInput,
  InternalToolsInput,
} from "./lib/integration-workspace";
// Tool permission explanation layer: risk grouping, and WHY a tool cannot run.
// Deliberately not an authorization decision - evaluateToolGate owns that.
export {
  RISK_GROUPS,
  riskGroupFor,
  mayBeAlwaysAllowed,
  isHighRiskGroup,
  highRiskAutoRunPermitted,
  recommendedState,
  resolveToolAvailability,
  summarizeTools,
  groupByRisk,
  planBulkAction,
  bulkActionNeedsConfirmation,
} from "./lib/tool-availability";
export type {
  RiskGroup,
  PermissionState,
  UnavailableReason,
  ToolAvailabilityInput,
  ToolAvailability,
  ToolCounts,
  BulkAction,
} from "./lib/tool-availability";
export { classifyToolEffect } from "./lib/tool-effect";
export type { ToolEffect } from "./lib/tool-effect";
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
  describeApprovalAction,
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
  TimelineSource,
  TimelineActor,
  OrderCard,
  OrderDetail,
  OrderLineDetail,
  OrderTracking,
  OrderRefundEvent,
  CommerceSummary,
  CommerceCapabilities,
  CommerceContext,
  CommerceContextResponse,
  AICommerceOrder,
  AICommerceSnapshot,
  CommerceActionKind,
  CommerceActionRequest,
  CommerceOrderActionKind,
  CommerceCustomerActionKind,
  CommerceActionResponse,
} from "./lib/commerce-context.types";
export { toolDisplayName, humanizeToolName, looksLikeRawToolId } from "./lib/tool-display-names";
export {
  COMMERCE_ORDER_ACTIONS,
  COMMERCE_CUSTOMER_ACTIONS,
  isCustomerScopedAction,
  isOrderScopedAction,
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
export { FLOW_TRIGGER_TYPES, isFlowTrigger, canvasHasRunnableProcess } from "./lib/flow-canvas";
export { verifyAccessToken, verifyIdToken } from "./lib/jwt";
export { resolvePrincipal, AuthError } from "./lib/principal";
export { getOAuthStateSecret } from "./lib/oauth-state";
export { mintOAuthState, consumeOAuthState, returnPathForFlow } from "./lib/oauth-state-store";
export type { OAuthStateClaims, MintedState, ConsumeResult } from "./lib/oauth-state-store";
export { verifyInternalServiceKey, requireInternalKey, getInternalServiceKey } from "./lib/internal-key";
export { safeFetch, safeFetchBuffer, assertPublicUrl, isBlockedIp, SsrfError } from "./lib/safe-fetch";
export type { SafeFetchBufferResult } from "./lib/safe-fetch";
// Widget logo and cover: checked from the bytes, re-hosted (W3/W4).
export {
  WIDGET_IMAGE_LIMITS,
  WIDGET_IMAGE_MAX_BYTES,
  WIDGET_IMAGE_EXTENSION,
  isWidgetImageSlot,
  probeImage,
  checkWidgetImage,
  driveDirectUrl,
  type WidgetImageSlot,
  type WidgetImageType,
  type ImageFacts,
  type WidgetImageRefusal,
} from "./lib/widget-image";
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
  ROLE_CEILINGS,
  OWNER_FLOOR,
  ceilingKeysFor,
  rolesEditable,
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
  customizedRoleKey,
} from "./lib/rbac-seed";
export { mergeAdminIntoOwner, undoMergeAdminIntoOwner, MERGE_RECORD_KEY } from "./lib/rbac-merge";

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
export {
  PLATFORM_PERMISSIONS,
  PLATFORM_PERMISSION_CATALOG,
  ALL_PLATFORM_PERMISSION_KEYS,
  isPlatformPermission,
} from "./lib/platform-permissions";
export type { PlatformPermission, PlatformPermissionDef } from "./lib/platform-permissions";
export { encryptCredentials, decryptCredentials, isEncrypted } from "./lib/encryption";

// BFF app-session infrastructure (additive; inert until cookie flags enabled).
// See docs/security/bff-session-migration-map.md §A18 commit 1.
export {
  sealSessionSecret,
  openSessionSecret,
  loadSessionKeyring,
  assertSessionEncryptionReady,
  SessionCryptoError,
  type SessionCryptoContext,
} from "./lib/session-crypto";
export {
  generateSessionToken,
  hashSessionToken,
  isWellFormedSessionToken,
  isWellFormedTokenHash,
} from "./lib/session-token";
export {
  parseSessionCookie,
  serializeSessionCookie,
  serializeClearedSessionCookie,
  resolveSessionCookieContract,
  SessionCookieError,
  PROD_SESSION_COOKIE_NAME,
  DEV_SESSION_COOKIE_NAME,
  type SessionCookieContract,
} from "./lib/session-cookie";
export {
  normalizeOrigin,
  loadOriginPolicy,
  isAllowedOrigin,
  assertAppOriginReady,
  resolveAppPublicUrl,
  assertAppPublicUrlReady,
  resolveVoicePublicUrl,
  assertVoicePublicUrlReady,
  AppOriginError,
  type OriginPolicy,
} from "./lib/app-origins";
// One email look for every service that sends mail, and one queue contract.
export * from "./lib/email/brand-email";
export * from "./lib/email/email-queue";
export {
  readSessionFlags,
  sessionInfraEnabled,
  type SessionFlags,
} from "./lib/session-flags";
export {
  REVOCATION_REASON,
  readSessionTtl,
  expiredSessionsWhere,
  revokedSessionsWhere,
  identitySessionsWhere,
  staleVersionSessionsWhere,
  membershipSessionsWhere,
  isSessionUsable,
  toSafeSessionView,
  assertSessionInfraReady,
  SESSION_SECRET_FIELDS,
  type RevocationReason,
  type SafeSessionView,
  type SessionTtl,
} from "./lib/session-store";
export {
  readSessionCookie,
  resolvePrincipalFromSessionToken,
} from "./lib/session-principal";
export {
  issueRealtimeTicket,
  redeemRealtimeTicket,
  isWellFormedRealtimeTicket,
  REALTIME_TICKET_TTL_SECONDS,
  type RealtimeTicketPrincipal,
} from "./lib/realtime-ticket";
export {
  CONVERSATION_INTENTS,
  isConversationIntent,
  normalizeConversationIntent,
  isFrustrated,
  type ConversationIntent,
  type IntentSignals,
} from "./lib/conversation-intent";
export {
  scoreQueueItem,
  rankQueueItems,
  type QueueUrgency,
  type QueueRankInput,
  type QueueScore,
} from "./lib/queue-ranking";
export {
  toActivityEvent,
  approvalToActivityEvent,
  toolSubject,
  type ActivityEvent,
  type ActivityOutcome,
  type ActivitySubject,
} from "./lib/activity-events";
export {
  recordHandover,
  latestHandover,
  CONVERSATION_HANDLERS,
  type ConversationHandler,
  type HandoverReason,
} from "./lib/conversation-handover";
export {
  recordUnansweredQuestion,
  recordProductDemand,
  clusterKeyFor,
  isoWeekKey,
  UNANSWERED_REASONS,
  type UnansweredReason,
} from "./lib/knowledge-gaps";
export {
  notificationCategory,
  notificationTarget,
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationTargetType,
} from "./lib/notification-category";
export {
  computeSetupState,
  SETUP_STEPS,
  type SetupState,
  type SetupStep,
  type SetupStepState,
  type SetupFacts,
} from "./lib/setup-state";
export {
  buildQuietDayList,
  HORIZON_WEEKS,
  type QuietDayItem,
  type QuietDayEffect,
  type QuietDaySource,
} from "./lib/quiet-day-ranking";
export {
  DEFAULT_POLICY,
  MAX_LIST_ITEMS,
  MAX_ITEM_CHARS,
  PolicyValidationError,
  validateStringList,
  validatePolicyPatch,
  getPolicy,
  getPolicyPrompt,
  setPolicy,
  validateAgainstPolicy,
  type BusinessPolicy,
} from "./lib/workspace-policy";
export { redact, safeLogger } from "./lib/log-redact";
export * from "./lib/tenant-access-policy";
export {
  incomingMessageQueue,
  outgoingMessageQueue,
  analyticsQueue,
  channelHealthQueue,
  idleConversationQueue,
  broadcastQueue,
  scheduledMessageQueue,
  notificationsQueue,
  flowResumeQueue,
  historicalIntelligenceQueue,
  createWorker,
  CHANNEL_RATE_LIMITS,
  ORDER_STATUSES,
} from "./lib/queue";
export { publishEvent, subscribeToEvents, closeEventBus } from "./lib/event-bus";
export { createServiceApp, startService } from "./lib/service-app";
export {
  LINK_IDENTIFIER_TOOL,
  ESCALATE_TOOL,
  INTEGRATION_CREATE_LEAD_TOOL,
  INTEGRATION_CREATE_CONTACT_TOOL,
  SEND_PRODUCT_CARD_TOOL,
  SEND_PRODUCT_CAROUSEL_TOOL,
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
  SendShopifyProductsArgs,
  SendShopifyProductsResult,
} from "./lib/agent-tools";

// Business discovery: shape guarantees for the Json columns whose
// collections several writers populate inconsistently.
export {
  normalizeDiscoveryTechnology,
  normalizeDiscoveryCommunication,
  normalizeDiscoveryRecord,
  DISCOVERY_TECH_COLLECTIONS,
} from "./lib/business-discovery-shape";
export type {
  DiscoveryConfidence,
  DiscoveryTechItem,
  DiscoveryPlatform,
  DiscoveryTechnology,
  DiscoveryChannel,
  DiscoveryCommunication,
} from "./lib/business-discovery-shape";

// Onboarding → Knowledge Base projection. Pure: what SHOULD exist in the
// knowledge base given what onboarding learned, plus the deterministic
// reconciliation that makes a website re-scan refresh rather than duplicate.
export {
  KB_TOPICS,
  SCAN_VERSION,
  normalizeUrl,
  normalizeContent,
  checksumOf,
  dedupeKeyFor,
  buildEntry,
  reconcile,
} from "./lib/knowledge/onboarding-projection";
export type {
  KbTopic,
  KbSourceType,
  KbSourceMetadata,
  ProjectedEntry,
  ExistingDoc,
  ReconcileAction,
  ReconcileItem,
  ReconcilePlan,
} from "./lib/knowledge/onboarding-projection";
export {
  projectDiscoveryTopics,
  projectPages,
  projectReadinessAnswers,
  projectExternalSources,
  titleFor,
  hasConcreteFact,
  BOILERPLATE_MIN_PAGES,
} from "./lib/knowledge/discovery-to-knowledge";
export type {
  SkippedTopic,
  DiscoveryInput,
  ProfileInput,
  ReadinessAnswer,
  PageInput,
  ExternalSourceInput,
  ProjectionContext,
} from "./lib/knowledge/discovery-to-knowledge";

// Shopify Live Chat - channel config, visitor sessions, product snapshots.
export {
  SHOPIFY_LIVE_CHAT_CHANNEL,
  SHOPIFY_MESSAGE_TYPES,
  MAX_CAROUSEL_ITEMS,
  DEFAULT_CAROUSEL_ITEMS,
  MAX_VISITOR_MESSAGE_CHARS,
  VISITOR_SESSION_TTL_SECONDS,
  DEFAULT_SUGGESTED_QUESTIONS,
  isShopifyCommerceMessageType,
  normalizeShopDomain,
  normalizeStorefrontDomain,
  buildAllowedOrigins,
  isOriginAllowed,
  defaultShopifyLiveChatConfig,
  normalizeShopifyLiveChatConfig,
  readShopifyLiveChatConfig,
  sanitizeToken,
  sanitizeAssetUrl,
  sanitizeProductImageUrl,
  buildProductUrl,
  buildProductSnapshot,
  signVisitorSession,
  verifyVisitorSession,
  newVisitorId,
  normalizeStorefrontContext,
  isRenderableCommercePayload,
  projectVisitorMessage,
} from "./lib/shopify-live-chat";
export type {
  ShopifyMessageType,
  ShopifyLiveChatConfig,
  ShopifyLiveChatAppearance,
  ShopifyLiveChatWelcome,
  ShopifyLiveChatHours,
  ShopifyLiveChatRouting,
  ShopifyLiveChatCommerce,
  ShopifyLiveChatPrivacy,
  ShopifyLiveChatInstall,
  Availability,
  VisitorSessionPayload,
  StorefrontContext,
  StorefrontPageType,
  ProductSnapshot,
  ProductVariantSnapshot,
  ShopifyCommerceMessagePayload,
  BuildProductSnapshotInput,
  VisitorMessageView,
  VisitorProjectionContext,
} from "./lib/shopify-live-chat";

// Shopify chat EXPERIENCE: launcher, hero, proactive teaser, sounds and
// the widget state machine. Separate from the channel contract above.
export {
  SHOPIFY_CHAT_UX_SCHEMA_VERSION,
  WIDGET_STATES,
  resolveWidgetState,
  showsHero,
  sanitizeMediaUrl,
  HERO_IMAGE_EXTENSIONS,
  HERO_VIDEO_EXTENSIONS,
  MEDIA_GUIDANCE,
  LAUNCHER_SHAPES,
  LAUNCHER_ICON_NAMES,
  HERO_MEDIA_TYPES,
  PROACTIVE_TRIGGERS,
  SOUND_PACKS,
  defaultWelcome,
  normalizeWelcome,
  migrateLegacyWelcome,
  resolveHeroHeight,
  heroHeightWarning,
  DEFAULT_WELCOME_QUESTIONS,
  defaultLauncher,
  normalizeLauncher,
  defaultHero,
  normalizeHero,
  defaultProactive,
  normalizeProactive,
  shouldShowTeaser,
  defaultSounds,
  normalizeSounds,
  shouldPlaySound,
  defaultBehavior,
  normalizeBehavior,
  defaultShopifyChatUx,
  normalizeShopifyChatUx,
  publicUxConfig,
  WIDGET_LOOKS,
  WIDGET_KINDS,
  defaultWhatsapp,
  normalizeWhatsapp,
  type WidgetLook,
  type WidgetKind,
  type ShopifyChatWhatsapp,
} from "./lib/shopify-chat-ux";
export type {
  WidgetState,
  LauncherShape,
  LauncherIconName,
  HeroMediaType,
  ProactiveTrigger,
  SoundPack,
  SoundEvent,
  ShopifyChatWelcome,
  ShopifyChatLauncher,
  ShopifyChatHero,
  ShopifyChatProactive,
  ShopifyChatSounds,
  ShopifyChatBehavior,
  ShopifyChatUx,
  TeaserDecisionInput,
} from "./lib/shopify-chat-ux";

// Stripe pins its version IN CODE. Unlike Shopify/Meta (which expire versions
// and fall forward), Stripe with no header uses the ACCOUNT DASHBOARD default -
// so the contract lived in a web console until this was added.
export {
  stripeApiVersion,
  stripeVersionHeader,
  reportStripeApiVersion,
  STRIPE_API_VERSION_REVIEW_BY,
  __resetStripeApiVersionCache,
} from "./lib/stripe-api-version";

// The ONE place the Meta Graph API version is decided. Replaced eight
// independent declarations across four services that sat on three different
// versions at once - two of them expired.
// What a stored customer upload may be called and how it is served (the
// stored-XSS fix, 2026-10-09).
export { safeUploadExtension, uploadServingHeaders, SAFE_UPLOAD_EXTENSIONS, INLINE_UPLOAD_EXTENSIONS } from "./lib/upload-safety";
export { signMediaUrl, verifyMediaSignature, mediaSignatureShapeOk, presentMediaUrl, storedUploadName, signedMediaPath, STORED_UPLOAD_NAME } from "./lib/media-url";

// A WhatsApp number's own details from Meta (the channel check and the
// on-demand refresh read it the same way).
export { whatsappNumberDetails, withWhatsAppNumberDetails, type WhatsAppNumberDetails } from "./lib/whatsapp-number-details";

export {
  metaGraphVersion,
  metaGraphBaseUrl,
  reportMetaGraphVersion,
  META_GRAPH_VERSION_REVIEW_BY,
  __resetMetaGraphVersionCache,
} from "./lib/meta-graph-version";

// The ONE place the Shopify Admin API version is decided, plus the response
// check that makes Shopify's silent fall-forward visible. A second local
// `const API_VERSION` anywhere is how the previous 15-month drift happened.
export {
  shopifyApiVersion,
  reportShopifyApiVersion,
  checkShopifyResponseVersion,
  SHOPIFY_API_VERSION_REVIEW_BY,
  __resetShopifyApiVersionCache,
} from "./lib/shopify-api-version";

// The ONE Shopify app identity. Replaces the separate Chat app credentials:
// app-proxy signatures, webhook HMACs and the Theme Editor deep link are all
// derived from the Core app now. See lib/shopify-app-identity.ts for why this
// is a replacement rather than an alias of SHOPIFY_CHAT_APP_*.
export {
  getShopifyAppIdentity,
  validateAppIdentity,
  isAppIdentityConfigured,
} from "./lib/shopify-app-identity";
export type { ShopifyAppIdentity, AppIdentityProblem } from "./lib/shopify-app-identity";

// Shopify-owned INSTALLATION. Verifies the signed app-entry request Shopify
// sends before OAuth begins, and builds the two outbound URLs (the install
// page and the authorize redirect) from validated values only. See
// lib/shopify-install.ts for why the shop is checked strictly here and
// forgivingly everywhere else.
export {
  APP_ENTRY_MAX_AGE_SECONDS,
  strictShopDomain,
  singleValue,
  isFreshAppEntryTimestamp,
  verifyAppEntryHmac,
  verifyOAuthCallbackHmac,
  buildShopifyAuthorizeUrl,
  resolveShopifyInstallUrl,
  resolveShopifyAppStoreHandle,
  resolveShopifyInstallEntry,
} from "./lib/shopify-install";
export type {
  AppEntryResult,
  AppEntryRejection,
  ShopifyInstallEntry,
} from "./lib/shopify-install";

// GOTCHA Shopify CHAT app - its own identity, verification and lifecycle.
// Deliberately a separate module from the live-chat channel config above:
// one describes the merchant's widget, the other the Shopify app that
// installs it. See docs/architecture/shopify-core-vs-chat-app.md.
export {
  getShopifyChatAppConfig,
  validateChatAppConfig,
  isChatAppConfigured,
  normalizeShopifyShopDomain,
  normalizeStorefrontHost,
  verifyShopifyQueryHmac,
  verifyShopifyWebhookHmac,
  buildThemeEditorDeepLink,
  buildAppAdminLink,
  resolveChatActivationState,
  isServingState,
  HEARTBEAT_FRESH_MS,
  HEARTBEAT_GRACE_MS,
} from "./lib/shopify-chat-app";
export type {
  ShopifyChatAppConfig,
  ChatAppConfigProblem,
  ChatActivationState,
  ChatActivationInput,
} from "./lib/shopify-chat-app";

// The App Proxy - the only path by which the storefront can PROVE which
// customer is chatting. See lib/shopify-app-proxy.ts for why Liquid's
// customer.id is not proof.
export {
  IDENTITY_TOKEN_TTL_SECONDS,
  verifyAppProxySignature,
  loggedInCustomerId,
  signCustomerIdentity,
  verifyCustomerIdentity,
  verifiedCustomerExternalId,
  isVerifiedCustomerExternalId,
} from "./lib/shopify-app-proxy";
export type { ShopifyCustomerIdentity } from "./lib/shopify-app-proxy";

// The website chat widget. Shares its experience block with the Shopify
// storefront widget on purpose - see lib/webchat-widget.ts.
export {
  WEBCHAT_CHANNEL,
  defaultWebchatConfig,
  normalizeWebchatConfig,
  migrateLegacyWebchat,
  isLegacyWebchatSettings,
  publicWebchatConfig,
  normalizeWebchatCommerce,
  MAX_PROMOTION_COUPONS,
} from "./lib/webchat-widget";
export type { WebchatConfig, LegacyWebchatSettings, WebchatPosition, WebchatCommerce } from "./lib/webchat-widget";
// WooCommerce product cards on the website widget (W9).
export {
  WOO_MESSAGE_TYPES,
  MAX_WOO_VARIANTS,
  buildWooProductCard,
  projectWooCommerce,
  summarizeWooCards,
  wooCartLine,
  MAX_CART_QUANTITY,
  type WooCartRefusal,
  type WooProductCard,
  type WooCardVariant,
  type WooCommercePayload,
} from "./lib/woo-commerce-cards";
// The widget follows the customer's language (W10).
export { isWidgetLocale, visitorLocaleOf, textLocaleOf, widgetTextsOf, textsToTranslate, type WidgetLocale } from "./lib/widget-language";
// List-Unsubscribe on marketing email (RFC 2369 / 8058).
export { signUnsubscribeToken, verifyUnsubscribeToken, listUnsubscribeHeaders, publicOrigin, type UnsubscribeSubject } from "./lib/list-unsubscribe";
// "Powered by GOTCHA" is on for every widget (W8).
export { POWERED_BY_LOCKED, POWERED_BY_LOCKED_CODE, effectivePoweredBy, asksToHidePoweredBy } from "./lib/powered-by";

// Secrets
export { getSecret, requireSecret, setSecretProvider, resetSecretProvider } from "./secrets";
export type { SecretProvider } from "./secrets";

// Middleware
export { authenticate } from "./middleware/auth";
export { requireRole, requireSystemAdmin, requireDepartmentRole } from "./middleware/rbac";
export { enforceMfaEnrollment } from "./middleware/mfa-guard";
export { requireFeature, requireTenantFeature } from "./middleware/feature-gate";
export { requirePermission, requirePermissionOrRole } from "./middleware/permission-gate";
export { visibilityClause, canViewConversation, requireVisibleConversation, visibleConversationFrom, viewerOf, type Viewer } from "./lib/conversation-visibility";
export { waitingForPersonWhere, waitingForPersonClause, WAITING_STATUSES } from "./lib/conversation-queue";
export { activityLabelKey, bareToolName, ACTIVITY_LABEL_RULES, ACTIVITY_LABEL_KEYS } from "./lib/ai-activity-labels";
export { resolveTenant, assertTenantId } from "./middleware/tenant";
export { requireActiveTenant, requireOnboardingOrActiveTenant, requirePaymentSetupAccess } from "./middleware/tenant-status";
export { validate } from "./middleware/validate";
// Admin-set tenant settings that must survive a restart. Postgres is the
// source of truth; Redis stays in front as the cache the hot paths read.
export { readDurableSetting, writeDurableSetting, settingCacheKey } from "./lib/durable-settings";
export { requireEntitlement, requireCapacity, handleEntitlementError } from "./middleware/entitlement";
// The service-level entitlement check, for code paths with no Express request:
// background subscribers, workers and queue consumers. `requireEntitlement` is
// middleware and cannot reach those, which is a large part of why commercial
// enforcement stopped at the HTTP edge.
export { isEntitled, entitledIn, resolveEntitlements, assertEntitled } from "./lib/billing/entitlement-resolver";
export { requirePlatformPermission } from "./middleware/platform-permission";

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
  declarePresence,
  effectivePresence,
  PRESENCE_STALE_AFTER_MS,
  type AgentPresenceStatus,
  type StoredPresence,
  type EffectivePresence,
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

// Per-message text direction. Direction is a property of a MESSAGE, not of
// a widget: one conversation routinely carries Hebrew prose, English
// product names and LTR URLs at once.
export {
  detectScriptDirection,
  resolveMessageDirection,
  messageDirection,
  directionForLocale,
  isRtlLocale,
  countStrongCharacters,
  stripNeutralAtoms,
  segmentBidiText,
  needsBidiIsolation,
  textAlignFor,
  inlineStartSide,
  inlineEndSide,
  RTL_LANGUAGES,
  RTL_SHARE_THRESHOLD,
  STRONG_RTL_RE,
  STRONG_LTR_RE,
  type TextDirection,
  type DirectionSetting,
  type MessageDirectionInput,
  type ResolvedMessageDirection,
  type ScriptCounts,
  type BidiSegment,
} from "./lib/text-direction";

// Grammatical address: which FORM a reply is written in, conversation-
// scoped, evidence-only. NOT an identity attribute - see the module header.
export {
  detectGrammaticalEvidence,
  updateGrammaticalAddress,
  readGrammaticalAddress,
  grammaticalAddressPromptBlock,
  validateGrammaticalAgreement,
  shouldRegenerateForAddress,
  isGenderedLanguage,
  UNKNOWN_ADDRESS,
  GENDERED_LANGUAGES,
  HEBREW_FORM_PAIRS,
  SLASH_FORM_RE,
  type GrammaticalAddress,
  type GrammaticalForm,
  type GrammaticalConfidence,
  type GrammaticalEvidence,
  type AddressUpdateInput,
  type AddressUpdateResult,
  type AddressAgreementVerdict,
} from "./lib/grammatical-address";

// Channel-native product recommendations. One canonical set produced by a
// commerce adapter, one renderer that decides how each channel shows it.
export {
  normalizeRecommendationSet,
  reconcileWithProvider,
  recommendationIdempotencyKey,
  availabilityLabel,
  priceLabel,
  RECOMMENDATION_STRINGS,
  type ProductRecommendationSet,
  type RecommendedProduct,
  type RecommendationMoney,
  type RecommendationAvailability,
  type RecommendationLocale,
  type ProviderProductRecord,
  type ReconcileResult,
} from "./lib/product-recommendations";
export {
  CHANNEL_CAPABILITIES,
  capabilitiesFor,
  TEXT_ONLY_CAPABILITIES,
  type ChannelCapabilities,
  type RecommendationChannel,
} from "./channels/capabilities";
export {
  renderProductRecommendations,
  buildProductLine,
  buildEmailHtml,
  splitForLength,
  type RenderedRecommendations,
  type RenderedMessage,
  type RenderedButton,
  type RecommendationPresentation,
  type RenderRecommendationsInput,
} from "./channels/recommendation-renderer";
export {
  recommendationSetFromShopifySnapshots,
  providerRecordsFromShopifySnapshots,
} from "./lib/shopify-live-chat";

// Capability Runtime (operation contracts + pure resolver). Strategy/provider
// impls live in services/ai and are injected via RuntimeBindings.
export * from "./lib/capability-runtime";

// Agent Contract (FROZEN architecture, Phase 1: envelope only - pure types +
// pure binder + master flag, not wired into the live path). The kernel above
// stays the single execution authority; an Agent only proposes through it.
export * from "./lib/agent";

// Sentry: four projects, production-only, scrubbed. See lib/observability.
export {
  initSentry, captureError, flushSentry, isProductionSentry,
  resolveDsn, SERVICE_PROJECT, __resetSentryForTests,
} from "./lib/observability/sentry";
export type { SentryProject, SentryInitResult } from "./lib/observability/sentry";
export { scrubEvent, scrubValue, scrubHeaders, scrubUrl, redactSecrets, REDACTED } from "./lib/observability/sentry-scrub";
export type { ScrubbableEvent } from "./lib/observability/sentry-scrub";
export { ERROR_CODES, CODE_CHANNEL } from "./lib/observability/error-codes";
export type { ErrorCode } from "./lib/observability/error-codes";
export { reportOperationalFailure, recordExpectedOutcome, buildFailureTags, projectFor, assertSafeContext, UnsafeContextError } from "./lib/observability/operational-failure";
export type { OperationalFailure, FailureDomain } from "./lib/observability/operational-failure";

// WhatsApp onboarding & multi-number architecture. Official Meta APIs only:
// a typed Graph client, the read-only Meta Inspector, and the pure flow
// selector. Message sending stays in ./channels/whatsapp.adapter.
export * from "./whatsapp";

// Types import (side-effect for Express augmentation)
import "./types/express.d";

// Per-employee allowlist of business systems (AIAgent.integrationAccess).
export {
  CUSTOM_ACCESS_PREFIX,
  customAccessKey,
  loadIntegrationAccess,
  agentGrantWhere,
  allowedIntegrationToolKeys,
  defaultIntegrationAccess,
  integrationAccessChoices,
  validateIntegrationAccess,
  type IntegrationAccessChoice,
} from "./lib/integration-access";

// No em/en dash or horizontal bar in operator-facing model text.
export { withoutWideDashes } from "./lib/wide-dash";

// "Continue on WhatsApp" from the website widget: one definition for ai and the inbound worker.
export {
  HANDOFF_REF_ALPHABET,
  HANDOFF_REF_LENGTH,
  HANDOFF_TTL_SECONDS,
  handoffRefKey,
  handoffConversationKey,
  newHandoffRef,
  handoffMessage,
  handoffButtonLabel,
  findHandoffRef,
  waMeDigits,
  waMeUrl,
  type HandoffRecord,
  type HandoffPageContext,
} from "./lib/whatsapp-handoff";

// The business's real conversations (no rehearsals, no test rows): one definition.
export { REAL_CONVERSATION } from "./lib/real-conversation";
export { isWorkspaceDay, dayStart, dayOf, nextWorkspaceDay, workspaceDayWindow } from "./lib/workspace-days";

// The customer-service window (WhatsApp 24h then template only; Instagram/Messenger 24h then closed).
export {
  REPLY_WINDOW_MS,
  hasReplyWindow,
  replyWindowFor,
  sendAllowed,
  lastInboundAtForRecipient,
  replyWindowsFor,
} from "./lib/reply-window";
export type { ReplyWindow, ReplyWindowMode, ReplyWindowRefusal } from "./lib/reply-window";
export { buildTemplateComponents, renderTemplateText, extractPlaceholders as templatePlaceholders } from "./lib/template-components";
export { agentToolLevelsKey, stricterLevel, allowedEmployeeLevels, readAgentToolLevels, writeAgentToolLevel } from "./lib/agent-tool-levels";
// An AI employee's own free-text rules (customGuardrails): one shape, one set of limits (B4).
export { MAX_RULE_LEN, MAX_RULES, GuardrailsError, normalizeGuardrails, readGuardrails, clampGuardrails } from "./lib/guardrails";
export type { ToolLevel, EmployeeToolLevel } from "./lib/agent-tool-levels";
