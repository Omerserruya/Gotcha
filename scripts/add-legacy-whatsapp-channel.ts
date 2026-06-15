/**
 * One-off: add a LEGACY WhatsApp Cloud API channel (raw permanent access
 * token, no Embedded Signup OAuth). Mirrors the real connect flow in
 * services/auth/src/routes/channels.ts so the row is byte-identical to what
 * the workers expect.
 *
 * Reads secrets from env (not argv) so the token never hits shell history.
 *
 * Run from repo root (Node 18 has no --env-file, so source .env first):
 *   set -a; . ./.env; set +a
 *   WA_TENANT_ID=<tenantId> \
 *   WA_PHONE_NUMBER_ID=<phone_number_id> \
 *   WA_WABA_ID=<waba_id> \
 *   WA_PHONE="+972500000000" \
 *   WA_ACCESS_TOKEN=$WHATSAPP_ACCESS_TOKEN \
 *   npx tsx scripts/add-legacy-whatsapp-channel.ts
 *
 * (sourcing .env loads DATABASE_URL + CHANNEL_ENCRYPTION_KEY; the WA_* vars
 *  you pass on the line above take precedence.)
 */
import { prisma, encryptCredentials } from "@chatcenter/shared";

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v.trim();
}

async function main() {
  const tenantId = required("WA_TENANT_ID");
  const phoneNumberId = required("WA_PHONE_NUMBER_ID"); // becomes externalId
  const wabaId = required("WA_WABA_ID");
  const phoneNumber = required("WA_PHONE"); // display, e.g. +9725...
  const accessToken = required("WA_ACCESS_TOKEN");

  // Same shape the OAuth flow stores: { accessToken, wabaId, phoneNumber }
  const credentials = encryptCredentials({ accessToken, wabaId, phoneNumber });
  // Cloud API business tokens are effectively non-expiring; stamp +1y like the flow.
  const tokenExpiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

  const row = await prisma.channelAccount.upsert({
    where: { channel_externalId: { channel: "WHATSAPP", externalId: phoneNumberId } },
    update: {
      tenantId,
      credentials,
      isActive: true,
      connectionStatus: "CONNECTED",
      connectedAt: new Date(),
      tokenExpiresAt,
      lastError: null,
      displayName: phoneNumber,
      platformMeta: { wabaId, legacy: true },
    },
    create: {
      tenantId,
      channel: "WHATSAPP",
      externalId: phoneNumberId,
      displayName: phoneNumber,
      credentials,
      isActive: true,
      connectionStatus: "CONNECTED",
      connectedAt: new Date(),
      tokenExpiresAt,
      platformMeta: { wabaId, legacy: true },
    },
    select: { id: true, tenantId: true, externalId: true, displayName: true, connectionStatus: true },
  });

  console.log("✅ WhatsApp channel ready:", row);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("❌ Failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
