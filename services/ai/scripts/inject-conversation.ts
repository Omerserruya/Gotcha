/**
 * Inject a scripted "customer" conversation into the live `incoming-messages`
 * queue - the same queue the WhatsApp webhook publishes to. The incoming-worker
 * picks each job up, runs the full pipeline (routing → BEL → PB → LLM → tools),
 * and the outgoing-worker sends real WhatsApp replies back to the wa_id.
 *
 * Usage (run inside the `ai` container so REDIS_URL and DATABASE_URL are set):
 *
 *   docker compose exec ai npx tsx scripts/inject-conversation.ts \
 *     --scenario warm_lead \
 *     --tenant <tenantId> \
 *     --channel-account <channelAccountId> \
 *     --wa-id 972525401686 \
 *     --customer-name "Omer Serruya" \
 *     --delay 30
 *
 * Available scenarios:
 *   warm_lead         - greet → interest → features → demo request
 *   price_objection   - interest → ask price → "too expensive" → close
 *   deferral          - interest → "let me think about it"
 *   support           - customer with issue → escalation path
 *   demo_request      - straight demo ask
 *
 * Or `--turns "msg1|msg2|msg3"` for a freeform conversation.
 *
 * IMPORTANT: this fires REAL outbound. Use a phone number you control.
 */

import { incomingMessageQueue, type IncomingMessageJob, prisma } from "@chatcenter/shared";
import crypto from "crypto";

interface CliArgs {
  scenario?: string;
  turns?: string[];
  tenantId: string;
  channelAccountId: string;
  waId: string;
  customerName: string;
  delaySeconds: number;
  dryRun: boolean;
}

const SCENARIOS: Record<string, string[]> = {
  warm_lead: [
    "היי",
    "מתעניין במוצר שלכם, אפשר לשמוע קצת?",
    "אנחנו צוות של 18 נציגים, עובדים בעיקר בוואטסאפ ואינסטגרם",
    "מעניין. יש לכם דמו?",
  ],
  price_objection: [
    "היי",
    "ראיתי את האתר שלכם, יש אפשרות לשמוע על הפיצ'רים?",
    "כמה עולה השירות?",
    "זה יקר מדי בשבילי",
  ],
  deferral: [
    "היי",
    "אני בודק כלי AI לתקשורת עם לקוחות",
    "מעניין, אבל אני אחשוב על זה ואחזור אליכם",
  ],
  support: [
    "היי",
    "המערכת שלי לא עובדת, אני לא מצליח להיכנס לאזור האישי. דחוף!",
  ],
  demo_request: [
    "היי",
    "אני רוצה לקבוע דמו של המערכת",
    "יום חמישי בשעה 14:00 מתאים לי",
  ],
};

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (flag: string) => args.includes(flag);

  const scenario = get("--scenario");
  const turnsRaw = get("--turns");
  const tenantId = get("--tenant");
  const channelAccountId = get("--channel-account");
  const waId = get("--wa-id");
  const customerName = get("--customer-name") || "Test Customer";
  const delaySeconds = Number(get("--delay") || "30");
  const dryRun = has("--dry-run");

  if (!tenantId || !channelAccountId || !waId) {
    console.error("Missing required flags: --tenant, --channel-account, --wa-id");
    console.error("Run with --help for examples.");
    process.exit(1);
  }
  if (!scenario && !turnsRaw) {
    console.error("Provide --scenario <name> OR --turns 'msg1|msg2|msg3'");
    console.error(`Available scenarios: ${Object.keys(SCENARIOS).join(", ")}`);
    process.exit(1);
  }

  const turns = turnsRaw
    ? turnsRaw.split("|").map((s) => s.trim()).filter(Boolean)
    : (scenario ? SCENARIOS[scenario] : undefined);

  if (!turns || turns.length === 0) {
    console.error(`Unknown scenario: ${scenario}`);
    console.error(`Available: ${Object.keys(SCENARIOS).join(", ")}`);
    process.exit(1);
  }

  return { scenario, turns, tenantId, channelAccountId, waId, customerName, delaySeconds, dryRun };
}

