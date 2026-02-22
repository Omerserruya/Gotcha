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
const META_APP_ID = process.env.META_APP_ID || "";
const META_APP_SECRET = process.env.META_APP_SECRET || "";

interface ChannelHealthJob {
  type: "health_check" | "token_refresh";
}

async function processChannelHealth(job: Job<ChannelHealthJob>): Promise<void> {
  const { type } = job.data;

  if (type === "health_check") {
    await runHealthCheck();
  } else if (type === "token_refresh") {
    await runTokenRefresh();
  }
}

// ─── Health Check ────────────────────────────────────────────

async function runHealthCheck(): Promise<void> {
  console.log("[channel-health] Running health check...");

  const accounts = await prisma.channelAccount.findMany({
    where: { connectionStatus: "CONNECTED", isActive: true },
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

      // Exchange for new long-lived token
      const response = await axios.get(`${FB_API_URL}/oauth/access_token`, {
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

  // Start the worker
  createWorker<ChannelHealthJob>("channel-health", processChannelHealth, 1);

  console.log("[channel-health] Worker started with repeatable health check (6h) and token refresh (12h)");
}
