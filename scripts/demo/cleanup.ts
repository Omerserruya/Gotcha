/**
 * Demo cleanup — reset state for a fresh rehearsal.
 *
 * Deletes (for the demo tenant only):
 *   - The demo WhatsApp conversation + its messages
 *   - AuditLog rows scoped to that conversation
 *   - ApprovalRequests for that conversation
 *   - IdentityLinkSuggestions involving the pre-seeded demo contacts
 *   - The pre-seeded WA + EMAIL contacts (the run-demo script re-seeds them)
 *
 * Leaves alone:
 *   - Zoho Lead records already created (cleanup would require Zoho API access;
 *     the demo doesn't re-create leads with the same IDs so residue is harmless)
 *   - Agent config tweaks (systemPrompt, maxAutonomousMinutes) — pass
 *     --restore-agent to revert those too.
 */
import { PrismaClient } from "@prisma/client";

const TENANT_ID = "cmmov5qh10000ltnqm7pmxqzc";
const AGENT_ID = "cmnvsm2ao0003eioazm6qbg8c";
const WA_EXT = "972525401686";
const EMAIL_EXT = "omerts58@gmail.com";

process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/whatsapp_cc";

const prisma = new PrismaClient();
const restoreAgent = process.argv.includes("--restore-agent");

async function main() {
  const conv = await prisma.conversation.findFirst({
    where: { tenantId: TENANT_ID, channel: "WHATSAPP", customerExternalId: WA_EXT },
    select: { id: true },
  });

  if (conv) {
    const msgCount = await prisma.message.count({ where: { conversationId: conv.id } });
    const auditCount = await prisma.auditLog.count({
      where: { tenantId: TENANT_ID, targetType: "conversation", targetId: conv.id },
    });
    const apprCount = await prisma.approvalRequest.count({
      where: { tenantId: TENANT_ID, conversationId: conv.id },
    });

    await prisma.message.deleteMany({ where: { conversationId: conv.id } });
    await prisma.auditLog.deleteMany({
      where: { tenantId: TENANT_ID, targetType: "conversation", targetId: conv.id },
    });
    await prisma.approvalRequest.deleteMany({
      where: { tenantId: TENANT_ID, conversationId: conv.id },
    });
    await prisma.conversation.delete({ where: { id: conv.id } });
    console.log(
      `✓ deleted conversation ${conv.id} (${msgCount} msgs, ${auditCount} audits, ${apprCount} approvals)`,
    );
  } else {
    console.log("(no conversation to delete)");
  }

  // Contacts + suggestions tied to them
  const waContact = await prisma.contact.findFirst({
    where: { tenantId: TENANT_ID, channel: "WHATSAPP", externalId: WA_EXT },
    select: { id: true },
  });
  const emailContact = await prisma.contact.findFirst({
    where: { tenantId: TENANT_ID, channel: "EMAIL", externalId: EMAIL_EXT },
    select: { id: true },
  });
  const contactIds = [waContact?.id, emailContact?.id].filter(Boolean) as string[];

  if (contactIds.length) {
    const sugg = await prisma.identityLinkSuggestion.deleteMany({
      where: {
        tenantId: TENANT_ID,
        OR: [
          { sourceContactId: { in: contactIds } },
          { targetContactId: { in: contactIds } },
          { identifierValue: EMAIL_EXT },
        ],
      },
    });
    console.log(`✓ deleted ${sugg.count} identity link suggestions`);
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    console.log(`✓ deleted ${contactIds.length} seeded contacts`);
  }

  if (restoreAgent) {
    await prisma.aIAgent.update({
      where: { id: AGENT_ID },
      data: {
        systemPrompt: "",
        maxAutonomousMinutes: 15,
        maxAutonomousMessages: 10,
      },
    });
    console.log("✓ agent restored (systemPrompt='', limits 15min / 10 msgs)");
  }

  console.log("\nDemo state is clean. Run run-demo.ts to start a new rehearsal.");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
