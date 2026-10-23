/**
 * Every tenant-scoped table that deleting the Tenant row does NOT reach.
 *
 * The Tenant delete cascades through every model with a
 * `tenant Tenant @relation(onDelete: Cascade)` and through their own cascading
 * children. The models below carry a tenantId with no such path, so a tenant
 * delete used to leave them behind - including live OAuth tokens
 * (tenant_integrations, tenant_tools, calendar_accounts, commerce_connections,
 * shopify_chat_installations).
 *
 * Each one is either deleted explicitly by eraseTenant or kept on purpose.
 * tenant-erasure-tables.test.ts reads schema.prisma and fails when a model
 * with a tenantId is in neither list and not reached by the cascade, so a
 * table added later cannot be silently orphaned again.
 */

/**
 * Deleted with `deleteMany({ where: { tenantId } })`, in this order: children
 * before the parents they reference, so no Restrict/SetNull edge can fail or
 * leave a dangling row mid-transaction.
 */
export const ERASED_EXPLICITLY = [
  // Children first.
  "agentLoopIteration",
  "assistantMessage",
  "discoveryActionAttempt",
  "discoveryFact",
  "discoveryQuestion",
  "opportunity",
  "toolExecution",
  "tenantTool",
  "paymentContinuationLink",
  "actionContractProgress",
  "intelligenceReview",
  "intelligenceFact",
  // Then the rest.
  "actionContract",
  "agentCustomerMemory",
  "agentLoopRun",
  "agentScore",
  "approvalRequest",
  "assistantThread",
  "businessActionPolicy",
  "businessPolicy",
  "calendarAccount",
  "commerceConnection",
  "conversationUsageAggregate",
  "copilotCueOutcome",
  "customApiTool",
  "customDbQueryTool",
  "customerBrief",
  "customerProfile",
  "customerVerification",
  "discoverySession",
  "fieldDefinition",
  "identityLinkSuggestion",
  "intelligencePack",
  "meetingBooking",
  "meetingType",
  "notificationLog",
  "policyDecision",
  "postConversationConfig",
  "reasonerShadowEval",
  "shopifyChatInstallation",
  "stageTransition",
  "systemAgentMessage",
  "tenantFunnel",
  "tenantToolPermission",
  "tenantIntegration",
  "tokenizationSession",
  "usageLog",
  // Already deleted before this list existed.
  "consentRecord",
  "dataRetentionPolicy",
  "dataSubjectRequest",
  // Last: the deletion's own audit row is written after this, so it survives.
  "auditLog",
] as const;

/**
 * Kept on purpose (Omer, 2026-10-23): the money trail. Accounting needs it after
 * the organization is gone, and none of it is a credential or customer content.
 * The tenant id stays on these rows as plain text.
 */
export const KEPT_FINANCIAL: Record<string, string> = {
  PaymentAttempt: "every attempt to take money, and its outcome",
  BillingWebhookEvent: "the provider's own record of each payment event",
  CreditTransaction: "credit purchases and grants",
  PendingCheckout: "closed checkouts (an open one refuses the delete)",
  PaymentQuote: "the price and FX rate a payment was quoted at",
  ProviderCustomer: "the iCount customer mapping",
  ProviderSubscription: "provider-billed subscription history (an active Shopify one refuses the delete)",
  TenantBillingProvisioningRequest: "what plan was requested, by whom",
  BillingPolicyDecision: "why a billing rule allowed or refused something",
  ShopifyGrandfatherGrant: "a Shopify grandfathering decision",
  UsageLedgerEntry: "metered usage that was or will be billed",
  BillingOutboxEntry: "usage records owed to a provider",
  Plan: "a custom plan a kept subscription is pinned to",
};
