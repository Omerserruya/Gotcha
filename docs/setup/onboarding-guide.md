# ChatCenter Onboarding Guide

## Quick Start

This guide walks you through setting up ChatCenter from scratch - from creating the system admin to onboarding your first tenant.

---

## 1. Prerequisites

- Docker & Docker Compose installed
- Node.js 18+ (for local development)
- A PostgreSQL database (or use the included Docker service)
- Redis (included in Docker Compose)

## 2. Environment Setup

Copy the example environment file and configure it:

```bash
cp .env.example .env
```

**Required variables:**

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `OIDC_ISSUER` / `OIDC_JWKS_URI` | Authentik OIDC issuer (public URL) and JWKS endpoint (internal DNS) |
| `SYSTEM_ADMIN_SETUP_SECRET` | One-time secret gating the system-admin seed endpoint |
| `REDIS_URL` | Redis connection string |
| `FRONTEND_URL` | Your frontend URL (e.g., `http://localhost:3000`) |
| `NEXT_PUBLIC_API_URL` | API URL for the frontend |

**For WhatsApp/Messenger/Instagram channels (optional at setup):**

| Variable | Description |
|----------|-------------|
| `META_APP_ID` | Facebook App ID |
| `META_APP_SECRET` | Facebook App Secret |
| `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` | WhatsApp Embedded Signup config |
| `OAUTH_REDIRECT_URI` | OAuth callback URL |
| `CHANNEL_ENCRYPTION_KEY` | Encryption key for stored credentials |

## 3. Start Services

```bash
docker compose up -d
```

This starts all services: auth, conversation, webhook, analytics, chatbot, AI, incoming/outgoing workers, Redis, PostgreSQL, nginx gateway, and the frontend.

## 4. Run Database Migrations

```bash
docker compose exec auth npx prisma migrate deploy
```

## 5. Create System Admin

The system admin is the super-user who manages all tenants. Create one using the seed endpoint:

```bash
curl -X POST http://localhost:4000/api/system/seed \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@yourdomain.com",
    "name": "System Admin",
    "setupSecret": "<your SYSTEM_ADMIN_SETUP_SECRET value>"
  }'
```

> The `setupSecret` must match your `SYSTEM_ADMIN_SETUP_SECRET` environment variable. This endpoint can only be called once. No password is sent or returned: the seed provisions an Authentik identity, and the admin sets their password through an Authentik recovery link (create one in the Authentik admin under Directory > Users, or via `scripts/authentik`).

## 6. Login as System Admin

1. Navigate to your frontend URL (e.g., `http://localhost:3000/login`)
2. Click **Sign in**; you are redirected to Authentik, the identity provider
3. Enter the email and password you used in the seed step
4. You'll be redirected to the **System Dashboard**

## 7. Create Your First Tenant

From the System Admin panel:

1. Go to **Tenants** in the sidebar
2. Click **"New Tenant"**
3. Fill in:
   - **Organization Name** - the company name (e.g., "Acme Corp")
   - **Slug** - URL-safe identifier, auto-generated from name (e.g., "acme-corp")
   - **Admin Name** - name of the tenant's admin user
   - **Admin Email** - login email for the tenant admin
   - **Admin Password** - password for the tenant admin (min 8 characters)
4. Click **"Create Tenant"**

This creates the organization and its first admin user in one step.

## 8. Login as Tenant Admin

1. Go to `/login`
2. Enter:
   - **Organization ID**: the slug you chose (e.g., `acme-corp`)
   - **Email**: the admin email you set
   - **Password**: the admin password you set
3. You'll be redirected to the **Conversations** page

## 9. Connect Messaging Channels

As a tenant admin, go to **Channels** in the sidebar:

### WhatsApp (Embedded Signup)
1. Click **"Connect WhatsApp"**
2. Complete the Facebook Embedded Signup wizard
3. Select or create a WhatsApp Business Account
4. Choose a phone number
5. Done - messages will start flowing in

### Messenger
1. Click **"Connect Messenger"**
2. Authorize your Facebook Page(s)
3. Messages from your Page inbox will appear in ChatCenter

### Instagram
1. Click **"Connect Instagram"**
2. Authorize your Facebook Page linked to an Instagram Business Account
3. Instagram DMs will appear in ChatCenter

> **Prerequisite**: You need a Meta (Facebook) App configured with the appropriate permissions. See [Meta Channel Setup Guide](./meta-channel-setup-guide.md) for detailed instructions.

## 10. Add Agents

As a tenant admin, go to **Agents** in the sidebar:

1. Click **"Add Agent"**
2. Enter name, email, and password
3. The agent can now log in and start handling conversations

## 11. Set Up Departments (Optional)

Go to **Departments** to organize agents into teams:

1. Create departments (e.g., "Sales", "Support")
2. Add agents as members
3. Set queue mode: **Claim** (manual) or **Round Robin** (auto-assign)
4. Configure department-specific Co-Pilot settings if needed

## 12. Configure Chatbot Flows (Optional)

Go to **Chatbot Builder** to create automated conversation flows:

1. Create a new flow
2. Add nodes: messages, quick replies, conditions, department routing, handover
3. Activate the flow
4. Incoming messages will be handled by the bot before reaching agents

## 13. Configure Co-Pilot (Optional)

Go to **Co-Pilot** to set up AI assistance for agents:

1. Write a system prompt describing your business
2. Add behavioral rules
3. Choose between **Ready Message** (clickable suggestions) or **Context Only** (summary + tips)
4. Agents will see AI suggestions while chatting with customers

## 14. Set Business Hours (Optional)

Go to **Settings** to configure business hours:

1. Enable business hours
2. Set your timezone
3. Configure the weekly schedule
4. Set an auto-response message for outside hours

---

## Architecture Overview

ChatCenter is a multi-tenant, multi-channel customer communication platform:

- **Auth Service** (port 4001) - Authentication, agents, departments, channels, system admin
- **Conversation Service** (port 4002) - Conversations, messages, WebSocket
- **Webhook Service** (port 4003) - Incoming webhooks from WhatsApp/Messenger/Instagram
- **Analytics Service** (port 4004) - Dashboard stats and reporting
- **Chatbot Service** (port 4005) - Chatbot flow execution
- **AI Service** (port 4006) - OpenAI-powered co-pilot
- **Workers** - Background message processing (incoming + outgoing queues)
- **Nginx Gateway** (port 80) - Routes requests to services
- **Frontend** (port 3000) - Next.js web application

---

## Roles

| Role | Scope | Capabilities |
|------|-------|-------------|
| **SYSTEM_ADMIN** | Global | Manage all tenants, create/disable organizations, system-wide stats |
| **ADMIN** | Tenant | Manage agents, channels, departments, chatbot, co-pilot, settings |
| **AGENT** | Tenant | Handle conversations, view assigned chats |

---

## Troubleshooting

### Can't create system admin
- Ensure the `setupSecret` matches your `SYSTEM_ADMIN_SETUP_SECRET` exactly
- The seed endpoint can only be called once; check if a system admin already exists

### Tenant login fails
- Verify the tenant slug is correct (case-sensitive, lowercase)
- Check that the tenant is not disabled in the system admin panel

### Channels not receiving messages
- Verify webhook URL is publicly accessible
- Check channel status in the Channels page
- Ensure Meta App has the correct permissions and webhook subscriptions

### Co-Pilot not generating suggestions
- Verify `OPENAI_API_KEY` is set in your environment
- Check that Co-Pilot is enabled in settings
