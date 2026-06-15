# Feature Registry

Complete mapping of every gateable product feature in ChatCenter / GOTCHA, used by the two-layer permission system.

- **Tenant layer** (SYSTEM_ADMIN controlled): which features are *available* to a tenant.
- **User layer** (tenant ADMIN controlled): which users can *access* the available features (via custom roles + per-user overrides).

**Default for AGENT** = whether a regular AGENT user gets the feature automatically when the tenant has it enabled (`all`), or needs an explicit role/user grant (`none`). `ADMIN` always gets every tenant-enabled feature. `SYSTEM_ADMIN` bypasses every check.

All features ship with `defaultEnabled: false` - a brand-new tenant starts with nothing on until SYSTEM_ADMIN flips toggles.

Source of truth: [`packages/shared/src/lib/features.ts`](../packages/shared/src/lib/features.ts)

---

## Messaging (16)

| Key | Display Name | AGENT Default | Description |
|---|---|---|---|
| `channel_whatsapp` | WhatsApp Channel | all | Send and receive messages via WhatsApp |
| `channel_messenger` | Facebook Messenger Channel | all | Send and receive messages via Messenger |
| `channel_instagram` | Instagram Channel | all | Send and receive messages via Instagram DMs |
| `channel_email` | Email Channel | all | Send and receive messages via generic email |
| `channel_gmail` | Gmail Channel | all | Send and receive messages via Gmail |
| `channel_outlook` | Outlook Channel | all | Send and receive messages via Outlook |
| `channel_slack` | Slack Channel | all | Send and receive messages via Slack |
| `channel_webchat` | Webchat Channel | all | Embedded chat widget on websites |
| `conversation_management` | Conversation Management | all | View and manage customer conversations |
| `close_conversation` | Close Conversation | all | Agents can close conversations |
| `reassign_conversation` | Reassign Conversation | all | Transfer a conversation to another agent |
| `view_other_agents_conversations` | View Other Agents' Conversations | **none** | Visibility into conversations assigned to others |
| `message_media_upload` | Media Upload | all | Send images, videos, documents in messages |
| `message_templates` | Message Templates | all | Create and reuse message templates |
| `message_approval` | Message Approval | **none** | Require approval (HITL) for outbound messages |
| `broadcast_campaigns` | Broadcast Campaigns | **none** | Send bulk messaging campaigns |

## Voice (9)

| Key | Display Name | AGENT Default | Description |
|---|---|---|---|
| `voice_inbox_ui` | Voice Inbox UI | all | Live-call section + active-call bar in the inbox *(legacy column: `voice_inbox_ui_enabled`)* |
| `voice_incoming` | Voice Inbound (BYO) | all | Accept inbound voice webhooks for BYO channels *(legacy column: `voice_incoming_enabled`)* |
| `inbound_voice` | Inbound Voice Channel | all | Receive inbound phone calls |
| `outbound_calling` | Outbound Calling | all | Make outbound phone calls to customers |
| `call_recording` | Call Recording | all | Record and replay voice calls |
| `call_copilot` | Live Call Copilot | all | Real-time AI suggestions during phone calls |
| `voice_copilot` | Voice Copilot (legacy) | all | Master switch for Phase-1 voice copilot *(legacy column: `voice_copilot_enabled`)* |
| `voice_participant_management` | Voice Participants | all | Add participants to active voice calls |
| `voice_session_management` | Voice Session Management | all | Manage active voice call sessions |

## AI (10)

| Key | Display Name | AGENT Default | Description |
|---|---|---|---|
| `bot` | Chatbot (master) | all | Master switch for bot replies *(legacy column: `bot_enabled`)* |
| `first_take_care` | First Take Care | all | Bot answers first message before human handoff *(legacy column: `first_take_care_enabled`)* |
| `ai_agents` | AI Agents | all | Create and manage custom AI team members in AI Studio |
| `ai_assist` | Agent Assist (Copilot) | all | Real-time AI suggestions for human agents |
| `autonomous_ai_mode` | Autonomous AI Mode | all | Allow bots to handle conversations independently |
| `chatbot_flow_builder` | Chatbot Flow Builder | all | Visual flow editor for conversation automation |
| `customer_briefs` | Customer Briefs | all | AI-generated customer context summaries |
| `post_call_analysis` | Post-Call Analysis | all | AI analysis of voice conversations |
| `router_rules` | Router Rules (Main Playbook) | all | Rules-based routing to agents and bots |
| `knowledge_base` | Knowledge Base (legacy) | all | Legacy alias - prefer `knowledge_base_rag` |

