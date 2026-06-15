# Meta Platform Setup Guide - Channel Self-Service Connection

> **Last updated:** February 2026
> **Assumes:** You already have a Meta App created and webhooks configured at the app level.

This guide walks you through configuring your Meta App so that tenants can connect **WhatsApp**, **Messenger**, and **Instagram** channels directly from the GOTCHA UI - no manual Meta Console work per tenant.

---

## Table of Contents

1. [Prerequisites Checklist](#1-prerequisites-checklist)
2. [Add Required Products to Your App](#2-add-required-products-to-your-app)
3. [Configure Facebook Login for Business](#3-configure-facebook-login-for-business)
4. [Create WhatsApp Embedded Signup Configuration](#4-create-whatsapp-embedded-signup-configuration)
5. [Configure OAuth Settings](#5-configure-oauth-settings)
6. [Request Permissions & App Review](#6-request-permissions--app-review)
7. [Set Environment Variables](#7-set-environment-variables)
8. [Test the Connection Flows](#8-test-the-connection-flows)
9. [Go Live Checklist](#9-go-live-checklist)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Prerequisites Checklist

Before starting, confirm you have:

- [x] A **Meta Developer Account** - [developers.facebook.com](https://developers.facebook.com)
- [x] A **Meta App** created (type: **Business**)
- [x] A **Meta Business Account** (formerly Business Manager) linked to the app
- [x] **Webhooks** already configured at the app level for:
  - WhatsApp Business Account (`messages` field)
  - Page (Messenger: `messages`, `messaging_postbacks`, `messaging_optins`, `message_deliveries`, `message_reads`)
  - Instagram (`messages`, `messaging_postbacks`, `message_reads`)
- [x] Your webhook endpoint is publicly accessible (e.g., `https://yourdomain.com/api/webhook`)
- [x] GOTCHA application deployed and running

> **Note:** Your Meta App ID is shown at the top of your App Dashboard. Save it - you'll need it for `META_APP_ID`.

---

## 2. Add Required Products to Your App

Go to your **App Dashboard** → left sidebar → **Add Product**.

Add the following products if not already present:

| Product | Purpose |
|---------|---------|
| **Facebook Login for Business** | OAuth for Messenger & Instagram + Embedded Signup for WhatsApp |
| **WhatsApp** (WhatsApp Business Platform) | WhatsApp Cloud API access |
| **Messenger** | Messenger send/receive API |
| **Instagram** | Instagram Messaging API |
| **Webhooks** | Already configured (per prerequisites) |

### Steps:

1. In the App Dashboard, click **Add Product** in the left sidebar
2. Find **Facebook Login for Business** → click **Set Up**
3. Find **WhatsApp** → click **Set Up** (if not already added)
4. Find **Messenger** → click **Set Up** (if not already added)
5. Find **Instagram** → click **Set Up** (if not already added)

> **Important:** Use **"Facebook Login for Business"**, NOT the regular "Facebook Login". The Business variant supports Embedded Signup and scoped business permissions.

---

## 3. Configure Facebook Login for Business

This is the core product that powers both WhatsApp Embedded Signup and Messenger/Instagram OAuth.

### 3.1 Client OAuth Settings

1. Go to **Facebook Login for Business** → **Settings** in the left sidebar
2. Under **Client OAuth settings**, configure:

| Setting | Value |
|---------|-------|
| **Client OAuth login** | Yes |
| **Web OAuth login** | Yes |
| **Force Web OAuth reauthentication** | No |
| **Valid OAuth Redirect URIs** | `https://yourdomain.com/api/channels/oauth/callback` |
| **Allowed Domains for the JavaScript SDK** | `https://yourdomain.com` |
| **Login from Devices** | No |

3. Click **Save Changes**

> **Critical:** The OAuth Redirect URI must **exactly match** your `OAUTH_REDIRECT_URI` environment variable. Include the full path: `/api/channels/oauth/callback`

### 3.2 Allowed Domains for JavaScript SDK

This is required for the WhatsApp Embedded Signup popup to work:

1. Still in **Facebook Login for Business** → **Settings**
2. In **Allowed Domains for the JavaScript SDK**, add your frontend domain:
   - Development: `http://localhost` (or your local dev URL)
   - Production: `https://yourdomain.com`
3. Click **Save Changes**

---

## 4. Create WhatsApp Embedded Signup Configuration

This creates the `config_id` that the frontend uses to launch the WhatsApp signup popup.

### Steps:

1. Go to **Facebook Login for Business** → **Configurations** in the left sidebar
2. Click **Create Configuration**
3. Fill in the configuration form:

| Field | Value |
|-------|-------|
| **Configuration name** | `GOTCHA WhatsApp Onboarding` (or any descriptive name) |
| **Login variation** | Select **WhatsApp Embedded Signup** |

4. Click **Next** / **Continue**

5. On the **Permissions** screen, ensure these are selected:
   - `whatsapp_business_management`
   - `whatsapp_business_messaging`

6. On the **Assets** screen:
   - Select **WhatsApp accounts** as an asset type
   - This allows the onboarding user to share their WABA with your app

7. On the **Token expiration** screen:
   - Set to **Never expire** (recommended for server-to-server use)
   - Alternatively, set a long duration and rely on the health worker for refresh

8. Click **Create** / **Save**

9. **Copy the Configuration ID** - it looks like a numeric string, e.g., `1234567890123456`

> **This is your `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID`** - save it for the environment variables step.

### Verify Embedded Signup Setup:

- In the WhatsApp product settings, confirm your app has a **System User** with the appropriate permissions
- The Embedded Signup flow will create/link a WABA when a tenant completes the popup

---

## 5. Configure OAuth Settings

### 5.1 App Secret

1. Go to **App Dashboard** → **Settings** → **Basic**
2. Under **App Secret**, click **Show**
3. Copy the secret - this is your `META_APP_SECRET`

> **Security:** Never expose the App Secret in frontend code. It's only used server-side.

### 5.2 App Domains

1. Still in **Settings** → **Basic**
2. Under **App Domains**, add:
   - `yourdomain.com` (production)
   - `localhost` (development, if needed)

### 5.3 Privacy Policy & Terms of Service URLs (Only for App Review / Live Mode)

> **Skip this for development.** These are only required when submitting for App Review to go Live.

1. In **Settings** → **Basic**
2. Fill in:
   - **Privacy Policy URL**: Any publicly accessible URL (e.g., a Notion page, Google Doc, or your own page)
   - **Terms of Service URL**: Same - any public URL works
3. You can add proper pages later at `/privacy` and `/terms` on your domain

---

## 6. Request Permissions & App Review

Your app needs specific permissions approved before tenants can connect channels in production.

### 6.1 Required Permissions by Channel

#### WhatsApp (via Embedded Signup)
| Permission | Purpose |
|------------|---------|
| `whatsapp_business_management` | Manage WABAs, phone numbers, subscribe webhooks |
| `whatsapp_business_messaging` | Send/receive WhatsApp messages |

#### Messenger (via OAuth)
| Permission | Purpose |
|------------|---------|
| `pages_messaging` | Send/receive Messenger messages |
| `pages_manage_metadata` | Subscribe pages to webhooks |
| `pages_read_engagement` | Read page info and engagement data |

#### Instagram (via OAuth)
| Permission | Purpose |
|------------|---------|
| `instagram_basic` | Read Instagram account profile info |
| `instagram_manage_messages` | Send/receive Instagram DMs |
| `pages_manage_metadata` | Subscribe page (linked to IG) to webhooks |
| `pages_read_engagement` | Read page info |

### 6.2 Submitting for App Review

1. Go to **App Dashboard** → **App Review** → **Permissions and Features**
2. For each permission listed above, click **Request**
3. For each permission request, you must provide:
   - **Description** of how your app uses the permission
   - **Screencast** (video) showing the feature in action
   - **Test instructions** for the reviewer

> **Tip for screencasts:** Record a short video showing:
> - A tenant clicking "Connect" in the GOTCHA Channels page
> - The Embedded Signup popup or OAuth redirect completing
> - The connected channel appearing in the UI
> - A message being sent/received through the connected channel

4. Submit the review - Meta typically responds within 1-5 business days

### 6.3 Development Mode vs. Live Mode

- In **Development Mode**, only app admins/developers/testers can use the OAuth flow
- In **Live Mode**, any Facebook/WhatsApp user can connect
- You can test the full flow in Development Mode before submitting for review

To add test users:
1. **App Dashboard** → **Roles** → **Test Users** or **People**
2. Add the Facebook accounts you want to test with

---

## 7. Set Environment Variables

After completing the Meta Console setup, update your `.env` file with the values you collected:

```bash
# ─── Meta Platform - Channel Connection ──────────────────────

# Your Meta App ID (from App Dashboard → Settings → Basic)
META_APP_ID=your-facebook-app-id

# Your Meta App Secret (from App Dashboard → Settings → Basic → App Secret → Show)
META_APP_SECRET=your-meta-app-secret

# Embedded Signup Configuration ID (from Facebook Login for Business → Configurations)
WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID=your-embedded-signup-config-id

# OAuth callback URL - must EXACTLY match what you set in Facebook Login for Business → Settings
OAUTH_REDIRECT_URI=https://yourdomain.com/api/channels/oauth/callback

# Encryption key for storing channel credentials (generate with: openssl rand -hex 32)
CHANNEL_ENCRYPTION_KEY=your-64-char-hex-key

# Graph API base URL (do not change unless Meta releases a new version)
FACEBOOK_API_URL=https://graph.facebook.com/v21.0

# ─── Frontend ──────────────────────────────────────────────

# Must match META_APP_ID - used by the Facebook JS SDK in the browser
NEXT_PUBLIC_META_APP_ID=your-facebook-app-id

# Your application's public URL (used for OAuth redirect back to frontend)
FRONTEND_URL=https://yourdomain.com
```

### Variable Reference Table

| Variable | Where to Find | Example |
|----------|---------------|---------|
| `META_APP_ID` | App Dashboard → Settings → Basic → App ID | `1234567890123456` |
| `META_APP_SECRET` | App Dashboard → Settings → Basic → App Secret | `abc123def456...` |
| `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` | Facebook Login for Business → Configurations → Your config → ID | `9876543210987654` |
| `OAUTH_REDIRECT_URI` | Must match Facebook Login for Business → Settings → Valid OAuth Redirect URIs | `https://app.gotcha.com/api/channels/oauth/callback` |
| `CHANNEL_ENCRYPTION_KEY` | Self-generated: `openssl rand -hex 32` | `a1b2c3d4e5f6...` (64 hex chars) |
| `FACEBOOK_API_URL` | Meta Graph API versioned URL | `https://graph.facebook.com/v21.0` |
| `NEXT_PUBLIC_META_APP_ID` | Same as `META_APP_ID` | `1234567890123456` |
| `FRONTEND_URL` | Your deployment URL | `https://app.gotcha.com` |

> **Generate the encryption key:**
> ```bash
> openssl rand -hex 32
> ```
> This produces a 64-character hex string. Paste it as `CHANNEL_ENCRYPTION_KEY`.

---

## 8. Test the Connection Flows

### 8.1 Test WhatsApp Embedded Signup

1. Log into GOTCHA as an **Admin** user
2. Navigate to **Channels** page
3. Click **Connect** on the WhatsApp card
4. A Facebook popup appears (Embedded Signup):
   - Sign in with a Facebook account that has admin access to a WhatsApp Business Account
   - If no WABA exists, the flow will guide you to create one
   - Select or create a phone number
   - Complete the flow
5. The popup closes and the channel should appear as **Connected**
6. Send a test WhatsApp message to the connected number
7. Verify the message appears in GOTCHA conversations

**If the popup doesn't appear:**
- Check browser console for JavaScript errors
- Verify `NEXT_PUBLIC_META_APP_ID` is set correctly
- Verify your domain is in "Allowed Domains for the JavaScript SDK"
- Ensure you're using HTTPS (required for the Facebook SDK in production)

### 8.2 Test Messenger OAuth

1. In the GOTCHA Channels page, click **Connect** on the Messenger card
2. You'll be redirected to Facebook's OAuth consent screen
3. Log in and select the Page(s) you want to connect
4. Grant the requested permissions
5. You'll be redirected back to GOTCHA with a success message
6. The connected Page should appear in the channels list
7. Send a test message to the Page on Messenger
8. Verify the message appears in GOTCHA conversations

**If the redirect fails:**
- Verify `OAUTH_REDIRECT_URI` exactly matches what's in Facebook Login for Business settings
- Check that `META_APP_ID` and `META_APP_SECRET` are correct
- Check the auth service logs for detailed error messages

### 8.3 Test Instagram OAuth

1. **Prerequisite:** The Facebook Page must have a linked **Instagram Business Account** or **Instagram Creator Account**
   - To link: Go to your Instagram app → Settings → Account → Linked Accounts → Facebook → Connect to a Page
   - Or: Facebook Page Settings → Instagram → Connect Account
2. In the GOTCHA Channels page, click **Connect** on the Instagram card
3. Complete the Facebook OAuth flow (same as Messenger, but with Instagram scopes)
4. After redirect, the Instagram account should appear as connected
5. Send a test DM to the connected Instagram account
6. Verify the message appears in GOTCHA conversations

**If no Instagram account is found:**
- The error `no_instagram_account` means the Facebook Page(s) don't have linked IG Business accounts
- Only **Instagram Business** or **Creator** accounts can be linked - personal accounts are not supported

---

## 9. Go Live Checklist

Before enabling channel connection for real tenants:

- [ ] **App Review approved** for all required permissions
- [ ] **App is in Live Mode** (App Dashboard → toggle at the top)
- [ ] **Privacy Policy** and **Terms of Service** URLs are set and accessible
- [ ] **Valid OAuth Redirect URI** points to your production domain
- [ ] **Allowed Domains** includes your production frontend domain
- [ ] **CHANNEL_ENCRYPTION_KEY** is a strong, randomly generated key (not a default)
- [ ] **META_APP_SECRET** is securely stored (not committed to source control)
- [ ] **HTTPS** is enabled on your production domain
- [ ] **Database migration** has been run (`npx prisma migrate deploy`)
- [ ] **Webhook** is receiving events on production (test with Meta's webhook test tool)
- [ ] **Token refresh worker** is running (incoming-worker service, cron job every 12h)
- [ ] **Health check worker** is running (incoming-worker service, cron job every 6h)

---

## 10. Troubleshooting

### Common Issues

| Problem | Cause | Solution |
|---------|-------|----------|
| Embedded Signup popup doesn't appear | Missing or wrong `NEXT_PUBLIC_META_APP_ID` | Verify the env var matches your App ID |
| Embedded Signup popup appears but fails | Domain not in "Allowed Domains for JS SDK" | Add your domain in Facebook Login for Business → Settings |
| OAuth redirect returns `invalid_state` | JWT expired (>10 min) or `JWT_SECRET` mismatch between services | Retry the connection; ensure JWT_SECRET is consistent |
| OAuth redirect returns `no_pages` | User has no Facebook Pages | The connecting user must be admin of at least one Page |
| OAuth redirect returns `no_instagram_account` | Pages have no linked Instagram Business account | Link an IG Business/Creator account to the Page first |
| "Token is invalid or expired" status | Access token revoked or expired | Reconnect the channel; check token refresh worker is running |
| `Failed to exchange code for access token` | Wrong `META_APP_SECRET` | Verify the secret in App Dashboard → Settings → Basic |
| `OAuth not configured` error | Missing `META_APP_ID` or `OAUTH_REDIRECT_URI` | Set both env vars and restart the auth service |
| WhatsApp messages not arriving | App not subscribed to WABA webhooks | The connect flow auto-subscribes; check logs for subscription errors |
| Messenger/IG messages not arriving | Page not subscribed to webhooks | Reconnect the channel; check webhook subscription in Page settings |

### Checking Logs

```bash
# Auth service logs (OAuth + connection endpoints)
docker compose logs auth -f

# Incoming worker logs (health checks + token refresh)
docker compose logs incoming-worker -f

# Webhook service logs (incoming messages)
docker compose logs webhook -f
```

### Verifying Token Health

Use the GOTCHA UI: click the refresh icon next to a connected channel to trigger a health check. Or call the API directly:

```bash
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  https://yourdomain.com/api/channels/CHANNEL_ID/status
```

### Meta's Debug Tools

- **Graph API Explorer:** [developers.facebook.com/tools/explorer](https://developers.facebook.com/tools/explorer) - test API calls with your tokens
- **Access Token Debugger:** [developers.facebook.com/tools/debug/accesstoken](https://developers.facebook.com/tools/debug/accesstoken) - check token validity and scopes
- **Webhook Test:** App Dashboard → Webhooks → select topic → **Test** button
