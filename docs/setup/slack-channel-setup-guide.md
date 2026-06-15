# Slack Channel Setup Guide - OAuth2 + Events API Integration

> **Last updated:** March 2026
> **Assumes:** You have access to a Slack workspace and a domain with HTTPS.

This guide walks you through configuring a Slack App so that tenants can connect **Slack** workspaces directly from the GOTCHA UI - enabling send/receive messages including threaded conversations via the Slack Web API and Events API.

---

## Table of Contents

1. [Prerequisites Checklist](#1-prerequisites-checklist)
2. [Create a Slack App](#2-create-a-slack-app)
3. [Configure OAuth & Permissions](#3-configure-oauth--permissions)
4. [Enable Event Subscriptions](#4-enable-event-subscriptions)
5. [Configure Interactive Components (Optional)](#5-configure-interactive-components-optional)
6. [Get App Credentials](#6-get-app-credentials)
7. [Set Environment Variables](#7-set-environment-variables)
8. [Test the Connection Flow](#8-test-the-connection-flow)
9. [Go Live Checklist](#9-go-live-checklist)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Prerequisites Checklist

Before starting, confirm you have:

- [ ] A **Slack account** and a workspace where you have admin or owner access
- [ ] Access to [Slack API Dashboard](https://api.slack.com/apps)
- [ ] GOTCHA application deployed and publicly accessible via HTTPS
- [ ] The webhook endpoint is reachable: `https://yourdomain.com/api/webhook/slack`
- [ ] The OAuth callback is reachable: `https://yourdomain.com/api/channels/oauth/callback`

---

## 2. Create a Slack App

### 2.1 Create from Scratch

1. Go to [Slack API Dashboard](https://api.slack.com/apps)
2. Click **Create New App**
3. Choose **From scratch**
4. Fill in:

| Field | Value |
|-------|-------|
| **App Name** | `GOTCHA` (or your product name) |
| **Pick a workspace to develop your app in** | Select your development workspace |

5. Click **Create App**

> **Note:** The development workspace is where you'll test. Users from other workspaces can install the app later via the OAuth flow.

### 2.2 App Display Settings (Optional but Recommended)

1. Go to **Basic Information** in the left sidebar
2. Scroll to **Display Information**
3. Configure:

| Field | Value |
|-------|-------|
| **App name** | `GOTCHA` |
| **Short description** | `Omnichannel communication hub` |
| **App icon** | Upload your logo (512x512 recommended) |
| **Background color** | Your brand color |

4. Click **Save Changes**

---

## 3. Configure OAuth & Permissions

### 3.1 Add Redirect URL

1. In the left sidebar, go to **OAuth & Permissions**
2. Under **Redirect URLs**, click **Add New Redirect URL**
3. Enter: `https://yourdomain.com/api/channels/oauth/callback`
4. Click **Add** → **Save URLs**

> **Critical:** The redirect URL must **exactly match** `SLACK_OAUTH_REDIRECT_URI` in your `.env` file.

### 3.2 Add Bot Token Scopes

Still on **OAuth & Permissions**, scroll to **Scopes** → **Bot Token Scopes**.

Click **Add an OAuth Scope** for each:

| Scope | Purpose |
|-------|---------|
| `channels:history` | Read messages in public channels the bot is in |
| `channels:read` | List public channels and get channel info |
| `chat:write` | Send messages as the bot |
| `groups:history` | Read messages in private channels the bot is in |
| `groups:read` | List private channels the bot is in |
| `im:history` | Read direct messages with the bot |
| `im:read` | List direct message conversations |
| `im:write` | Open and send direct messages |
| `mpim:history` | Read group DM messages |
| `mpim:read` | List group DM conversations |
| `users:read` | Get user profile info (name, avatar) |

> **Important:** These are **Bot Token Scopes**, not User Token Scopes. Bot tokens don't expire and provide the scopes needed for GOTCHA's functionality.

### 3.3 Understanding Token Types

| Token Type | Prefix | Expires | Used For |
|-----------|--------|---------|----------|
| **Bot Token** | `xoxb-` | Never | Sending messages, reading channel history |
| **User Token** | `xoxp-` | Never | Not needed for GOTCHA |

GOTCHA uses the **Bot Token** (`xoxb-`) which is obtained during the OAuth V2 flow and stored encrypted in the database.

---

## 4. Enable Event Subscriptions

This is how GOTCHA receives messages from Slack in real time.

### 4.1 Enable Events

1. In the left sidebar, go to **Event Subscriptions**
2. Toggle **Enable Events** to **On**
3. In the **Request URL** field, enter: `https://yourdomain.com/api/webhook/slack`

> **Verification:** Slack immediately sends a challenge request to verify your URL. GOTCHA handles this automatically. You should see a green checkmark with "Verified" next to the URL.

> **If verification fails:**
> - Ensure your GOTCHA webhook service is running and publicly accessible
> - Check that the endpoint responds to the `url_verification` challenge
> - Try `docker compose logs webhook -f` to see if the request is reaching your server

### 4.2 Subscribe to Bot Events

Still on **Event Subscriptions**, scroll to **Subscribe to bot events**.

Click **Add Bot User Event** for each:

| Event | Description |
|-------|-------------|
| `message.channels` | Messages in public channels the bot is a member of |
| `message.groups` | Messages in private channels the bot is a member of |
| `message.im` | Direct messages to the bot |
| `message.mpim` | Messages in group DMs the bot is in |

4. Click **Save Changes**

### 4.3 How Events Flow

```
User sends message in Slack channel/DM
       ↓
Slack Events API detects message
       ↓
Slack sends POST to https://yourdomain.com/api/webhook/slack
  (with HMAC signature in x-slack-signature header)
       ↓
GOTCHA verifies signature using Signing Secret
       ↓
GOTCHA webhook handler enqueues job to incomingMessageQueue
       ↓
Incoming worker processes the message
       ↓
Message appears in GOTCHA conversation UI (real-time via WebSocket)

Thread support:
- If message has thread_ts → encoded as "channel:thread_ts" recipient
- Replies from GOTCHA are sent with thread_ts → appears in same thread
```

---

## 5. Configure Interactive Components (Optional)

If you want to use interactive messages (buttons) that users can click:

1. In the left sidebar, go to **Interactivity & Shortcuts**
2. Toggle **Interactivity** to **On**
3. **Request URL**: `https://yourdomain.com/api/webhook/slack`
4. Click **Save Changes**

> **Note:** This is optional. GOTCHA can send interactive messages (with buttons) regardless of this setting. This endpoint is for handling the button click callbacks.

---

## 6. Get App Credentials

### 6.1 Basic Information

1. In the left sidebar, go to **Basic Information**
2. Scroll to **App Credentials**
3. Copy these values:

| Field | Environment Variable |
|-------|---------------------|
| **Client ID** | `SLACK_CLIENT_ID` |
| **Client Secret** | `SLACK_CLIENT_SECRET` |
| **Signing Secret** | `SLACK_SIGNING_SECRET` |

> **Signing Secret** is used to verify that incoming webhook requests actually come from Slack (HMAC-SHA256 signature verification). This is critical for security.

### 6.2 Security Note

| Secret | Purpose | Exposure Risk |
|--------|---------|---------------|
| **Client ID** | Identifies your app in OAuth flows | Low (public in OAuth URL) |
| **Client Secret** | Authenticates your app during token exchange | **High** - never expose in frontend |
| **Signing Secret** | Verifies webhook request authenticity | **High** - never expose in frontend |

---

## 7. Set Environment Variables

After completing the Slack API setup, add these to your `.env` file:

```bash
# ─── Slack (OAuth2 V2 + Events API) ─────────────────────────

# Client ID (from Slack API → Basic Information → App Credentials)
SLACK_CLIENT_ID=your-slack-client-id

# Client Secret (from Slack API → Basic Information → App Credentials)
SLACK_CLIENT_SECRET=your-slack-client-secret

# OAuth callback URL - must EXACTLY match the Redirect URL in Slack OAuth settings
SLACK_OAUTH_REDIRECT_URI=https://yourdomain.com/api/channels/oauth/callback

# Signing Secret for webhook signature verification (from Slack API → Basic Information)
SLACK_SIGNING_SECRET=your-slack-signing-secret
```

### Variable Reference Table

| Variable | Where to Find | Example |
|----------|---------------|---------|
| `SLACK_CLIENT_ID` | Slack API → Basic Information → App Credentials → Client ID | `1234567890.1234567890123` |
| `SLACK_CLIENT_SECRET` | Slack API → Basic Information → App Credentials → Client Secret | `abcdef1234567890abcdef12` |
| `SLACK_OAUTH_REDIRECT_URI` | Must match Slack API → OAuth & Permissions → Redirect URLs | `https://gotcha.co.il/api/channels/oauth/callback` |
| `SLACK_SIGNING_SECRET` | Slack API → Basic Information → App Credentials → Signing Secret | `abcdef1234567890abcdef1234567890` |

---

## 8. Test the Connection Flow

### 8.1 Install to Development Workspace

For initial testing, you can install directly:

1. In Slack API Dashboard, go to **Install App**
2. Click **Install to Workspace**
3. Review the permissions and click **Allow**
4. You'll see a **Bot User OAuth Token** - this confirms the install works

> **Note:** For production, users will install via the OAuth flow from the GOTCHA Channels page. The direct install is just for testing.

### 8.2 Connect via GOTCHA OAuth

1. Log into GOTCHA as an **Admin** user
2. Navigate to the **Channels** page
3. Click **Connect** on the Slack card
4. You'll be redirected to Slack's OAuth consent screen:
   - Select the workspace you want to connect
   - Review the bot permissions
   - Click **Allow**
5. You'll be redirected back to GOTCHA with a success message
6. The connected Slack workspace should appear in the channels list

### 8.3 Test Receiving Messages

1. **Important:** Invite the bot to a channel first:
   - In Slack, go to the channel where you want GOTCHA to listen
   - Type `/invite @GOTCHA` (or whatever your bot name is)
   - Or right-click the channel → **Channel details** → **Integrations** → **Add an app**
2. Send a message in that channel
3. Verify the message appears as a new conversation in GOTCHA
4. Check the webhook service logs:
   ```bash
   docker compose logs webhook -f
   ```
   You should see: `[WEBHOOK] Slack event: type=message`

> **Critical:** The bot can only see messages in channels it has been **invited to**. It won't automatically see all channels.

### 8.4 Test Sending Messages

1. Open a conversation in GOTCHA that was created from a Slack message
2. Type a reply and send it
3. The reply should appear in the Slack channel
4. Check the outgoing worker logs:
   ```bash
   docker compose logs outgoing-worker -f
   ```

### 8.5 Test Thread Support

1. In Slack, reply to a message **in a thread** (click "Reply in thread")
2. The threaded message should arrive in GOTCHA with thread context
3. Reply from GOTCHA - the reply should appear in the **same Slack thread**
4. Verify thread continuity in both Slack and GOTCHA

### 8.6 Test Direct Messages

1. In Slack, send a direct message to the bot (search for your bot name in DMs)
2. The message should appear in GOTCHA as a new conversation
3. Reply from GOTCHA - the reply should appear as a DM in Slack

---

## 9. Go Live Checklist

Before enabling Slack connection for production tenants:

- [ ] **Slack App** is created with correct name and branding
- [ ] **Bot Token Scopes** are configured (all 11 scopes listed above)
- [ ] **Event Subscriptions** are enabled with correct URL and verified
- [ ] **Bot Events** are subscribed (`message.channels`, `message.groups`, `message.im`, `message.mpim`)
- [ ] **Redirect URL** points to production domain
- [ ] **Environment variables** are set correctly in production
- [ ] **HTTPS** is enabled on your domain (required by Slack)
- [ ] **Webhook signature verification** is working (uses Signing Secret)
- [ ] **Test messages** sent and received successfully
- [ ] **Thread replies** work correctly
- [ ] **Direct messages** work correctly

### Distributing Your App (Multi-Workspace)

By default, your Slack App can only be installed in the development workspace. To allow other workspaces to install:

1. Go to **Manage Distribution** in the left sidebar
2. Complete the checklist:
   - [ ] Remove hard-coded team ID (not applicable for GOTCHA)
   - [ ] Enable public distribution
   - [ ] Add a landing page URL (optional)
3. Toggle **Activate Public Distribution**

> **Slack App Directory:** Optionally, submit your app to the [Slack App Directory](https://slack.com/apps) for discovery. This requires Slack's review and is not required for OAuth to work.

### Slack App Directory Submission (Optional)

If you want your app listed in the Slack App Directory:

1. Go to **Submit to App Directory** in the left sidebar
2. Fill in the submission form:
   - App description, screenshots, categories
   - Support email and documentation URL
3. Slack reviews within **2-4 weeks**

> **Not required:** Users can install your app via the OAuth URL without App Directory listing.

---

## 10. Troubleshooting

### Common Issues

| Problem | Cause | Solution |
|---------|-------|----------|
| OAuth returns `slack_token_failed` | Wrong Client ID/Secret | Verify credentials in Slack API → Basic Information |
| OAuth returns `slack_no_team` | Token exchange didn't return team info | Check Slack API Dashboard for errors |
| OAuth returns `slack_already_connected` | Workspace already connected to another tenant | Disconnect from the other tenant first |
| Event URL verification fails | Webhook not accessible or not handling challenge | Verify endpoint returns `{ challenge: "..." }` for `url_verification` |
| Bot not receiving messages | Bot not invited to the channel | Invite bot with `/invite @BotName` in the channel |
| Bot not receiving DMs | `im:history` scope missing | Add the scope and reinstall the app |
| `403` on webhook requests | Invalid signature verification | Verify `SLACK_SIGNING_SECRET` matches Slack API dashboard |
| `invalid_auth` when sending | Bot token revoked or invalid | Reconnect the workspace via OAuth |
| Messages appear twice | Bot responding to its own messages | GOTCHA filters `bot_id` messages (check `platformMeta.botUserId`) |
| Thread replies not in thread | Missing `thread_ts` in outbound | Verify recipient format is `channelId:threadTs` |
| `not_in_channel` when sending | Bot not a member of the target channel | Invite bot to the channel first |
| `channel_not_found` error | Invalid channel ID or bot lacks access | Verify channel exists and bot is a member |

### Checking Logs

```bash
# Auth service logs (OAuth connection flow)
docker compose logs auth -f

# Webhook service logs (incoming Slack events)
docker compose logs webhook -f

# Outgoing worker logs (sending Slack messages)
docker compose logs outgoing-worker -f

# Incoming worker logs (processing received messages)
docker compose logs incoming-worker -f
```

### Slack's Debug Tools

- **Slack API Tester:** [api.slack.com/methods](https://api.slack.com/methods) - test API methods with your bot token
- **Event Subscriptions → Request URL:** Shows real-time verification status
- **App Dashboard → Event Subscriptions → Retry Policy:** See failed event deliveries
- **Slack Webhook Debugger:** In the App Dashboard → **Event Subscriptions** → scroll to **Request URL** → check pending retries
- **Test auth:**
  ```bash
  curl -H "Authorization: Bearer xoxb-your-bot-token" \
    https://slack.com/api/auth.test
  ```
- **List channels:**
  ```bash
  curl -H "Authorization: Bearer xoxb-your-bot-token" \
    "https://slack.com/api/conversations.list?types=public_channel,private_channel"
  ```
- **Test sending a message:**
  ```bash
  curl -X POST -H "Authorization: Bearer xoxb-your-bot-token" \
    -H "Content-Type: application/json" \
    -d '{"channel":"C01XXXXXXXX","text":"Hello from GOTCHA!"}' \
    https://slack.com/api/chat.postMessage
  ```
