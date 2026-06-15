# Gmail Channel Setup Guide - OAuth2 + Gmail API Integration

> **Last updated:** March 2026
> **Assumes:** You have a Google Cloud project and a domain with HTTPS.

This guide walks you through configuring Google Cloud so that tenants can connect **Gmail** accounts directly from the GOTCHA UI - enabling send/receive email via the Gmail API with OAuth2 authentication.

---

## Table of Contents

1. [Prerequisites Checklist](#1-prerequisites-checklist)
2. [Create a Google Cloud Project](#2-create-a-google-cloud-project)
3. [Enable the Gmail API](#3-enable-the-gmail-api)
4. [Configure OAuth Consent Screen](#4-configure-oauth-consent-screen)
5. [Create OAuth2 Credentials](#5-create-oauth2-credentials)
6. [Set Up Pub/Sub for Receiving Emails](#6-set-up-pubsub-for-receiving-emails)
7. [Set Environment Variables](#7-set-environment-variables)
8. [Test the Connection Flow](#8-test-the-connection-flow)
9. [Go Live Checklist](#9-go-live-checklist)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Prerequisites Checklist

Before starting, confirm you have:

- [ ] A **Google Account** with access to [Google Cloud Console](https://console.cloud.google.com/)
- [ ] A **Google Cloud project** (or you'll create one in step 2)
- [ ] **Billing enabled** on the project (required for Pub/Sub, though the free tier covers most usage)
- [ ] Your GOTCHA application deployed and publicly accessible via HTTPS
- [ ] The webhook endpoint is reachable: `https://yourdomain.com/api/webhook/gmail`

---

## 2. Create a Google Cloud Project

> **Skip this step** if you already have a Google Cloud project (e.g., the one used for Knowledge Base / Google Drive integration).

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click the project dropdown at the top → **New Project**
3. Enter a project name: e.g., `GOTCHA ChatCenter`
4. Select your organization (if applicable)
5. Click **Create**
6. Switch to the new project using the project dropdown

> **Note:** Save the **Project ID** - you'll need it for Pub/Sub configuration.

---

## 3. Enable the Gmail API

1. In Google Cloud Console, go to **APIs & Services** → **Library**
2. Search for **Gmail API**
3. Click **Gmail API** → **Enable**

Also enable these (required for Pub/Sub push notifications):

4. Search for **Cloud Pub/Sub API** → **Enable**

---

## 4. Configure OAuth Consent Screen

The consent screen is what users see when connecting their Gmail account.

### 4.1 Basic Configuration

1. Go to **APIs & Services** → **OAuth consent screen**
2. Choose User Type:
   - **Internal** - only users in your Google Workspace org (suitable if you only serve your own org)
   - **External** - any Google account can connect (required for multi-tenant SaaS)
3. Click **Create**

### 4.2 App Information

Fill in the form:

| Field | Value |
|-------|-------|
| **App name** | `GOTCHA` (or your product name) |
| **User support email** | Your support email |
| **App logo** | (Optional) Upload your logo |
| **App domain - Application home page** | `https://yourdomain.com` |
| **App domain - Application privacy policy link** | `https://yourdomain.com/privacy` |
| **App domain - Application terms of service link** | `https://yourdomain.com/terms` |
| **Authorized domains** | `yourdomain.com` |
| **Developer contact information** | Your email |

Click **Save and Continue**

### 4.3 Scopes

1. Click **Add or Remove Scopes**
2. Add the following scopes:

| Scope | Purpose |
|-------|---------|
| `https://www.googleapis.com/auth/gmail.readonly` | Read incoming emails |
| `https://www.googleapis.com/auth/gmail.send` | Send emails on behalf of the user |
| `https://www.googleapis.com/auth/gmail.modify` | Mark emails as read, label management |
| `https://www.googleapis.com/auth/userinfo.email` | Get the user's email address |

3. Click **Update** → **Save and Continue**

> **Note:** `gmail.readonly`, `gmail.send`, and `gmail.modify` are **sensitive scopes**. For production with External user type, you'll need to submit for **Google OAuth verification** (see Go Live Checklist).

### 4.4 Test Users (Development Only)

If your app is in **Testing** status (not yet verified):

1. Click **Add Users**
2. Add the Google email addresses you want to test with
3. Click **Save and Continue**

> **Limit:** Up to 100 test users while in Testing status.

---

## 5. Create OAuth2 Credentials

1. Go to **APIs & Services** → **Credentials**
2. Click **Create Credentials** → **OAuth client ID**
3. Configure:

| Field | Value |
|-------|-------|
| **Application type** | Web application |
| **Name** | `GOTCHA Gmail OAuth` |
| **Authorized JavaScript origins** | `https://yourdomain.com` |
| **Authorized redirect URIs** | `https://yourdomain.com/api/channels/oauth/callback` |

4. Click **Create**
5. A dialog appears with your credentials:

| Credential | Environment Variable |
|------------|---------------------|
| **Client ID** | `GOOGLE_CLIENT_ID` |
| **Client Secret** | `GOOGLE_CLIENT_SECRET` |

6. Copy both values and save them securely

> **Critical:** The redirect URI must **exactly match** `GOOGLE_OAUTH_REDIRECT_URI` in your `.env` file. Include the full path: `/api/channels/oauth/callback`

> **Tip:** If you already have `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set for Knowledge Base (Google Drive) integration, you can reuse the same credentials - just add the Gmail scopes and the redirect URI to the existing OAuth client.

---

## 6. Set Up Pub/Sub for Receiving Emails

Gmail uses Google Cloud Pub/Sub to push notifications when new emails arrive. This is how GOTCHA receives incoming emails in real time.

### 6.1 Create a Pub/Sub Topic

1. Go to **Pub/Sub** in Google Cloud Console (or search for it)
2. Click **Create Topic**
3. Topic ID: `gmail-notifications`
4. Uncheck "Add a default subscription" (we'll create a push subscription)
5. Click **Create**

The full topic name will be: `projects/YOUR_PROJECT_ID/topics/gmail-notifications`

### 6.2 Grant Gmail Publish Access

Gmail needs permission to publish messages to your topic:

1. Click on the topic you just created
2. Go to the **Permissions** tab (or click **Show Info Panel**)
3. Click **Add Principal**
4. New principal: `gmail-api-push@system.gserviceaccount.com`
5. Role: **Pub/Sub Publisher**
6. Click **Save**

> **Important:** This is a Google-managed service account. Without this step, Gmail cannot push notifications to your topic.

### 6.3 Create a Push Subscription

1. Still on the topic page, click **Create Subscription** (or go to Subscriptions → Create)
2. Configure:

| Field | Value |
|-------|-------|
| **Subscription ID** | `gmail-push-to-gotcha` |
| **Delivery type** | **Push** |
| **Endpoint URL** | `https://yourdomain.com/api/webhook/gmail` |
| **Acknowledgement deadline** | `30` seconds |
| **Message retention** | `7 days` (default) |
| **Retry policy** | Minimum: `10s`, Maximum: `600s` |

3. Click **Create**

> **Verification:** Google will send a confirmation request to your endpoint. The GOTCHA webhook handler automatically handles this by returning 200.

### 6.4 How It Works

```
User sends email → Gmail Inbox
       ↓
Gmail detects new message
       ↓
Gmail publishes notification to Pub/Sub topic
       ↓
Pub/Sub pushes to https://yourdomain.com/api/webhook/gmail
       ↓
GOTCHA webhook handler enqueues job to incomingMessageQueue
       ↓
Incoming worker processes the message
       ↓
Message appears in GOTCHA conversation UI (real-time via WebSocket)
```

> **Note:** Gmail Pub/Sub notifications contain only a `historyId` - the actual email content is fetched by the incoming worker using the Gmail API with the stored OAuth credentials.

### 6.5 Watch Renewal

Gmail push notifications require a "watch" to be set up per user. This happens automatically during OAuth connection. However, watches expire after **7 days** and need to be renewed.

> **TODO:** Add a cron job to the `channelHealthQueue` to renew Gmail watches every 6 days:
> ```
> POST https://gmail.googleapis.com/gmail/v1/users/me/watch
> Body: { "topicName": "projects/PROJECT_ID/topics/gmail-notifications", "labelIds": ["INBOX"] }
> ```

---

## 7. Set Environment Variables

After completing the Google Cloud setup, add these to your `.env` file:

```bash
# ─── Gmail (Google OAuth2) ──────────────────────────────────

# OAuth2 Client ID (from Google Cloud Console → Credentials)
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com

# OAuth2 Client Secret (from Google Cloud Console → Credentials)
GOOGLE_CLIENT_SECRET=your-google-client-secret

# OAuth callback URL - must EXACTLY match the Authorized Redirect URI in Google Cloud
GOOGLE_OAUTH_REDIRECT_URI=https://yourdomain.com/api/channels/oauth/callback

# Pub/Sub topic for Gmail push notifications (from step 6.1)
GMAIL_PUBSUB_TOPIC=projects/your-project-id/topics/gmail-notifications
```

### Variable Reference Table

| Variable | Where to Find | Example |
|----------|---------------|---------|
| `GOOGLE_CLIENT_ID` | Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID | `123456789-abcdef.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Same location → Client Secret | `GOCSPX-abcdefgh123456` |
| `GOOGLE_OAUTH_REDIRECT_URI` | Must match what's configured in the OAuth client | `https://gotcha.co.il/api/channels/oauth/callback` |
| `GMAIL_PUBSUB_TOPIC` | Google Cloud Console → Pub/Sub → Topic → Full topic name | `projects/gotcha-prod/topics/gmail-notifications` |

> **Note:** If you already have `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set (e.g., for Google Drive Knowledge Base), you don't need to create new ones. Just ensure the OAuth client has the Gmail scopes and the redirect URI added.

---

## 8. Test the Connection Flow

### 8.1 Connect Gmail Account

1. Log into GOTCHA as an **Admin** user
2. Navigate to the **Channels** page
3. Click **Connect** on the Gmail card
4. You'll be redirected to Google's OAuth consent screen:
   - Sign in with the Google account you want to connect
   - Review the permissions (read, send, modify mail)
   - Click **Allow**
5. You'll be redirected back to GOTCHA with a success message
6. The connected Gmail account should appear in the channels list

### 8.2 Test Receiving Emails

1. From a different email account, send an email to the connected Gmail address
2. Wait a few seconds for the Pub/Sub notification
3. Verify the message appears as a new conversation in GOTCHA
4. Check the webhook service logs:
   ```bash
   docker compose logs webhook -f
   ```
   You should see: `[WEBHOOK] Gmail push notification received`

### 8.3 Test Sending Emails

1. Open a conversation that was created from a Gmail inbound message
2. Type a reply and send it
3. The recipient should receive the email from the connected Gmail address
4. Check the outgoing worker logs:
   ```bash
   docker compose logs outgoing-worker -f
   ```

---

## 9. Go Live Checklist

Before enabling Gmail connection for production tenants:

- [ ] **OAuth consent screen** is configured with all required fields
- [ ] **Gmail API** is enabled in the Google Cloud project
- [ ] **Pub/Sub** topic and push subscription are created and working
- [ ] **Gmail service account** (`gmail-api-push@system.gserviceaccount.com`) has Pub/Sub Publisher role on the topic
- [ ] **OAuth verification** submitted and approved by Google (required for External user type with sensitive scopes)
- [ ] **Authorized redirect URI** points to production domain
- [ ] **Environment variables** are set correctly in production
- [ ] **HTTPS** is enabled on your domain (required by Google OAuth)
- [ ] **Watch renewal** cron job is configured (every 6 days)
- [ ] **Test emails** sent and received successfully

### Google OAuth Verification (External Apps)

If your OAuth consent screen is set to **External** user type and uses sensitive scopes (gmail.readonly, gmail.send, gmail.modify), Google requires verification:

1. Go to **APIs & Services** → **OAuth consent screen**
2. Click **Publish App** (moves from Testing → In Production)
3. Google will prompt you to submit for verification
4. You'll need to provide:
   - A video demonstrating how the scopes are used
   - A link to your privacy policy
   - An explanation of each scope's usage
5. Verification typically takes **1-3 weeks**

> **While unverified:** Only test users (up to 100) can complete the OAuth flow. Other users will see a "This app isn't verified" warning and may be blocked.

---

## 10. Troubleshooting

### Common Issues

| Problem | Cause | Solution |
|---------|-------|----------|
| OAuth redirect returns `gmail_no_email` | Could not read email from Google profile | Ensure `userinfo.email` scope is included |
| OAuth redirect returns `gmail_already_connected` | Gmail account connected to a different tenant | Disconnect from the other tenant first |
| "Access denied" during OAuth | App not verified + user not a test user | Add user as test user, or complete verification |
| No emails arriving in GOTCHA | Pub/Sub not configured correctly | Verify topic, subscription, and service account permissions |
| No emails arriving in GOTCHA | Gmail watch expired (>7 days) | Renew the watch via Gmail API `/users/me/watch` |
| `403 Insufficient Permission` when sending | OAuth token missing `gmail.send` scope | Reconnect the account - ensure scopes are correct |
| `invalid_grant` error | Refresh token revoked or expired | Reconnect the Gmail account |
| Pub/Sub push not reaching webhook | Endpoint not publicly accessible or not HTTPS | Verify your URL is accessible and uses HTTPS |
| `gmail-api-push@system.gserviceaccount.com` can't publish | Missing Pub/Sub Publisher role | Re-add the principal with the correct role |

### Checking Logs

```bash
# Auth service logs (OAuth connection flow)
docker compose logs auth -f

# Webhook service logs (incoming Gmail notifications)
docker compose logs webhook -f

# Outgoing worker logs (sending emails)
docker compose logs outgoing-worker -f

# Incoming worker logs (processing received emails)
docker compose logs incoming-worker -f
```

### Google's Debug Tools

- **OAuth 2.0 Playground:** [developers.google.com/oauthplayground](https://developers.google.com/oauthplayground) - test Gmail API calls with your tokens
- **Google Cloud Console Logs:** Pub/Sub → Subscription → **Monitoring** tab - check push delivery metrics
- **Token Info Endpoint:** `https://oauth2.googleapis.com/tokeninfo?access_token=YOUR_TOKEN` - verify token scopes and validity