## Knowledge (4)

| Key | Display Name | AGENT Default | Description |
|---|---|---|---|
| `knowledge_base_rag` | Knowledge Base (RAG) | all | Document management and retrieval-augmented generation |
| `document_management` | Knowledge Documents | all | Upload and manage knowledge base documents |
| `confluence_knowledge` | Confluence Knowledge Sync | all | Sync knowledge from Confluence spaces |
| `google_drive_knowledge` | Google Drive Knowledge Sync | all | Sync knowledge from Google Drive folders |

## CRM (7)

| Key | Display Name | AGENT Default | Description |
|---|---|---|---|
| `crm_auto_linking` | CRM Auto-Linking | all | Automatic customer identification and CRM linking |
| `crm_contact_sync` | Contact Sync | all | Sync customer data between ChatCenter and CRM |
| `customer_data_retrieval` | Customer Data Retrieval | all | Pull customer info from CRM systems |
| `identity_resolution` | Identity Unification | all | Merge and identify customers across channels |
| `zoho_crm_integration` | Zoho CRM | all | Connect to Zoho CRM |
| `hubspot_integration` | HubSpot | all | Connect to HubSpot for CRM capabilities |
| `salesforce_integration` | Salesforce | all | Connect to Salesforce for enterprise CRM |

## Automation (5)

| Key | Display Name | AGENT Default | Description |
|---|---|---|---|
| `workflow_creation` | Workflows | all | Build automated sequences triggered by events |
| `scheduled_messages` | Scheduled Messages | all | Schedule outbound messages for future delivery |
| `audience_builder` | Audience Builder | all | Segment customers for campaigns and automation |
| `funnel_administration` | Funnels | all | Create sales/support funnels with stages |
| `action_contracts` | Action Contracts | all | Pre-defined action templates for workflows |

## Commerce (2)

| Key | Display Name | AGENT Default | Description |
|---|---|---|---|
| `auto_buy` | Auto-Buy | **none** | Automated purchasing flows triggered from conversations |
| `order_management` | Order Management | all | Look up and manage orders from e-commerce systems |

## Integrations (16)

| Key | Display Name | AGENT Default | Description |
|---|---|---|---|
| `shopify_integration` | Shopify | all | E-commerce integration for orders and inventory |
| `woocommerce_integration` | WooCommerce | all | Connect to WooCommerce shops |
| `wix_integration` | Wix | all | Connect to Wix e-commerce |
| `stripe_integration` | Stripe | all | Payment processing and refunds via Stripe |
| `paypal_integration` | PayPal | all | Payment processing and transaction lookup |
| `square_integration` | Square | all | Payment processing via Square |
| `calendar_integration` | Calendar (Google / Calendly) | all | Calendar integration for scheduling |
| `google_drive_integration` | Google Drive | all | Sync documents from Google Drive |
| `confluence_integration` | Confluence | all | Pull knowledge from Confluence |
| `airtable_integration` | Airtable | all | Connect to Airtable for data access |
| `monday_integration` | Monday.com | all | Connect to Monday.com for project management |
| `custom_api_tools` | Custom API Tools | all | Create custom HTTP-based tool integrations |
| `custom_database_tools` | Custom Database Tools | all | Define custom SQL/Mongo query tools |
| `postgresql_integration` | PostgreSQL | all | Query and update PostgreSQL databases |
| `mongodb_integration` | MongoDB | all | Query and update MongoDB databases |
| `aws_rds_integration` | AWS RDS | all | Query and update AWS RDS databases |

## Analytics (3)

