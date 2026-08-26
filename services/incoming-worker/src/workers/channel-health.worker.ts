import { Job } from "bullmq";
import axios from "axios";
import {
  prisma,
  createWorker,
  channelHealthQueue,
  decryptCredentials,
  encryptCredentials, metaGraphBaseUrl } from "@chatcenter/shared";

const FB_API_URL = metaGraphBaseUrl(process.env.FACEBOOK_API_URL);
// Intentionally OUTSIDE central Meta versioning: graph.instagram.com
// (Instagram Login) rejects version-prefixed paths. See meta-graph-version.ts.
const IG_API_URL = process.env.INSTAGRAM_API_URL || "https://graph.instagram.com";
const META_APP_ID = process.env.META_APP_ID || "";
const META_APP_SECRET = process.env.META_APP_SECRET || "";
const OUTLOOK_WEBHOOK_URL = process.env.OUTLOOK_WEBHOOK_URL || "";
// Same Graph scopes the Outlook OAuth callback requested (channels.ts) - the
// refresh grant must ask for the identical scope set to get a usable token back.
const OUTLOOK_SCOPES =
  "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read offline_access";

interface ChannelHealthJob {
  type: "health_check" | "token_refresh" | "gmail_watch_renew";
}

async function processChannelHealth(job: Job<ChannelHealthJob>): Promise<void> {
  const { type } = job.data;

  if (type === "health_check") {
    await runHealthCheck();
    // Outlook is not a Meta channel and is skipped by runHealthCheck's
    // debug_token path; it gets its own refresh-then-probe pass so its badge
    // reflects the real token state instead of a stale/self-inflicted status.
    await runOutlookHealth();
  } else if (type === "token_refresh") {
    await runTokenRefresh();
  } else if (type === "gmail_watch_renew") {
    await runGmailWatchRenewal();
  }
}

// ─── Health Check ────────────────────────────────────────────

export async function runHealthCheck(): Promise<void> {
  console.log("[channel-health] Running health check...");

  // Only check Meta channels - Facebook's debug_token API doesn't apply to Gmail/Outlook/Slack
  //
  // ERROR rows are included for the same reason Outlook includes them: a Meta
  // channel breaks for reasons the OWNER fixes outside our product - a page
  // grant revoked in Business Settings, an app permission removed, an admin
  // role lost. Checking only CONNECTED rows made ERROR a one-way door: the
  // channel was never probed again, `lastHealthCheck` froze at the minute it
  // broke, and re-granting the permission on Facebook changed nothing here.
  // A user-initiated disconnect uses DISCONNECTED, not ERROR, so nothing a
  // person deliberately turned off is resurrected by this.
  const accounts = await prisma.channelAccount.findMany({
    where: {
      connectionStatus: { in: ["CONNECTED", "ERROR"] },
      isActive: true,
      channel: { in: ["WHATSAPP", "MESSENGER", "INSTAGRAM"] },
    },
  });

  if (!META_APP_ID || !META_APP_SECRET) {
    console.warn("[channel-health] META_APP_ID or META_APP_SECRET not configured, skipping health check");
    return;
  }

  let checked = 0;
  let errors = 0;
  let recovered = 0;

  for (const account of accounts) {
    try {
      let credentials: any;
      try {
        credentials = typeof account.credentials === "string"
          ? decryptCredentials(account.credentials as string)
          : account.credentials;
      } catch {
        // If decryption fails, credentials might be stored unencrypted (legacy)
        credentials = account.credentials;
      }

      const accessToken = credentials?.accessToken;
      if (!accessToken) {
        await prisma.channelAccount.update({
          where: { id: account.id },
          data: {
            connectionStatus: "ERROR",
            lastError: "No access token found",
            lastHealthCheck: new Date(),
          },
        });
        errors++;
        continue;
      }

      // Instagram-Login accounts hold an IG-user token that can't be validated
      // via Facebook's debug_token. Probe graph.instagram.com/me instead.
      if (credentials?.igLogin) {
        try {
          await axios.get(`${IG_API_URL}/me`, {
            params: { fields: "user_id", access_token: accessToken },
          });
          // A passing probe is the only evidence that matters: whatever broke
          // this channel has been fixed at Meta, so clear the error with it.
          if (account.connectionStatus === "ERROR") recovered++;
          await prisma.channelAccount.update({
            where: { id: account.id },
            data: { connectionStatus: "CONNECTED", lastError: null, lastHealthCheck: new Date() },
          });
        } catch (igErr: any) {
          await prisma.channelAccount.update({
            where: { id: account.id },
            data: {
              connectionStatus: "ERROR",
              lastError: igErr.response?.data?.error?.message || "Instagram token is invalid or expired",
              lastHealthCheck: new Date(),
            },
          });
          errors++;
        }
        checked++;
        continue;
      }

      const debugResponse = await axios.get(`${FB_API_URL}/debug_token`, {
        params: { input_token: accessToken },
        headers: { Authorization: `Bearer ${META_APP_ID}|${META_APP_SECRET}` },
      });

      const tokenData = debugResponse.data?.data;
      const isValid = tokenData?.is_valid === true;

      if (isValid) {
        const updateData: any = {
          lastHealthCheck: new Date(),
          // Same recovery rule as Instagram above and Outlook below.
          connectionStatus: "CONNECTED",
          lastError: null,
        };
        if (account.connectionStatus === "ERROR") recovered++;
        if (tokenData.expires_at && tokenData.expires_at > 0) {
          updateData.tokenExpiresAt = new Date(tokenData.expires_at * 1000);
        }
        await prisma.channelAccount.update({
          where: { id: account.id },
          data: updateData,
        });
      } else {
        await prisma.channelAccount.update({
          where: { id: account.id },
          data: {
            connectionStatus: "ERROR",
            lastError: tokenData?.error?.message || "Token is invalid or expired",
            lastHealthCheck: new Date(),
          },
        });
        errors++;
      }

      checked++;
    } catch (err: any) {
      console.warn(`[channel-health] Check failed for ${account.channel}:${account.externalId}:`, err.message);
      errors++;
    }
  }

  console.log(`[channel-health] Health check complete: ${checked} checked, ${errors} errors, ${recovered} recovered, ${accounts.length} total`);
}

