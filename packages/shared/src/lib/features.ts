/**
 * Feature registry — single source of truth for all gateable features.
 *
 * Two-layer permission model:
 *   1. Tenant-level (SYSTEM_ADMIN controlled) — availability per organization
 *      → backed by the `tenant_features` table.
 *   2. User-level (tenant ADMIN controlled) — access within availability
 *      → resolved from custom tenant roles + per-user grant/revoke overrides.
 *
 * To add a feature: add a key here + a metadata entry in FEATURE_METADATA.
 * If the feature replaces an existing Boolean column on `Tenant`, set
 * `legacyColumn` so the resolver can fall back to it for rows that haven't
 * been backfilled yet.
 *
 * ── Note on overlap ─────────────────────────────────────────────────
 * This is the FULL mapped surface of the product. Some entries overlap
 * (e.g. `confluence_integration` vs `confluence_knowledge`,
 * `google_drive_integration` vs `google_drive_knowledge`). Curate the
 * list down to the gates you actually want to expose — deleting a key
 * here automatically hides it from the SYSTEM_ADMIN UI and tenant
 * permissions page.
 */

export const FEATURES = {
  // ── Messaging channels ──────────────────────────────────────
  CHANNEL_WHATSAPP: "channel_whatsapp",
  CHANNEL_MESSENGER: "channel_messenger",
  CHANNEL_INSTAGRAM: "channel_instagram",
  CHANNEL_EMAIL: "channel_email",
  CHANNEL_GMAIL: "channel_gmail",
  CHANNEL_OUTLOOK: "channel_outlook",
  CHANNEL_SLACK: "channel_slack",
  CHANNEL_WEBCHAT: "channel_webchat",
  SHOPIFY_LIVE_CHAT: "shopify_live_chat",
  SHOPIFY_PRODUCT_MESSAGING: "shopify_product_messaging",

  // ── Messaging — conversation operations ─────────────────────
  CONVERSATION_MANAGEMENT: "conversation_management",
  CLOSE_CONVERSATION: "close_conversation",
  REASSIGN_CONVERSATION: "reassign_conversation",
  VIEW_OTHER_AGENTS_CONVERSATIONS: "view_other_agents_conversations",
  MESSAGE_MEDIA_UPLOAD: "message_media_upload",
  MESSAGE_TEMPLATES: "message_templates",
  MESSAGE_APPROVAL: "message_approval",
  BROADCAST_CAMPAIGNS: "broadcast_campaigns",

  // ── Voice ───────────────────────────────────────────────────
  VOICE_INBOX_UI: "voice_inbox_ui",
  VOICE_INCOMING: "voice_incoming",
  INBOUND_VOICE: "inbound_voice",
  OUTBOUND_CALLING: "outbound_calling",
  CALL_RECORDING: "call_recording",
  CALL_COPILOT: "call_copilot",
  VOICE_PARTICIPANT_MANAGEMENT: "voice_participant_management",
  VOICE_SESSION_MANAGEMENT: "voice_session_management",
  // legacy alias (preserved for back-compat)
  VOICE_COPILOT: "voice_copilot",

  // ── AI ──────────────────────────────────────────────────────
  BOT: "bot",
  FIRST_TAKE_CARE: "first_take_care",
  AI_AGENTS: "ai_agents",
  AI_ASSIST: "ai_assist",
  AUTONOMOUS_AI_MODE: "autonomous_ai_mode",
  CHATBOT_FLOW_BUILDER: "chatbot_flow_builder",
  CUSTOMER_BRIEFS: "customer_briefs",
  POST_CALL_ANALYSIS: "post_call_analysis",
  ROUTER_RULES: "router_rules",
  KNOWLEDGE_BASE: "knowledge_base", // legacy alias kept

  // ── Knowledge ───────────────────────────────────────────────
  KNOWLEDGE_BASE_RAG: "knowledge_base_rag",
  DOCUMENT_MANAGEMENT: "document_management",
  CONFLUENCE_KNOWLEDGE: "confluence_knowledge",
  GOOGLE_DRIVE_KNOWLEDGE: "google_drive_knowledge",

  // ── CRM ─────────────────────────────────────────────────────
  CRM_AUTO_LINKING: "crm_auto_linking",
  CRM_CONTACT_SYNC: "crm_contact_sync",
  CUSTOMER_DATA_RETRIEVAL: "customer_data_retrieval",
  IDENTITY_RESOLUTION: "identity_resolution",
  ZOHO_CRM_INTEGRATION: "zoho_crm_integration",
  HUBSPOT_INTEGRATION: "hubspot_integration",
  SALESFORCE_INTEGRATION: "salesforce_integration",

  // ── Automation ──────────────────────────────────────────────
  WORKFLOW_CREATION: "workflow_creation",
  SCHEDULED_MESSAGES: "scheduled_messages",
  AUDIENCE_BUILDER: "audience_builder",
  FUNNEL_ADMINISTRATION: "funnel_administration",
  ACTION_CONTRACTS: "action_contracts",

  // ── Commerce ────────────────────────────────────────────────
  AUTO_BUY: "auto_buy",
  ORDER_MANAGEMENT: "order_management",

  // ── Integrations ────────────────────────────────────────────
  SHOPIFY_INTEGRATION: "shopify_integration",
  WOOCOMMERCE_INTEGRATION: "woocommerce_integration",
  WIX_INTEGRATION: "wix_integration",
  STRIPE_INTEGRATION: "stripe_integration",
  PAYPAL_INTEGRATION: "paypal_integration",
  SQUARE_INTEGRATION: "square_integration",
  CALENDAR_INTEGRATION: "calendar_integration",
  GOOGLE_DRIVE_INTEGRATION: "google_drive_integration",
  CONFLUENCE_INTEGRATION: "confluence_integration",
  AIRTABLE_INTEGRATION: "airtable_integration",
  MONDAY_INTEGRATION: "monday_integration",
  CUSTOM_API_TOOLS: "custom_api_tools",
  CUSTOM_DATABASE_TOOLS: "custom_database_tools",
  POSTGRESQL_INTEGRATION: "postgresql_integration",
  MONGODB_INTEGRATION: "mongodb_integration",
  AWS_RDS_INTEGRATION: "aws_rds_integration",

  // ── Analytics ───────────────────────────────────────────────
  DASHBOARD_ANALYTICS: "dashboard_analytics",
  CONVERSATION_ANALYTICS: "conversation_analytics",
  AGENT_PERFORMANCE_SCORING: "agent_performance_scoring",

  // ── Notifications ───────────────────────────────────────────
  IN_APP_NOTIFICATIONS: "in_app_notifications",
  EMAIL_NOTIFICATIONS: "email_notifications",
  PUSH_NOTIFICATIONS: "push_notifications",
  NOTIFICATION_SOUND: "notification_sound",

  // ── Admin ───────────────────────────────────────────────────
  AGENT_MANAGEMENT: "agent_management",
  DEPARTMENT_MANAGEMENT: "department_management",
  CHANNEL_MANAGEMENT: "channel_management",
  INTEGRATION_SETUP: "integration_setup",
  TENANT_SETTINGS: "tenant_settings",
  POLICY_ADMINISTRATION: "policy_administration",
  TOOL_MANAGEMENT: "tool_management",
  PERMISSION_MANAGEMENT: "permission_management",
  NOTIFICATION_SETTINGS: "notification_settings",
  USAGE_TRACKING: "usage_tracking",
} as const;