| Key | Display Name | AGENT Default | Description |
|---|---|---|---|
| `dashboard_analytics` | Dashboard Analytics | all | Real-time metrics and dashboards |
| `conversation_analytics` | Conversation Analytics | all | Insights into conversation patterns and outcomes |
| `agent_performance_scoring` | Agent Performance Scoring | **none** | AI-based QA and performance metrics per agent |

## Notifications (4)

| Key | Display Name | AGENT Default | Description |
|---|---|---|---|
| `in_app_notifications` | In-App Notifications | all | Receive notifications in app UI |
| `email_notifications` | Email Notifications | all | Receive notifications via email |
| `push_notifications` | Mobile Push Notifications | all | Receive notifications on mobile devices |
| `notification_sound` | Notification Sound | all | Audio alert for new messages |

## Admin (10)

| Key | Display Name | AGENT Default | Description |
|---|---|---|---|
| `agent_management` | Agent Management | **none** | Create, edit, enable/disable user accounts and roles |
| `department_management` | Department Management | **none** | Create departments, manage hierarchy, SLA settings |
| `channel_management` | Channel Management | **none** | Configure connected messaging channels |
| `integration_setup` | Integration Setup | **none** | Install and configure third-party integrations |
| `tenant_settings` | Tenant Settings | **none** | Organization-level configuration and defaults |
| `policy_administration` | Policy Administration | **none** | Create and manage business rules and escalation policies |
| `tool_management` | Tool Management | **none** | Enable/disable tools and configure approval requirements |
| `permission_management` | Permission Management | **none** | Define custom roles and grant user permissions |
| `notification_settings` | Notification Settings | **none** | Configure notification channels and delivery rules |
| `usage_tracking` | Usage & Billing | **none** | View organization usage metrics and costs |

---

## Summary

| Category | Count |
|---|---:|
| Messaging | 16 |
| Voice | 9 |
| AI | 10 |
| Knowledge | 4 |
| CRM | 7 |
| Automation | 5 |
| Commerce | 2 |
| Integrations | 16 |
| Analytics | 3 |
| Notifications | 4 |
| Admin | 10 |
| **Total** | **78** |

## Known Overlaps (to curate)

Some features have intentional or accidental overlap. Consider whether to keep both, merge, or drop one:

| Pair | Notes |
|---|---|
| `confluence_integration` ↔ `confluence_knowledge` | Same connector - integration auth vs RAG sync. Keep both if admins should be able to install without enabling sync. |
| `google_drive_integration` ↔ `google_drive_knowledge` | Same as above. |
| `bot` ↔ `chatbot_flow_builder` + `autonomous_ai_mode` | `bot` is the legacy master toggle; the new pair gates each underlying mode independently. |
| `knowledge_base` ↔ `knowledge_base_rag` | `knowledge_base` is a legacy alias retained for back-compat. |
| `voice_copilot` ↔ `call_copilot` | `voice_copilot` is the legacy Phase-1 master switch; `call_copilot` is the new fine-grained gate. |

## Adding / removing features

- **Add**: append to `FEATURES` const and `FEATURE_METADATA` in `packages/shared/src/lib/features.ts`. No DB migration needed - the system seeds the row on first toggle.
- **Remove**: delete the key from `FEATURES`. Orphan rows in `tenant_features` / `user_feature_grants` / `tenant_role_features` are harmless and can be cleaned up later with a `DELETE WHERE feature NOT IN (...)` script.
- **Backfill from legacy column**: set `legacyColumn: "tenant_column_name"` in the metadata. The resolver falls back to the column when no `tenant_features` row exists.

## Migrating call sites

Old pattern:
```ts
if (tenant.botEnabled) { ... }
```

New pattern:
```ts
import { hasFeature, FEATURES } from "@chatcenter/shared";

if (await hasFeature({ userId, tenantId, role }, FEATURES.BOT)) { ... }
```

Or as Express middleware:
```ts
import { requireFeature, FEATURES } from "@chatcenter/shared";

router.post(
  "/orders/auto-buy",
  authenticate,
  resolveTenant,
  requireFeature(FEATURES.AUTO_BUY),
  handler,
);
```
