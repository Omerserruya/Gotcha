import { Job } from "bullmq";
import axios from "axios";
import {
  prisma,
  createWorker,
  channelHealthQueue,
  decryptCredentials,
  encryptCredentials,
} from "@chatcenter/shared";

const FB_API_URL = process.env.FACEBOOK_API_URL || "https://graph.facebook.com/v21.0";
const IG_API_URL = process.env.INSTAGRAM_API_URL || "https://graph.instagram.com";
const META_APP_ID = process.env.META_APP_ID || "";
const META_APP_SECRET = process.env.META_APP_SECRET || "";

interface ChannelHealthJob {
  type: "health_check" | "token_refresh" | "gmail_watch_renew";
}

async function processChannelHealth(job: Job<ChannelHealthJob>): Promise<void> {
  const { type } = job.data;

  if (type === "health_check") {
    await runHealthCheck();
  } else if (type === "token_refresh") {
    await runTokenRefresh();
  } else if (type === "gmail_watch_renew") {
    await runGmailWatchRenewal();
  }
}

// ─── Health Check ────────────────────────────────────────────

async function runHealthCheck(): Promise<void> {
  console.log("[channel-health] Running health check...");

  // Only check Meta channels - Facebook's debug_token API doesn't apply to Gmail/Outlook/Slack
  const accounts = await prisma.channelAccount.findMany({
    where: {
      connectionStatus: "CONNECTED",
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
          await prisma.channelAccount.update({
            where: { id: account.id },
            data: { lastHealthCheck: new Date() },
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
        const updateData: any = { lastHealthCheck: new Date() };
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

  console.log(`[channel-health] Health check complete: ${checked} checked, ${errors} errors, ${accounts.length} total`);
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

  console.log("[channel-health] Worker started with repeatable health check (6h), token refresh (12h), Gmail watch renewal (daily)");
}