// ─── Token Refresh ───────────────────────────────────────────

async function runTokenRefresh(): Promise<void> {
  console.log("[channel-health] Running token refresh...");

  if (!META_APP_ID || !META_APP_SECRET) {
    console.warn("[channel-health] META_APP_ID or META_APP_SECRET not configured, skipping refresh");
    return;
  }

  // Find channels with tokens expiring within 7 days
  const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const accounts = await prisma.channelAccount.findMany({
    where: {
      connectionStatus: "CONNECTED",
      isActive: true,
      tokenExpiresAt: { not: null, lte: sevenDaysFromNow },
      // Only Messenger and Instagram have expiring tokens
      channel: { in: ["MESSENGER", "INSTAGRAM"] },
    },
  });

  let refreshed = 0;
  let failed = 0;

  for (const account of accounts) {
    try {
      let credentials: any;
      try {
        credentials = typeof account.credentials === "string"
          ? decryptCredentials(account.credentials as string)
          : account.credentials;
      } catch {
        credentials = account.credentials;
      }

      const currentToken = credentials?.accessToken;
      if (!currentToken) continue;

      // Instagram-Login long-lived tokens refresh via graph.instagram.com with
      // ig_refresh_token (no app id/secret), not the Facebook fb_exchange_token flow.
      const response = credentials?.igLogin
        ? await axios.get(`${IG_API_URL}/refresh_access_token`, {
            params: { grant_type: "ig_refresh_token", access_token: currentToken },
          })
        : await axios.get(`${FB_API_URL}/oauth/access_token`, {
            params: {
              grant_type: "fb_exchange_token",
              client_id: META_APP_ID,
              client_secret: META_APP_SECRET,
              fb_exchange_token: currentToken,
            },
          });

      const newToken = response.data.access_token;
      const expiresIn = response.data.expires_in || 5184000; // 60 days default
      const newExpiresAt = new Date(Date.now() + expiresIn * 1000);

      if (newToken) {
        // Update credentials with new token
        const updatedCredentials = { ...credentials, accessToken: newToken };

        await prisma.channelAccount.update({
          where: { id: account.id },
          data: {
            credentials: encryptCredentials(updatedCredentials),
            tokenExpiresAt: newExpiresAt,
            lastError: null,
          },
        });

        refreshed++;
        console.log(`[channel-health] Refreshed token for ${account.channel}:${account.externalId}, expires: ${newExpiresAt.toISOString()}`);
      }
    } catch (err: any) {
      failed++;
      const errorMsg = err.response?.data?.error?.message || err.message;
      console.error(`[channel-health] Token refresh failed for ${account.channel}:${account.externalId}:`, errorMsg);

      // Don't immediately mark as ERROR - the old token might still work
      await prisma.channelAccount.update({
        where: { id: account.id },
        data: { lastError: `Token refresh failed: ${errorMsg}` },
      });
    }
  }

  console.log(`[channel-health] Token refresh complete: ${refreshed} refreshed, ${failed} failed, ${accounts.length} total`);
}

// ─── Gmail Watch Renewal ─────────────────────────────────────
//
// Gmail `users.watch` registrations expire after a maximum of 7 days. Google
// recommends re-arming at least daily. The push subscription itself is
// permanent (GCP-side); only the per-mailbox watch lapses, after which Gmail
// silently stops publishing to the topic. This job refreshes each connected
// Gmail account's OAuth access token (they expire hourly, so the stored one is
// almost always stale here) and re-issues the watch against GMAIL_PUBSUB_TOPIC.