async function verifyTenantAndChannel(args: CliArgs): Promise<void> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: args.tenantId },
    select: { id: true, name: true, status: true, botEnabled: true, botType: true },
  });
  if (!tenant) throw new Error(`Tenant not found: ${args.tenantId}`);
  if (tenant.status !== "ACTIVE") {
    throw new Error(`Tenant ${args.tenantId} status=${tenant.status} - must be ACTIVE`);
  }
  console.log(`✓ Tenant: ${tenant.name} (${tenant.id}) status=${tenant.status} botEnabled=${tenant.botEnabled} botType=${tenant.botType}`);

  const ch = await prisma.channelAccount.findFirst({
    where: { id: args.channelAccountId, tenantId: args.tenantId },
    select: { id: true, channel: true, displayName: true, externalId: true, connectionStatus: true },
  });
  if (!ch) throw new Error(`ChannelAccount not found: ${args.channelAccountId} for tenant ${args.tenantId}`);
  if (ch.channel !== "WHATSAPP") {
    console.warn(`⚠ ChannelAccount.channel=${ch.channel} (expected WHATSAPP). Proceeding anyway.`);
  }
  console.log(`✓ ChannelAccount: ${ch.displayName} (${ch.id}) channel=${ch.channel} status=${ch.connectionStatus}`);

  // Find existing conversation (script ANNOTATES that it's reusing one).
  const conv = await prisma.conversation.findFirst({
    where: {
      tenantId: args.tenantId,
      channel: "WHATSAPP",
      customerExternalId: args.waId,
      status: { not: "CLOSED" },
    },
    select: { id: true, status: true, handledBy: true },
    orderBy: { createdAt: "desc" },
  });
  if (conv) {
    console.log(
      `✓ Will REUSE conversation ${conv.id} status=${conv.status} handledBy=${conv.handledBy ?? "null"}`,
    );
  } else {
    console.log(`✓ No open conversation - a fresh one will be created from the first inbound.`);
  }
}

function buildJob(args: CliArgs, body: string, idx: number): IncomingMessageJob {
  // Mimic webhook-service shape closely. The worker idempotency check uses
  // externalMessageId, so make it unique per turn.
  const externalMessageId = `wamid.SCRIPT-${crypto.randomBytes(8).toString("hex")}-${idx}`;
  return {
    tenantId: args.tenantId,
    channel: "WHATSAPP",
    channelAccountId: args.channelAccountId,
    normalizedMessage: {
      externalMessageId,
      senderId: args.waId,
      senderDisplayName: args.customerName,
      timestamp: new Date().toISOString(),
      contentType: "text",
      body,
      messageType: "text",
    },
  };
}

async function run() {
  const args = parseArgs();

  console.log("\n──────────────────────────────────────────────────────────");
  console.log("  inject-conversation");
  console.log("──────────────────────────────────────────────────────────");
  console.log(`  scenario:        ${args.scenario ?? "freeform"}`);
  console.log(`  turns:           ${args.turns!.length}`);
  console.log(`  tenant:          ${args.tenantId}`);
  console.log(`  channelAccount:  ${args.channelAccountId}`);
  console.log(`  wa_id:           ${args.waId}`);
  console.log(`  customer name:   ${args.customerName}`);
  console.log(`  delay between:   ${args.delaySeconds}s`);
  console.log(`  dry run:         ${args.dryRun}`);
  console.log("──────────────────────────────────────────────────────────\n");

  await verifyTenantAndChannel(args);

  console.log("\nThis injects REAL inbound jobs. The bot will reply over WhatsApp");
  console.log("and may write to CRM (create/update lead). Continuing in 5s - Ctrl+C to abort.\n");
  await new Promise((r) => setTimeout(r, 5_000));

  for (let i = 0; i < args.turns!.length; i++) {
    const body = args.turns![i];
    const job = buildJob(args, body, i);

    console.log(`\n[turn ${i + 1}/${args.turns!.length}] inject:`);
    console.log(`   "${body}"`);
    console.log(`   externalMessageId: ${job.normalizedMessage.externalMessageId}`);

    if (args.dryRun) {
      console.log("   (dry-run - not enqueued)");
    } else {
      const enqueued = await incomingMessageQueue.add("process", job);
      console.log(`   ✓ enqueued - bullmq job id ${enqueued.id}`);
    }

    if (i < args.turns!.length - 1) {
      console.log(`   waiting ${args.delaySeconds}s for the bot to reply…`);
      await new Promise((r) => setTimeout(r, args.delaySeconds * 1000));
    }
  }

  console.log("\nAll turns enqueued. Tail the bot:");
  console.log("   docker compose logs -f ai incoming-worker outgoing-worker | grep -E 'ai-bot|behaviorState|tool_call'");
  console.log("\nLatest BEL state for this conversation:");
  console.log(`   docker compose exec db psql -U postgres -d whatsapp_cc -c \\`);
  console.log(
    `     "select createdAt, metadata->'behaviorState'->>'strategy' as strategy, ` +
      `metadata->'behaviorState'->'requiredActions' as required, ` +
      `metadata->'behaviorState'->'playbookIds' as playbooks ` +
      `from audit_logs where action='ai.bot_turn' and tenantId='${args.tenantId}' ` +
      `order by createdAt desc limit 10;"`,
  );

  await prisma.$disconnect();
  await incomingMessageQueue.close();
}

run().catch((err) => {
  console.error("inject-conversation failed:", err);
  process.exit(1);
});