export type Feature = (typeof FEATURES)[keyof typeof FEATURES];

export type FeatureCategory =
  | "messaging"
  | "voice"
  | "ai"
  | "knowledge"
  | "crm"
  | "automation"
  | "commerce"
  | "integrations"
  | "analytics"
  | "notifications"
  | "admin";

export interface FeatureMetadata {
  key: Feature;
  displayName: string;
  description: string;
  category: FeatureCategory;
  /** Default state when a TenantFeature row is missing. */
  defaultEnabled: boolean;
  /**
   * Default role-level access for AGENT users.
   * - "none" → AGENT needs an explicit role/user grant
   * - "all"  → AGENT gets it automatically when the tenant has it enabled
   * ADMIN always gets every tenant-enabled feature.
   * SYSTEM_ADMIN bypasses all checks.
   */
  defaultAgentAccess: "none" | "all";
  /**
   * Optional legacy `Tenant` column name. If set, the resolver falls back to
   * `tenant[legacyColumn]` when no TenantFeature row exists. Lets old code
   * paths keep working until call sites are migrated and the column dropped.
   */
  legacyColumn?: string;
}

// Helper to keep entries compact below.
const m = (
  key: Feature,
  category: FeatureCategory,
  displayName: string,
  description: string,
  defaultAgentAccess: "all" | "none",
  legacyColumn?: string,
): FeatureMetadata => ({
  key,
  category,
  displayName,
  description,
  defaultAgentAccess,
  defaultEnabled: false,
  legacyColumn,
});