const GMAIL_PUBSUB_TOPIC = process.env.GMAIL_PUBSUB_TOPIC || "";

async function refreshGoogleAccessToken(creds: {
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
}): Promise<string | null> {
  if (!creds.refreshToken || !creds.clientId || !creds.clientSecret) return null;
  const resp = await axios.post(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
  );
  return resp.data?.access_token || null;
}

async function runGmailWatchRenewal(): Promise<void> {
  console.log("[channel-health] Running Gmail watch renewal...");

  if (!GMAIL_PUBSUB_TOPIC) {
    console.warn("[channel-health] GMAIL_PUBSUB_TOPIC not configured, skipping Gmail watch renewal");
    return;
  }

  const accounts = await prisma.channelAccount.findMany({
    where: { connectionStatus: "CONNECTED", isActive: true, channel: "GMAIL" },
  });

  let renewed = 0;
  let failed = 0;

  for (const account of accounts) {
    try {
      let credentials: any;
      try {
        credentials = typeof account.credentials === "string"
          ? decryptCredentials(account.credentials as string)
          : account.credentials;
      } catch {
        credentials = account.credentials;
      }

      // Refresh the access token (Gmail tokens last ~1h; the stored one is stale).
      const freshToken = await refreshGoogleAccessToken(credentials || {});
      if (!freshToken) {
        failed++;
        console.warn(`[channel-health] Gmail watch renewal skipped for ${account.externalId}: missing refresh credentials`);
        await prisma.channelAccount.update({
          where: { id: account.id },
          data: { lastError: "Gmail watch renewal: missing refresh credentials" },
        });
        continue;
      }

      // Re-arm the watch on the env-configured topic (dev vs prod isolation).
      const watchResp = await axios.post(
        "https://gmail.googleapis.com/gmail/v1/users/me/watch",
        { topicName: GMAIL_PUBSUB_TOPIC, labelIds: ["INBOX"] },
        { headers: { Authorization: `Bearer ${freshToken}`, "Content-Type": "application/json" } },
      );

      // Persist the refreshed access token so the webhook's history fetches keep
      // working, plus the new watch expiration for observability. Leave
      // platformMeta.lastHistoryId untouched - the push handler advances it.
      const updatedCredentials = { ...credentials, accessToken: freshToken };
      await prisma.channelAccount.update({
        where: { id: account.id },
        data: {
          credentials: encryptCredentials(updatedCredentials),
          lastError: null,
          platformMeta: {
            ...((account.platformMeta as Record<string, unknown>) || {}),
            watchExpiration: watchResp.data?.expiration ?? null,
          },
        },
      });

      renewed++;
      console.log(`[channel-health] Gmail watch renewed for ${account.externalId}, expires: ${watchResp.data?.expiration}`);
    } catch (err: any) {
      failed++;
      const errorMsg = err.response?.data?.error?.message || err.message;
      console.error(`[channel-health] Gmail watch renewal failed for ${account.externalId}:`, errorMsg);
      await prisma.channelAccount.update({
        where: { id: account.id },
        data: { lastError: `Gmail watch renewal failed: ${errorMsg}` },
      }).catch(() => {});
    }
  }

  console.log(`[channel-health] Gmail watch renewal complete: ${renewed} renewed, ${failed} failed, ${accounts.length} total`);
}

// ─── Outlook Health + Token Refresh ──────────────────────────
//
// Microsoft Graph access tokens live ~1h, so the token stored at connect time
// is almost always stale by the time this worker runs. Unlike Meta channels,
// Outlook cannot be validated with Facebook's debug_token, and it was NOT
// covered by any refresh or health path before - which produced two wrong
// states: a self-inflicted ERROR ~1h after connect (an expired-but-refreshable
// token), and a stale CONNECTED badge on a genuinely-dead channel that nothing
// ever re-checked. This pass refreshes the token FIRST (using the long-lived
// refresh token stored at connect), then probes /me, so the persisted status is
// the truth: valid refresh token -> CONNECTED, revoked -> ERROR.

interface OutlookRefreshResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}

// Exchange the stored refresh token for a fresh access token. `post` is
// injectable so the exchange (endpoint, params, expiry math, refresh-token
// rotation) is unit-testable without network or prisma.
export async function refreshOutlookAccessToken(
  creds: { refreshToken?: string; clientId?: string; clientSecret?: string; tenantIdAzure?: string },
  post: (url: string, body: string, config: unknown) => Promise<{ data?: any }> = (url, body, config) => axios.post(url, body, config as any),
): Promise<OutlookRefreshResult | null> {
  if (!creds.refreshToken || !creds.clientId || !creds.clientSecret) return null;
  const tenant = creds.tenantIdAzure || "common";
  const resp = await post(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
      scope: OUTLOOK_SCOPES,
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
  );
  const accessToken = resp.data?.access_token;
  if (!accessToken) return null;
  return {
    accessToken,
    // Azure rotates the refresh token on some grants; persist the new one when present.
    refreshToken: resp.data?.refresh_token,
    expiresIn: resp.data?.expires_in || 3600,
  };
}

