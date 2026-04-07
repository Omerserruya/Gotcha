import { PrismaClient } from "@prisma/client";
import { encryptCredentials } from "../src/lib/encryption";

const prisma = new PrismaClient();

async function main() {
  const tenant = await prisma.tenant.findFirst({ where: { slug: "demo-company" } });
  if (!tenant) { console.error("Tenant not found"); process.exit(1); }

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID!;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN!;
  const wabaId = "3013648112165582";

  // Delete existing
  const deleted = await prisma.channelAccount.deleteMany({ where: { channel: "WHATSAPP", tenantId: tenant.id } });
  console.log(`Deleted ${deleted.count} existing WhatsApp channel(s)`);

  // Encrypt credentials
  const credentials = encryptCredentials({ accessToken, wabaId, phoneNumber: phoneNumberId });

  // Insert
  const account = await prisma.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channel: "WHATSAPP",
      externalId: phoneNumberId,
      displayName: `WhatsApp Business`,
      connectionStatus: "CONNECTED",
      connectedAt: new Date(),
      credentials,
      platformMeta: { wabaId },
      tokenExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      isActive: true,
    },
  });

  console.log(`Created WhatsApp channel: ${account.id}`);
  console.log("  externalId:", account.externalId);
  console.log("  credentials: encrypted ✓");
}

main().catch(console.error).finally(() => prisma.$disconnect());