export const FEATURE_METADATA: Record<Feature, FeatureMetadata> = {
  // ── Messaging — channels ────────────────────────────────────
  [FEATURES.CHANNEL_WHATSAPP]: m(FEATURES.CHANNEL_WHATSAPP, "messaging", "WhatsApp Channel", "Send and receive messages via WhatsApp.", "all"),
  [FEATURES.CHANNEL_MESSENGER]: m(FEATURES.CHANNEL_MESSENGER, "messaging", "Facebook Messenger Channel", "Send and receive messages via Messenger.", "all"),
  [FEATURES.CHANNEL_INSTAGRAM]: m(FEATURES.CHANNEL_INSTAGRAM, "messaging", "Instagram Channel", "Send and receive messages via Instagram DMs.", "all"),
  [FEATURES.CHANNEL_EMAIL]: m(FEATURES.CHANNEL_EMAIL, "messaging", "Email Channel", "Send and receive messages via generic email.", "all"),
  [FEATURES.CHANNEL_GMAIL]: m(FEATURES.CHANNEL_GMAIL, "messaging", "Gmail Channel", "Send and receive messages via Gmail.", "all"),
  [FEATURES.CHANNEL_OUTLOOK]: m(FEATURES.CHANNEL_OUTLOOK, "messaging", "Outlook Channel", "Send and receive messages via Outlook.", "all"),
  [FEATURES.CHANNEL_SLACK]: m(FEATURES.CHANNEL_SLACK, "messaging", "Slack Channel", "Send and receive messages via Slack.", "all"),
  [FEATURES.CHANNEL_WEBCHAT]: m(FEATURES.CHANNEL_WEBCHAT, "messaging", "Webchat Channel", "Embedded chat widget on websites.", "all"),
  [FEATURES.SHOPIFY_LIVE_CHAT]: m(FEATURES.SHOPIFY_LIVE_CHAT, "messaging", "Shopify Live Chat", "Branded live chat installed on a Shopify storefront through a Theme App Extension.", "all"),
  [FEATURES.SHOPIFY_PRODUCT_MESSAGING]: m(FEATURES.SHOPIFY_PRODUCT_MESSAGING, "commerce", "Shopify Product Messaging", "Send Shopify product cards, carousels and Add to Cart actions inside a conversation.", "all"),

  // ── Messaging — conversation operations ─────────────────────
  [FEATURES.CONVERSATION_MANAGEMENT]: m(FEATURES.CONVERSATION_MANAGEMENT, "messaging", "Conversation Management", "View and manage customer conversations.", "all"),
  [FEATURES.CLOSE_CONVERSATION]: m(FEATURES.CLOSE_CONVERSATION, "messaging", "Close Conversation", "Agents can close conversations.", "all"),
  [FEATURES.REASSIGN_CONVERSATION]: m(FEATURES.REASSIGN_CONVERSATION, "messaging", "Reassign Conversation", "Transfer a conversation to another agent.", "all"),
  [FEATURES.VIEW_OTHER_AGENTS_CONVERSATIONS]: m(FEATURES.VIEW_OTHER_AGENTS_CONVERSATIONS, "messaging", "View Other Agents' Conversations", "Visibility into conversations assigned to other agents.", "none"),
  [FEATURES.MESSAGE_MEDIA_UPLOAD]: m(FEATURES.MESSAGE_MEDIA_UPLOAD, "messaging", "Media Upload", "Send images, videos, and documents in messages.", "all"),
  [FEATURES.MESSAGE_TEMPLATES]: m(FEATURES.MESSAGE_TEMPLATES, "messaging", "Message Templates", "Create and reuse message templates.", "all"),
  [FEATURES.MESSAGE_APPROVAL]: m(FEATURES.MESSAGE_APPROVAL, "messaging", "Message Approval", "Require approval (HITL) for outbound messages.", "none"),
  [FEATURES.BROADCAST_CAMPAIGNS]: m(FEATURES.BROADCAST_CAMPAIGNS, "messaging", "Broadcast Campaigns", "Send bulk messaging campaigns.", "none"),

  // ── Voice ───────────────────────────────────────────────────
  [FEATURES.VOICE_INBOX_UI]: m(FEATURES.VOICE_INBOX_UI, "voice", "Voice Inbox UI", "Render live-call section and active-call bar in the inbox.", "all", "voiceInboxUiEnabled"),
  [FEATURES.VOICE_INCOMING]: m(FEATURES.VOICE_INCOMING, "voice", "Voice Inbound (BYO)", "Accept inbound voice webhooks for BYO channels.", "all", "voiceIncomingEnabled"),
  [FEATURES.INBOUND_VOICE]: m(FEATURES.INBOUND_VOICE, "voice", "Inbound Voice Channel", "Receive inbound phone calls.", "all"),
  [FEATURES.OUTBOUND_CALLING]: m(FEATURES.OUTBOUND_CALLING, "voice", "Outbound Calling", "Make outbound phone calls to customers.", "all"),
  [FEATURES.CALL_RECORDING]: m(FEATURES.CALL_RECORDING, "voice", "Call Recording", "Record and replay voice calls.", "all"),
  [FEATURES.CALL_COPILOT]: m(FEATURES.CALL_COPILOT, "voice", "Live Call Copilot", "Real-time AI suggestions during phone calls.", "all"),
  [FEATURES.VOICE_COPILOT]: m(FEATURES.VOICE_COPILOT, "voice", "Voice Copilot (legacy)", "Master switch for Phase-1 voice copilot paths.", "all", "voiceCopilotEnabled"),
  [FEATURES.VOICE_PARTICIPANT_MANAGEMENT]: m(FEATURES.VOICE_PARTICIPANT_MANAGEMENT, "voice", "Voice Participants", "Add participants to active voice calls.", "all"),
  [FEATURES.VOICE_SESSION_MANAGEMENT]: m(FEATURES.VOICE_SESSION_MANAGEMENT, "voice", "Voice Session Management", "Manage active voice call sessions.", "all"),

  // ── AI ──────────────────────────────────────────────────────
  [FEATURES.BOT]: m(FEATURES.BOT, "ai", "Chatbot (master)", "Master switch for automated bot replies.", "all", "botEnabled"),
  [FEATURES.FIRST_TAKE_CARE]: m(FEATURES.FIRST_TAKE_CARE, "ai", "First Take Care", "Bot answers first customer message before human handoff.", "all", "firstTakeCareEnabled"),
  [FEATURES.AI_AGENTS]: m(FEATURES.AI_AGENTS, "ai", "AI Agents", "Create and manage custom AI team members in AI Studio.", "all"),
  [FEATURES.AI_ASSIST]: m(FEATURES.AI_ASSIST, "ai", "Agent Assist (Copilot)", "Real-time AI suggestions for human agents.", "all"),
  [FEATURES.AUTONOMOUS_AI_MODE]: m(FEATURES.AUTONOMOUS_AI_MODE, "ai", "Autonomous AI Mode", "Allow bots to handle conversations independently.", "all"),
  [FEATURES.CHATBOT_FLOW_BUILDER]: m(FEATURES.CHATBOT_FLOW_BUILDER, "ai", "Chatbot Flow Builder", "Visual flow editor for conversation automation.", "all"),
  [FEATURES.CUSTOMER_BRIEFS]: m(FEATURES.CUSTOMER_BRIEFS, "ai", "Customer Briefs", "AI-generated customer context summaries.", "all"),
  [FEATURES.POST_CALL_ANALYSIS]: m(FEATURES.POST_CALL_ANALYSIS, "ai", "Post-Call Analysis", "AI analysis of voice conversations.", "all"),
  [FEATURES.ROUTER_RULES]: m(FEATURES.ROUTER_RULES, "ai", "Router Rules (Main Playbook)", "Rules-based routing to agents and bots.", "all"),
  [FEATURES.KNOWLEDGE_BASE]: m(FEATURES.KNOWLEDGE_BASE, "ai", "Knowledge Base (legacy)", "Legacy alias — prefer knowledge_base_rag.", "all"),

  // ── Knowledge ───────────────────────────────────────────────
  [FEATURES.KNOWLEDGE_BASE_RAG]: m(FEATURES.KNOWLEDGE_BASE_RAG, "knowledge", "Knowledge Base (RAG)", "Document management and retrieval-augmented generation.", "all"),
  [FEATURES.DOCUMENT_MANAGEMENT]: m(FEATURES.DOCUMENT_MANAGEMENT, "knowledge", "Knowledge Documents", "Upload and manage knowledge base documents.", "all"),
  [FEATURES.CONFLUENCE_KNOWLEDGE]: m(FEATURES.CONFLUENCE_KNOWLEDGE, "knowledge", "Confluence Knowledge Sync", "Sync knowledge from Confluence spaces.", "all"),
  [FEATURES.GOOGLE_DRIVE_KNOWLEDGE]: m(FEATURES.GOOGLE_DRIVE_KNOWLEDGE, "knowledge", "Google Drive Knowledge Sync", "Sync knowledge from Google Drive folders.", "all"),

  // ── CRM ─────────────────────────────────────────────────────
  [FEATURES.CRM_AUTO_LINKING]: m(FEATURES.CRM_AUTO_LINKING, "crm", "CRM Auto-Linking", "Automatic customer identification and CRM linking.", "all"),
  [FEATURES.CRM_CONTACT_SYNC]: m(FEATURES.CRM_CONTACT_SYNC, "crm", "Contact Sync", "Sync customer data between ChatCenter and CRM.", "all"),
  [FEATURES.CUSTOMER_DATA_RETRIEVAL]: m(FEATURES.CUSTOMER_DATA_RETRIEVAL, "crm", "Customer Data Retrieval", "Pull customer info from CRM systems.", "all"),
  [FEATURES.IDENTITY_RESOLUTION]: m(FEATURES.IDENTITY_RESOLUTION, "crm", "Identity Unification", "Merge and identify customers across channels.", "all"),
  [FEATURES.ZOHO_CRM_INTEGRATION]: m(FEATURES.ZOHO_CRM_INTEGRATION, "crm", "Zoho CRM", "Connect to Zoho CRM.", "all"),
  [FEATURES.HUBSPOT_INTEGRATION]: m(FEATURES.HUBSPOT_INTEGRATION, "crm", "HubSpot", "Connect to HubSpot for CRM capabilities.", "all"),
  [FEATURES.SALESFORCE_INTEGRATION]: m(FEATURES.SALESFORCE_INTEGRATION, "crm", "Salesforce", "Connect to Salesforce for enterprise CRM.", "all"),

  // ── Automation ──────────────────────────────────────────────
  [FEATURES.WORKFLOW_CREATION]: m(FEATURES.WORKFLOW_CREATION, "automation", "Workflows", "Build automated sequences triggered by events.", "all"),
  [FEATURES.SCHEDULED_MESSAGES]: m(FEATURES.SCHEDULED_MESSAGES, "automation", "Scheduled Messages", "Schedule outbound messages for future delivery.", "all"),
  [FEATURES.AUDIENCE_BUILDER]: m(FEATURES.AUDIENCE_BUILDER, "automation", "Audience Builder", "Segment customers for campaigns and automation.", "all"),
  [FEATURES.FUNNEL_ADMINISTRATION]: m(FEATURES.FUNNEL_ADMINISTRATION, "automation", "Funnels", "Create sales/support funnels with stages.", "all"),
  [FEATURES.ACTION_CONTRACTS]: m(FEATURES.ACTION_CONTRACTS, "automation", "Action Contracts", "Pre-defined action templates for workflows.", "all"),

  // ── Commerce ────────────────────────────────────────────────
  [FEATURES.AUTO_BUY]: m(FEATURES.AUTO_BUY, "commerce", "Auto-Buy", "Automated purchasing flows triggered from conversations.", "none"),
  [FEATURES.ORDER_MANAGEMENT]: m(FEATURES.ORDER_MANAGEMENT, "commerce", "Order Management", "Look up and manage orders from e-commerce systems.", "all"),

  // ── Integrations ────────────────────────────────────────────
  [FEATURES.SHOPIFY_INTEGRATION]: m(FEATURES.SHOPIFY_INTEGRATION, "integrations", "Shopify", "E-commerce integration for orders and inventory.", "all"),
  [FEATURES.WOOCOMMERCE_INTEGRATION]: m(FEATURES.WOOCOMMERCE_INTEGRATION, "integrations", "WooCommerce", "Connect to WooCommerce shops.", "all"),
  [FEATURES.WIX_INTEGRATION]: m(FEATURES.WIX_INTEGRATION, "integrations", "Wix", "Connect to Wix e-commerce.", "all"),
  [FEATURES.STRIPE_INTEGRATION]: m(FEATURES.STRIPE_INTEGRATION, "integrations", "Stripe", "Payment processing and refunds via Stripe.", "all"),
  [FEATURES.PAYPAL_INTEGRATION]: m(FEATURES.PAYPAL_INTEGRATION, "integrations", "PayPal", "Payment processing and transaction lookup.", "all"),
  [FEATURES.SQUARE_INTEGRATION]: m(FEATURES.SQUARE_INTEGRATION, "integrations", "Square", "Payment processing via Square.", "all"),
  [FEATURES.CALENDAR_INTEGRATION]: m(FEATURES.CALENDAR_INTEGRATION, "integrations", "Calendar (Google / Calendly)", "Calendar integration for scheduling.", "all"),
  [FEATURES.GOOGLE_DRIVE_INTEGRATION]: m(FEATURES.GOOGLE_DRIVE_INTEGRATION, "integrations", "Google Drive", "Sync documents from Google Drive.", "all"),
  [FEATURES.CONFLUENCE_INTEGRATION]: m(FEATURES.CONFLUENCE_INTEGRATION, "integrations", "Confluence", "Pull knowledge from Confluence.", "all"),
  [FEATURES.AIRTABLE_INTEGRATION]: m(FEATURES.AIRTABLE_INTEGRATION, "integrations", "Airtable", "Connect to Airtable for data access.", "all"),
  [FEATURES.MONDAY_INTEGRATION]: m(FEATURES.MONDAY_INTEGRATION, "integrations", "Monday.com", "Connect to Monday.com for project management.", "all"),
  [FEATURES.CUSTOM_API_TOOLS]: m(FEATURES.CUSTOM_API_TOOLS, "integrations", "Custom API Tools", "Create custom HTTP-based tool integrations.", "all"),
  [FEATURES.CUSTOM_DATABASE_TOOLS]: m(FEATURES.CUSTOM_DATABASE_TOOLS, "integrations", "Custom Database Tools", "Define custom SQL/Mongo query tools.", "all"),
  [FEATURES.POSTGRESQL_INTEGRATION]: m(FEATURES.POSTGRESQL_INTEGRATION, "integrations", "PostgreSQL", "Query and update PostgreSQL databases.", "all"),
  [FEATURES.MONGODB_INTEGRATION]: m(FEATURES.MONGODB_INTEGRATION, "integrations", "MongoDB", "Query and update MongoDB databases.", "all"),
  [FEATURES.AWS_RDS_INTEGRATION]: m(FEATURES.AWS_RDS_INTEGRATION, "integrations", "AWS RDS", "Query and update AWS RDS databases.", "all"),

  // ── Analytics ───────────────────────────────────────────────
  [FEATURES.DASHBOARD_ANALYTICS]: m(FEATURES.DASHBOARD_ANALYTICS, "analytics", "Dashboard Analytics", "Real-time metrics and dashboards.", "all"),
  [FEATURES.CONVERSATION_ANALYTICS]: m(FEATURES.CONVERSATION_ANALYTICS, "analytics", "Conversation Analytics", "Insights into conversation patterns and outcomes.", "all"),
  [FEATURES.AGENT_PERFORMANCE_SCORING]: m(FEATURES.AGENT_PERFORMANCE_SCORING, "analytics", "Agent Performance Scoring", "AI-based QA and performance metrics per agent.", "none"),

  // ── Notifications ───────────────────────────────────────────
  [FEATURES.IN_APP_NOTIFICATIONS]: m(FEATURES.IN_APP_NOTIFICATIONS, "notifications", "In-App Notifications", "Receive notifications in app UI.", "all"),
  [FEATURES.EMAIL_NOTIFICATIONS]: m(FEATURES.EMAIL_NOTIFICATIONS, "notifications", "Email Notifications", "Receive notifications via email.", "all"),
  [FEATURES.PUSH_NOTIFICATIONS]: m(FEATURES.PUSH_NOTIFICATIONS, "notifications", "Mobile Push Notifications", "Receive notifications on mobile devices.", "all"),
  [FEATURES.NOTIFICATION_SOUND]: m(FEATURES.NOTIFICATION_SOUND, "notifications", "Notification Sound", "Audio alert for new messages.", "all"),

  // ── Admin ───────────────────────────────────────────────────
  [FEATURES.AGENT_MANAGEMENT]: m(FEATURES.AGENT_MANAGEMENT, "admin", "Agent Management", "Create, edit, enable/disable user accounts and roles.", "none"),
  [FEATURES.DEPARTMENT_MANAGEMENT]: m(FEATURES.DEPARTMENT_MANAGEMENT, "admin", "Department Management", "Create departments, manage hierarchy, SLA settings.", "none"),
  [FEATURES.CHANNEL_MANAGEMENT]: m(FEATURES.CHANNEL_MANAGEMENT, "admin", "Channel Management", "Configure connected messaging channels.", "none"),
  [FEATURES.INTEGRATION_SETUP]: m(FEATURES.INTEGRATION_SETUP, "admin", "Integration Setup", "Install and configure third-party integrations.", "none"),
  [FEATURES.TENANT_SETTINGS]: m(FEATURES.TENANT_SETTINGS, "admin", "Tenant Settings", "Organization-level configuration and defaults.", "none"),
  [FEATURES.POLICY_ADMINISTRATION]: m(FEATURES.POLICY_ADMINISTRATION, "admin", "Policy Administration", "Create and manage business rules and escalation policies.", "none"),
  [FEATURES.TOOL_MANAGEMENT]: m(FEATURES.TOOL_MANAGEMENT, "admin", "Tool Management", "Enable/disable tools and configure approval requirements.", "none"),
  [FEATURES.PERMISSION_MANAGEMENT]: m(FEATURES.PERMISSION_MANAGEMENT, "admin", "Permission Management", "Define custom roles and grant user permissions.", "none"),
  [FEATURES.NOTIFICATION_SETTINGS]: m(FEATURES.NOTIFICATION_SETTINGS, "admin", "Notification Settings", "Configure notification channels and delivery rules.", "none"),
  [FEATURES.USAGE_TRACKING]: m(FEATURES.USAGE_TRACKING, "admin", "Usage & Billing", "View organization usage metrics and costs.", "none"),
};

export const ALL_FEATURES: readonly Feature[] = Object.values(FEATURES);

export function isFeature(value: string): value is Feature {
  return value in FEATURE_METADATA;
}

export function getFeatureMetadata(feature: Feature): FeatureMetadata {
  return FEATURE_METADATA[feature];
}

export function listFeaturesByCategory(): Record<FeatureCategory, FeatureMetadata[]> {
  const grouped = {} as Record<FeatureCategory, FeatureMetadata[]>;
  for (const meta of Object.values(FEATURE_METADATA)) {
    (grouped[meta.category] ||= []).push(meta);
  }
  return grouped;
}