async function runOutlookHealth(): Promise<void> {
  console.log("[channel-health] Running Outlook health...");

  // Include ERROR rows so a channel whose token merely lapsed can RECOVER once
  // its refresh token works again. A user-initiated disconnect uses DISCONNECTED,
  // not ERROR, so it is not resurrected here.
  const accounts = await prisma.channelAccount.findMany({
    where: { isActive: true, channel: "OUTLOOK", connectionStatus: { in: ["CONNECTED", "ERROR"] } },
  });

  let ok = 0, recovered = 0, errors = 0;

  for (const account of accounts) {
    let credentials: any;
    try {
      credentials = typeof account.credentials === "string"
        ? decryptCredentials(account.credentials as string)
        : account.credentials;
    } catch {
      credentials = account.credentials;
    }

    try {
      const refreshed = await refreshOutlookAccessToken(credentials || {});
      if (!refreshed) {
        await prisma.channelAccount.update({
          where: { id: account.id },
          data: { connectionStatus: "ERROR", lastError: "Outlook: missing refresh credentials", lastHealthCheck: new Date() },
        });
        errors++;
        continue;
      }

      // Probe with the FRESH token - proves the mailbox is actually reachable,
      // not just that the token endpoint returned something.
      await axios.get("https://graph.microsoft.com/v1.0/me", {
        headers: { Authorization: `Bearer ${refreshed.accessToken}` },
      });

      const updatedCredentials = {
        ...credentials,
        accessToken: refreshed.accessToken,
        ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
      };
      const wasError = account.connectionStatus === "ERROR";
      await prisma.channelAccount.update({
        where: { id: account.id },
        data: {
          credentials: encryptCredentials(updatedCredentials),
          tokenExpiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
          connectionStatus: "CONNECTED",
          lastError: null,
          lastHealthCheck: new Date(),
        },
      });
      ok++;
      if (wasError) recovered++;

      // Best-effort: renew the Graph mail subscription (max 3-day expiry) so
      // inbound mail keeps arriving. A renewal failure must NOT flip health -
      // the probe above already decided it.
      const subId = (account.platformMeta as Record<string, unknown> | null)?.subscriptionId as string | undefined;
      if (subId && OUTLOOK_WEBHOOK_URL) {
        try {
          await axios.patch(
            `https://graph.microsoft.com/v1.0/subscriptions/${subId}`,
            { expirationDateTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString() },
            { headers: { Authorization: `Bearer ${refreshed.accessToken}`, "Content-Type": "application/json" } },
          );
        } catch (subErr: any) {
          console.warn(`[channel-health] Outlook subscription renew failed for ${account.externalId}:`, subErr.response?.data?.error?.message || subErr.message);
        }
      }
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || err.message;
      await prisma.channelAccount.update({
        where: { id: account.id },
        data: { connectionStatus: "ERROR", lastError: `Outlook token is invalid or expired: ${msg}`, lastHealthCheck: new Date() },
      });
      errors++;
    }
  }

  console.log(`[channel-health] Outlook health complete: ${ok} ok (${recovered} recovered), ${errors} errors, ${accounts.length} total`);
}

// ─── Setup Repeatable Jobs + Start Worker ────────────────────

export async function startChannelHealthWorker(): Promise<void> {
  // Create repeatable jobs
  // Health check every 6 hours
  await channelHealthQueue.add(
    "health-check",
    { type: "health_check" },
    {
      repeat: { pattern: "0 */6 * * *" }, // Every 6 hours
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 20 },
    }
  );

  // Token refresh every 12 hours
  await channelHealthQueue.add(
    "token-refresh",
    { type: "token_refresh" },
    {
      repeat: { pattern: "0 3,15 * * *" }, // At 3am and 3pm
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 20 },
    }
  );

  // Gmail watch renewal once daily (watches expire after max 7 days)
  await channelHealthQueue.add(
    "gmail-watch-renew",
    { type: "gmail_watch_renew" },
    {
      repeat: { pattern: "0 2 * * *" }, // Daily at 2am
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 20 },
    }
  );

  // Start the worker
  createWorker<ChannelHealthJob>("channel-health", processChannelHealth, 1);

  console.log("[channel-health] Worker started with repeatable health check (6h, incl. Outlook refresh-and-probe), token refresh (12h), Gmail watch renewal (daily)");
}
