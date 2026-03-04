# Outlook Channel Setup Guide — Microsoft OAuth2 + Graph API Integration

> **Last updated:** March 2026
> **Assumes:** You have access to the Azure Portal and a domain with HTTPS.

This guide walks you through configuring Microsoft Entra ID (Azure AD) so that tenants can connect **Outlook** email accounts directly from the GOTCHA UI — enabling send/receive email via Microsoft Graph API with OAuth2 authentication.

---

## Table of Contents

1. [Prerequisites Checklist](#1-prerequisites-checklist)
2. [Register an Application in Azure](#2-register-an-application-in-azure)
3. [Configure Authentication](#3-configure-authentication)
4. [Create Client Secret](#4-create-client-secret)
5. [Configure API Permissions](#5-configure-api-permissions)
6. [Configure Webhook Endpoint for Receiving Emails](#6-configure-webhook-endpoint-for-receiving-emails)
7. [Set Environment Variables](#7-set-environment-variables)
8. [Test the Connection Flow](#8-test-the-connection-flow)
9. [Go Live Checklist](#9-go-live-checklist)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Prerequisites Checklist

Before starting, confirm you have:

- [ ] An **Azure account** with access to [Azure Portal](https://portal.azure.com/)
- [ ] Access to **Microsoft Entra ID** (formerly Azure Active Directory)
- [ ] If targeting personal Microsoft accounts: No special requirements
- [ ] If targeting organizational accounts: Tenant admin access (for admin consent)
- [ ] GOTCHA application deployed and publicly accessible via HTTPS
- [ ] The webhook endpoint is reachable: `https://yourdomain.com/api/webhook/outlook`

---

## 2. Register an Application in Azure

### 2.1 Create App Registration

1. Go to [Azure Portal](https://portal.azure.com/)
2. Navigate to **Microsoft Entra ID** (search for it in the top search bar)
3. In the left sidebar, click **App registrations**
4. Click **New registration**
5. Fill in:

| Field | Value |
|-------|-------|
| **Name** | `GOTCHA Outlook Integration` |
| **Supported account types** | Choose based on your needs (see below) |
| **Redirect URI** | Platform: **Web** / URI: `https://yourdomain.com/api/channels/oauth/callback` |

6. Click **Register**

### 2.2 Supported Account Types

| Option | When to Use | `MICROSOFT_TENANT_ID` |
|--------|-------------|----------------------|
| **Accounts in this organizational directory only** | Only your org's users | Your specific tenant ID |
| **Accounts in any organizational directory** | Any Microsoft 365 org | `organizations` |
| **Accounts in any organizational directory and personal Microsoft accounts** | Broadest compatibility (recommended for SaaS) | `common` |
| **Personal Microsoft accounts only** | Only @outlook.com, @hotmail.com, etc. | `consumers` |

> **Recommended for SaaS:** Use **"Accounts in any organizational directory and personal Microsoft accounts"** with `MICROSOFT_TENANT_ID=common`

### 2.3 Save Your Application IDs

After registration, you'll see the **Overview** page. Copy these values:

| Field | Environment Variable |
|-------|---------------------|
| **Application (client) ID** | `MICROSOFT_CLIENT_ID` |
| **Directory (tenant) ID** | `MICROSOFT_TENANT_ID` (or use `common`) |

---

## 3. Configure Authentication

1. In your App Registration, go to **Authentication** in the left sidebar
2. Under **Web** → **Redirect URIs**, verify:
   - `https://yourdomain.com/api/channels/oauth/callback` is listed
3. Under **Implicit grant and hybrid flows**:
   - Leave both checkboxes **unchecked** (we use authorization code flow, not implicit)
4. Under **Advanced settings**:
   - **Allow public client flows**: **No**
5. Click **Save**

> **Adding additional redirect URIs:** If you need development URLs (e.g., `http://localhost:4001/api/channels/oauth/callback`), add them here. You can have multiple redirect URIs.

---

## 4. Create Client Secret

1. In your App Registration, go to **Certificates & secrets** in the left sidebar
2. Click **Client secrets** tab
3. Click **New client secret**
4. Configure:

| Field | Value |
|-------|-------|
| **Description** | `GOTCHA Production` |
| **Expires** | **24 months** (recommended) or **Custom** |

5. Click **Add**
6. **Immediately copy the Value** (not the Secret ID) — it's only shown once!

| Field | Environment Variable |
|-------|---------------------|
| **Value** (the secret string) | `MICROSOFT_CLIENT_SECRET` |

> **Critical:** The secret value is only displayed once. If you lose it, you'll need to create a new one.

> **Expiration reminder:** Set a calendar reminder to rotate the secret before it expires. When you create a new secret, update `MICROSOFT_CLIENT_SECRET` in your `.env` and restart the auth service.

---

## 5. Configure API Permissions

### 5.1 Add Required Permissions

1. In your App Registration, go to **API permissions** in the left sidebar
2. Click **Add a permission** → **Microsoft Graph** → **Delegated permissions**
3. Add these permissions:

| Permission | Category | Purpose |
|------------|----------|---------|
| `Mail.ReadWrite` | Mail | Read and write user's mail (inbox monitoring) |
| `Mail.Send` | Mail | Send email on behalf of the user |
| `User.Read` | User | Read user's profile (email address, display name) |
| `offline_access` | (Built-in) | Get refresh tokens for long-lived access |

4. Click **Add permissions**

### 5.2 Grant Admin Consent (Organizational Accounts)

If your app targets organizational accounts:

1. Still on the **API permissions** page
2. Click **Grant admin consent for [Your Organization]**
3. Click **Yes** to confirm

> **Note:** If you're not a tenant admin, the admin consent button will be greyed out. Ask your admin to grant consent, or each user will be prompted to consent individually during OAuth.

> **For multi-tenant apps (`common`):** Admin consent is per-organization. Each organization's admin must grant consent, or individual users consent during the OAuth flow.

### 5.3 Verify Permissions

After configuration, your permissions should look like:

| API / Permission | Type | Status |
|-----------------|------|--------|
| Microsoft Graph / Mail.ReadWrite | Delegated | Granted for [org] |
| Microsoft Graph / Mail.Send | Delegated | Granted for [org] |
| Microsoft Graph / User.Read | Delegated | Granted for [org] |

`offline_access` is implied and doesn't need to be listed explicitly.

---

## 6. Configure Webhook Endpoint for Receiving Emails

Microsoft Graph uses **webhook subscriptions** to notify your app when new emails arrive. GOTCHA creates these subscriptions automatically during the OAuth connection flow.

### 6.1 How Subscriptions Work

```
User receives email → Outlook Inbox
       ↓
Microsoft Graph detects new message in subscribed mailbox
       ↓
Graph sends POST to https://yourdomain.com/api/webhook/outlook
       ↓
GOTCHA webhook handler enqueues job to incomingMessageQueue
       ↓
Incoming worker processes the message
       ↓
Message appears in GOTCHA conversation UI (real-time via WebSocket)
```

### 6.2 Subscription Validation

When a subscription is created, Microsoft sends a **validation request**:

1. Microsoft sends a GET request with `?validationToken=<token>` to your webhook URL
2. Your endpoint must respond with `200 OK` and the `validationToken` as plain text body
3. GOTCHA handles this automatically in the `/api/webhook/outlook` endpoint

> **Test your endpoint:** Before connecting, verify your webhook is reachable:
> ```bash
> curl "https://yourdomain.com/api/webhook/outlook?validationToken=test123"
> # Should return: test123
> ```

### 6.3 Subscription Lifecycle

| Property | Value |
|----------|-------|
| **Maximum expiration** | 3 days (4,230 minutes) for mail resources |
| **Auto-renewal** | Not automatic — must be renewed before expiration |
| **Created by** | GOTCHA OAuth callback (automatic) |

> **Important:** Microsoft Graph subscriptions expire after **3 days maximum**. You need a background job to renew them.

### 6.4 Subscription Renewal (Required)

Add a recurring job to renew Outlook subscriptions before they expire. Use the `channelHealthQueue`:

```
PATCH https://graph.microsoft.com/v1.0/subscriptions/{subscriptionId}
Body: {
  "expirationDateTime": "2026-03-07T00:00:00Z"  // max 3 days from now
}
```

> **Recommended:** Run renewal every **2 days** to ensure subscriptions never expire.

The `subscriptionId` is stored in the channel account's `platformMeta.subscriptionId` field.

---

## 7. Set Environment Variables

After completing the Azure Portal setup, add these to your `.env` file:

```bash
# ─── Outlook (Microsoft OAuth2 + Graph API) ─────────────────

# Application (client) ID (from Azure → App registrations → Overview)
MICROSOFT_CLIENT_ID=your-application-client-id

# Client Secret Value (from Azure → App registrations → Certificates & secrets)
MICROSOFT_CLIENT_SECRET=your-client-secret-value

# OAuth callback URL — must EXACTLY match the Redirect URI in Azure
MICROSOFT_OAUTH_REDIRECT_URI=https://yourdomain.com/api/channels/oauth/callback

# Tenant ID — use "common" for multi-tenant, or your specific tenant ID
MICROSOFT_TENANT_ID=common

# Webhook URL for receiving incoming email notifications
OUTLOOK_WEBHOOK_URL=https://yourdomain.com/api/webhook/outlook
```

### Variable Reference Table

| Variable | Where to Find | Example |
|----------|---------------|---------|
| `MICROSOFT_CLIENT_ID` | Azure Portal → App registrations → Overview → Application (client) ID | `a1b2c3d4-e5f6-7890-abcd-ef1234567890` |
| `MICROSOFT_CLIENT_SECRET` | Azure Portal → App registrations → Certificates & secrets → Value | `abc~DEF123ghiJKL456` |
| `MICROSOFT_OAUTH_REDIRECT_URI` | Must match Azure → App registrations → Authentication → Redirect URIs | `https://gotcha.co.il/api/channels/oauth/callback` |
| `MICROSOFT_TENANT_ID` | Azure Portal → App registrations → Overview → Directory (tenant) ID / or `common` | `common` |
| `OUTLOOK_WEBHOOK_URL` | Your publicly accessible webhook endpoint | `https://gotcha.co.il/api/webhook/outlook` |

---

## 8. Test the Connection Flow

### 8.1 Connect Outlook Account

1. Log into GOTCHA as an **Admin** user
2. Navigate to the **Channels** page
3. Click **Connect** on the Outlook card
4. You'll be redirected to Microsoft's login/consent screen:
   - Sign in with a Microsoft account (personal or organizational)
   - Review the permissions (read/send mail)
   - Click **Accept**
5. You'll be redirected back to GOTCHA with a success message
6. The connected Outlook account should appear in the channels list

### 8.2 Test Receiving Emails

1. From a different email account, send an email to the connected Outlook/Microsoft address
2. Wait a few seconds for the Graph webhook notification
3. Verify the message appears as a new conversation in GOTCHA
4. Check the webhook service logs:
   ```bash
   docker compose logs webhook -f
   ```
   You should see: `[WEBHOOK] Outlook notification received`

### 8.3 Test Sending Emails

1. Open a conversation that was created from an Outlook inbound message
2. Type a reply and send it
3. The recipient should receive the email from the connected Outlook address
4. Check the outgoing worker logs:
   ```bash
   docker compose logs outgoing-worker -f
   ```

---

## 9. Go Live Checklist

Before enabling Outlook connection for production tenants:

- [ ] **App registration** is created in Azure Portal
- [ ] **Client secret** is generated and stored in `.env` (not expired)
- [ ] **API permissions** are configured: `Mail.ReadWrite`, `Mail.Send`, `User.Read`
- [ ] **Admin consent** granted (for organizational accounts)
- [ ] **Redirect URI** points to production domain
- [ ] **Webhook endpoint** is publicly accessible via HTTPS
- [ ] **Webhook validation** works (`?validationToken=...` returns the token)
- [ ] **Environment variables** are set correctly in production
- [ ] **Subscription renewal** cron job is configured (every 2 days)
- [ ] **Client secret expiration** reminder is set in calendar
- [ ] **Test emails** sent and received successfully

### Multi-Tenant Considerations

If using `MICROSOFT_TENANT_ID=common`:

- **No app verification required** by Microsoft for standard Mail permissions
- Each organization's admin may need to grant admin consent
- Personal Microsoft accounts work without admin consent
- Users see a consent prompt during OAuth showing your app name and requested permissions

---

## 10. Troubleshooting

### Common Issues

| Problem | Cause | Solution |
|---------|-------|----------|
| OAuth redirect returns `outlook_no_email` | User profile has no email address | Ensure `User.Read` permission is granted |
| OAuth redirect returns `outlook_already_connected` | Outlook account connected to another tenant | Disconnect from the other tenant first |
| `AADSTS700016: Application not found` | Wrong `MICROSOFT_CLIENT_ID` | Verify the Application ID in Azure Portal |
| `AADSTS7000215: Invalid client secret` | Wrong or expired `MICROSOFT_CLIENT_SECRET` | Regenerate the secret in Azure Portal |
| `AADSTS50011: Redirect URI mismatch` | `MICROSOFT_OAUTH_REDIRECT_URI` doesn't match Azure config | Ensure exact match including path and protocol |
| `AADSTS65001: User hasn't consented` | Admin consent not granted for the org | Admin must grant consent, or each user consents individually |
| No emails arriving in GOTCHA | Webhook subscription expired (>3 days) | Renew the subscription via Graph API |
| No emails arriving in GOTCHA | Webhook validation failing | Test the validation endpoint manually with curl |
| `403 Forbidden` when sending email | Token missing `Mail.Send` scope | Reconnect the account; verify API permissions |
| `InvalidAuthenticationToken` | Access token expired and refresh failed | Reconnect the Outlook account |
| Subscription creation fails | Webhook URL not publicly accessible | Verify HTTPS and public accessibility |

### Checking Logs

```bash
# Auth service logs (OAuth connection flow)
docker compose logs auth -f

# Webhook service logs (incoming Outlook notifications)
docker compose logs webhook -f

# Outgoing worker logs (sending emails)
docker compose logs outgoing-worker -f

# Incoming worker logs (processing received emails)
docker compose logs incoming-worker -f
```

### Microsoft's Debug Tools

- **Graph Explorer:** [developer.microsoft.com/en-us/graph/graph-explorer](https://developer.microsoft.com/en-us/graph/graph-explorer) — test Graph API calls with your tokens
- **JWT Decoder:** [jwt.ms](https://jwt.ms) — decode and inspect access tokens
- **Azure Portal → App registrations → Your app → Logs** — check sign-in and audit logs
- **Test Subscription Endpoint:**
  ```bash
  curl -X POST "https://yourdomain.com/api/webhook/outlook?validationToken=test_token_123"
  # Should return 200 with body: test_token_123
  ```
