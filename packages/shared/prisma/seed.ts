import { PrismaClient } from "@prisma/client";
import { encryptCredentials } from "../src/lib/encryption";
import { seedIntelligencePacks } from "./seed-intelligence-packs";

// Every credential the seed writes goes through encryptCredentials, exactly as
// the runtime writers do.
//
// It did not, and that was not merely untidy. Several of these read a REAL
// token out of the environment (WHATSAPP_ACCESS_TOKEN, MESSENGER_ACCESS_TOKEN,
// ...), so seeding a machine that had them set wrote live provider credentials
// into the database in plaintext. Nothing complained, because every reader
// carries a `typeof creds === "string" ? decrypt(creds) : creds` shim for
// exactly this shape - the compatibility that kept the seed working is what
// kept the plaintext invisible.
//
// Encrypting here also fixes a second, quieter bug: a seeded row was a JSON
// object where the runtime writes a base64 string, so seeded integrations were
// in a format `decryptCredentials` cannot read at all.
const creds = (data: Record<string, unknown>) => encryptCredentials(data) as unknown as any;


const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...\n");

  // ─── Tenant ──────────────────────────────────────────────────
  const tenant = await prisma.tenant.upsert({
    where: { slug: "demo-company" },
    update: { status: "ACTIVE", isActive: true, botEnabled: true, botType: "AUTONOMOUS_AI", firstTakeCareEnabled: true },
    create: {
      name: "Demo Company",
      slug: "demo-company",
      status: "ACTIVE",
      isActive: true,
      botEnabled: true,
      botType: "AUTONOMOUS_AI",
      firstTakeCareEnabled: true,
    },
  });
  console.log(`Tenant: ${tenant.name} (${tenant.id}) - ACTIVE`);

  // ─── Business Profile ────────────────────────────────────────
  await prisma.businessProfile.upsert({
    where: { tenantId: tenant.id },
    update: {},
    create: {
      tenantId: tenant.id,
      organizationName: "Demo Company Ltd.",
      industry: "SaaS / Customer Communication",
      businessDescription: "AI-powered omnichannel customer communication platform for businesses",
      businessPriority: "FAST_RESPONSE",
      estimatedDailyConversations: 500,
      numberOfAgents: 10,
    },
  });

  // ─── Onboarding (completed) ──────────────────────────────────
  await prisma.tenantOnboarding.upsert({
    where: { tenantId: tenant.id },
    update: { currentStep: "COMPLETED", completedAt: new Date() },
    create: {
      tenantId: tenant.id,
      currentStep: "COMPLETED",
      completedAt: new Date(),
    },
  });

  // ─── Channel Accounts ────────────────────────────────────────
  const waAccount = await prisma.channelAccount.upsert({
    where: { channel_externalId: { channel: "WHATSAPP", externalId: process.env.WHATSAPP_PHONE_NUMBER_ID || "demo-wa-id" } },
    update: {},
    create: {
      tenantId: tenant.id,
      channel: "WHATSAPP",
      externalId: process.env.WHATSAPP_PHONE_NUMBER_ID || "demo-wa-id",
      displayName: "Demo WhatsApp",
      connectionStatus: "CONNECTED",
      connectedAt: new Date(),
      credentials: creds({
        accessToken: process.env.WHATSAPP_ACCESS_TOKEN || "demo-token",
        webhookSecret: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "demo-secret",
      }),
    },
  });

  const msgAccount = await prisma.channelAccount.upsert({
    where: { channel_externalId: { channel: "MESSENGER", externalId: process.env.MESSENGER_PAGE_ID || "demo-msn-id" } },
    update: {},
    create: {
      tenantId: tenant.id,
      channel: "MESSENGER",
      externalId: process.env.MESSENGER_PAGE_ID || "demo-msn-id",
      displayName: "Demo Messenger",
      connectionStatus: "CONNECTED",
      connectedAt: new Date(),
      credentials: creds({ accessToken: process.env.MESSENGER_ACCESS_TOKEN || "demo-messenger-token" }),
    },
  });

  const insAccount = await prisma.channelAccount.upsert({
    where: { channel_externalId: { channel: "INSTAGRAM", externalId: "demo-ins-id" } },
    update: {},
    create: {
      tenantId: tenant.id,
      channel: "INSTAGRAM",
      externalId: "demo-ins-id",
      displayName: "Demo Instagram",
      connectionStatus: "CONNECTED",
      connectedAt: new Date(),
      credentials: creds({ accessToken: "demo-instagram-token" }),
    },
  });

  const gmailAccount = await prisma.channelAccount.upsert({
    where: { channel_externalId: { channel: "GMAIL", externalId: "demo-gmail-id" } },
    update: {},
    create: {
      tenantId: tenant.id,
      channel: "GMAIL",
      externalId: "demo-gmail-id",
      displayName: "Demo Gmail",
      connectionStatus: "CONNECTED",
      connectedAt: new Date(),
      credentials: creds({ accessToken: "demo-gmail-token" }),
    },
  });

  const outlookAccount = await prisma.channelAccount.upsert({
    where: { channel_externalId: { channel: "OUTLOOK", externalId: "demo-outlook-id" } },
    update: {},
    create: {
      tenantId: tenant.id,
      channel: "OUTLOOK",
      externalId: "demo-outlook-id",
      displayName: "Demo Outlook",
      connectionStatus: "CONNECTED",
      connectedAt: new Date(),
      credentials: creds({ accessToken: "demo-outlook-token" }),
    },
  });

  const slackAccount = await prisma.channelAccount.upsert({
    where: { channel_externalId: { channel: "SLACK", externalId: "demo-slack-id" } },
    update: {},
    create: {
      tenantId: tenant.id,
      channel: "SLACK",
      externalId: "demo-slack-id",
      displayName: "Demo Slack",
      connectionStatus: "CONNECTED",
      connectedAt: new Date(),
      credentials: creds({ accessToken: "demo-slack-token" }),
    },
  });

  console.log("Channel accounts: WhatsApp, Messenger, Instagram, Gmail, Outlook, Slack");

  // ─── Tenant Channel Config ───────────────────────────────────
  await prisma.tenantChannelConfig.upsert({
    where: { tenantId: tenant.id },
    update: {},
    create: { tenantId: tenant.id, botFlowMode: "UNIFIED" },
  });

  // ─── Users ───────────────────────────────────────────────────
  //
  // Seeded users need an Authentik identity or nobody can log in as them:
  // GOTCHA stores no credential, so a user row without a subject is inert.
  // We provision the identity and set a well-known dev password through
  // Authentik's admin API.
  //
  // DEV SEED ONLY. This is the single place in the repo that puts a password
  // anywhere, it talks to Authentik rather than storing anything locally, and
  // it refuses to run against a production database.
  if (process.env.NODE_ENV === "production") {
    throw new Error("[seed] refusing to seed demo users with known passwords in production");
  }

  const AK_URL = process.env.AUTHENTIK_URL || "http://localhost:9000";
  const AK_TOKEN = process.env.AUTHENTIK_API_TOKEN || process.env.AUTHENTIK_BOOTSTRAP_TOKEN;

  async function seedIdentity(email: string, name: string, password: string): Promise<string> {
    if (!AK_TOKEN) throw new Error("[seed] AUTHENTIK_BOOTSTRAP_TOKEN required to seed users");
    const h = { Authorization: `Bearer ${AK_TOKEN}`, "Content-Type": "application/json" };

    const found = await fetch(`${AK_URL}/api/v3/core/users/?email=${encodeURIComponent(email)}`, { headers: h })
      .then((r) => r.json());
    let user = found.results?.find((u: any) => u.email === email);

    if (!user) {
      const res = await fetch(`${AK_URL}/api/v3/core/users/`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ username: email, email, name, is_active: true, path: "users", type: "internal" }),
      });
      if (!res.ok) throw new Error(`[seed] create identity failed: ${await res.text()}`);
      user = await res.json();
    }

    const pw = await fetch(`${AK_URL}/api/v3/core/users/${user.pk}/set_password/`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ password }),
    });
    if (!pw.ok) throw new Error(`[seed] set password failed: ${await pw.text()}`);

    return user.uuid;
  }

  // System Admin
  const sysAdminSubject = await seedIdentity("system@demo.com", "System Admin", "admin123");
  const sysAdmin = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: "system@demo.com" } },
    update: { authentikSubject: sysAdminSubject },
    create: {
      tenantId: tenant.id,
      email: "system@demo.com",
      name: "System Admin",
      role: "SYSTEM_ADMIN",
      authentikSubject: sysAdminSubject,
    },
  });

  // Admin
  const adminSubject = await seedIdentity("admin@demo.com", "Admin User", "admin123");
  const admin = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: "admin@demo.com" } },
    update: { authentikSubject: adminSubject },
    create: {
      tenantId: tenant.id,
      email: "admin@demo.com",
      name: "Admin User",
      role: "ADMIN",
      authentikSubject: adminSubject,
    },
  });

  // Agents
  const agents = [];
  const agentData = [
    { email: "dana@demo.com", name: "Dana Avraham" },
    { email: "yossi@demo.com", name: "Yossi Katz" },
    { email: "maya@demo.com", name: "Maya Ben-David" },
    { email: "eli@demo.com", name: "Eli Rosenberg" },
  ];
  for (const a of agentData) {
    const subject = await seedIdentity(a.email, a.name, "agent123");
    const agent = await prisma.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email: a.email } },
      update: { authentikSubject: subject },
      create: { tenantId: tenant.id, email: a.email, name: a.name, role: "AGENT", authentikSubject: subject },
    });
    agents.push(agent);
  }
  console.log(`Users: 1 sysadmin, 1 admin, ${agents.length} agents`);

  // ─── Departments ─────────────────────────────────────────────
  const salesDept = await prisma.department.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: "Sales" } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: "Sales",
      description: "Sales and pre-sales inquiries",
      queueMode: "ROUND_ROBIN",
      slaTarget: 5,
      autoGreetingEnabled: true,
      autoGreetingMessage: "Hi! Thanks for reaching out to our sales team. An agent will be with you shortly.",
      autoCloseMinutes: 1440,
      aiSuggestionsEnabled: true,
    },
  });

  const supportDept = await prisma.department.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: "Support" } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: "Support",
      description: "Technical support and troubleshooting",
      queueMode: "CLAIM",
      slaTarget: 15,
      autoGreetingEnabled: true,
      autoGreetingMessage: "Hello! Our support team has received your message. We'll help you as soon as possible.",
      autoCloseMinutes: 720,
      escalateOnSlaBreach: true,
      aiSuggestionsEnabled: true,
    },
  });

  const billingDept = await prisma.department.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: "Billing" } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: "Billing",
      description: "Billing, payments, and invoicing",
      queueMode: "ROUND_ROBIN",
      slaTarget: 30,
      aiSuggestionsEnabled: true,
    },
  });

  // Assign agents to departments
  await prisma.departmentMember.upsert({
    where: { userId: agents[0].id },
    update: {},
    create: { userId: agents[0].id, tenantId: tenant.id, departmentId: salesDept.id, departmentRole: "MANAGER" },
  });
  await prisma.departmentMember.upsert({
    where: { userId: agents[1].id },
    update: {},
    create: { userId: agents[1].id, tenantId: tenant.id, departmentId: salesDept.id, departmentRole: "AGENT" },
  });
  await prisma.departmentMember.upsert({
    where: { userId: agents[2].id },
    update: {},
    create: { userId: agents[2].id, tenantId: tenant.id, departmentId: supportDept.id, departmentRole: "MANAGER" },
  });
  await prisma.departmentMember.upsert({
    where: { userId: agents[3].id },
    update: {},
    create: { userId: agents[3].id, tenantId: tenant.id, departmentId: billingDept.id, departmentRole: "AGENT" },
  });
  console.log("Departments: Sales, Support, Billing (agents assigned)");

  // ─── Marketplace: Tenant Integrations & Tools ───────────────
  // Catalog is seeded by migration. Look up entries by slug.
  const shopifyCatalog = await prisma.integrationCatalog.findUnique({ where: { slug: "shopify" } });
  const hubspotCatalog = await prisma.integrationCatalog.findUnique({ where: { slug: "hubspot" } });

  if (!shopifyCatalog || !hubspotCatalog) {
    throw new Error("Integration catalog not seeded. Run migrations first.");
  }

  // TenantIntegration: connect Shopify
  const shopifyTenantInt = await prisma.tenantIntegration.upsert({
    where: { tenantId_integrationId: { tenantId: tenant.id, integrationId: shopifyCatalog.id } },
    update: {},
    create: {
      tenantId: tenant.id,
      integrationId: shopifyCatalog.id,
      status: "CONNECTED",
      credentials: creds({ apiKey: "demo-shopify-key", apiUrl: "https://demo-store.myshopify.com" }),
      config: {},
      connectedAt: new Date(),
      lastTestedAt: new Date(),
      lastTestResult: true,
    },
  });

  // TenantIntegration: connect HubSpot
  const hubspotTenantInt = await prisma.tenantIntegration.upsert({
    where: { tenantId_integrationId: { tenantId: tenant.id, integrationId: hubspotCatalog.id } },
    update: {},
    create: {
      tenantId: tenant.id,
      integrationId: hubspotCatalog.id,
      status: "CONNECTED",
      credentials: creds({ apiKey: "demo-hubspot-key" }),
      config: {},
      connectedAt: new Date(),
      lastTestedAt: new Date(),
      lastTestResult: true,
    },
  });

  // Look up catalog tools by slug
  const catalogOrderLookup   = await prisma.catalogTool.findFirst({ where: { integrationId: shopifyCatalog.id, slug: "order_lookup" } });
  const catalogTrackShipment = await prisma.catalogTool.findFirst({ where: { integrationId: shopifyCatalog.id, slug: "track_shipment" } });
  const catalogProcessRefund = await prisma.catalogTool.findFirst({ where: { integrationId: shopifyCatalog.id, slug: "process_refund" } });
  const catalogCrmLookup     = await prisma.catalogTool.findFirst({ where: { integrationId: hubspotCatalog.id, slug: "customer_lookup" } });
  const catalogCreateDeal    = await prisma.catalogTool.findFirst({ where: { integrationId: hubspotCatalog.id, slug: "create_deal" } });

  if (!catalogOrderLookup || !catalogTrackShipment || !catalogProcessRefund || !catalogCrmLookup || !catalogCreateDeal) {
    throw new Error("Catalog tools not found. Run migrations first.");
  }

  // TenantTools: enable specific Shopify tools
  const tenantOrderLookup = await prisma.tenantTool.upsert({
    where: { tenantIntegrationId_catalogToolId: { tenantIntegrationId: shopifyTenantInt.id, catalogToolId: catalogOrderLookup.id } },
    update: {},
    create: { tenantId: tenant.id, tenantIntegrationId: shopifyTenantInt.id, catalogToolId: catalogOrderLookup.id, isEnabled: true },
  });

  const tenantTrackShipment = await prisma.tenantTool.upsert({
    where: { tenantIntegrationId_catalogToolId: { tenantIntegrationId: shopifyTenantInt.id, catalogToolId: catalogTrackShipment.id } },
    update: {},
    create: { tenantId: tenant.id, tenantIntegrationId: shopifyTenantInt.id, catalogToolId: catalogTrackShipment.id, isEnabled: true },
  });

  const tenantProcessRefund = await prisma.tenantTool.upsert({
    where: { tenantIntegrationId_catalogToolId: { tenantIntegrationId: shopifyTenantInt.id, catalogToolId: catalogProcessRefund.id } },
    update: {},
    create: { tenantId: tenant.id, tenantIntegrationId: shopifyTenantInt.id, catalogToolId: catalogProcessRefund.id, isEnabled: true },
  });

  // TenantTools: enable specific HubSpot tools
  const tenantCrmLookup = await prisma.tenantTool.upsert({
    where: { tenantIntegrationId_catalogToolId: { tenantIntegrationId: hubspotTenantInt.id, catalogToolId: catalogCrmLookup.id } },
    update: {},
    create: { tenantId: tenant.id, tenantIntegrationId: hubspotTenantInt.id, catalogToolId: catalogCrmLookup.id, isEnabled: true },
  });

  const tenantCreateDeal = await prisma.tenantTool.upsert({
    where: { tenantIntegrationId_catalogToolId: { tenantIntegrationId: hubspotTenantInt.id, catalogToolId: catalogCreateDeal.id } },
    update: {},
    create: { tenantId: tenant.id, tenantIntegrationId: hubspotTenantInt.id, catalogToolId: catalogCreateDeal.id, isEnabled: true },
  });

  console.log("Tenant integrations: Shopify (CONNECTED), HubSpot (CONNECTED) - 5 tools enabled");

  // ─── Agent Tool Permissions ──────────────────────────────────
  // Sales: HubSpot Customer Lookup (auto), HubSpot Create Deal (auto)
  await prisma.agentToolPermission.create({
    data: { tenantId: tenant.id, departmentId: salesDept.id, tenantToolId: tenantCrmLookup.id, isAllowed: true, requireApproval: false },
  });
  await prisma.agentToolPermission.create({
    data: { tenantId: tenant.id, departmentId: salesDept.id, tenantToolId: tenantCreateDeal.id, isAllowed: true, requireApproval: false },
  });

  // Support: Shopify Order Lookup (auto), Track Shipment (auto), Process Refund (requires approval)
  await prisma.agentToolPermission.create({
    data: { tenantId: tenant.id, departmentId: supportDept.id, tenantToolId: tenantOrderLookup.id, isAllowed: true, requireApproval: false },
  });
  await prisma.agentToolPermission.create({
    data: { tenantId: tenant.id, departmentId: supportDept.id, tenantToolId: tenantTrackShipment.id, isAllowed: true, requireApproval: false },
  });
  await prisma.agentToolPermission.create({
    data: { tenantId: tenant.id, departmentId: supportDept.id, tenantToolId: tenantProcessRefund.id, isAllowed: true, requireApproval: true },
  });

  // Billing: Shopify Order Lookup (auto), Process Refund (auto)
  await prisma.agentToolPermission.create({
    data: { tenantId: tenant.id, departmentId: billingDept.id, tenantToolId: tenantOrderLookup.id, isAllowed: true, requireApproval: false },
  });
  await prisma.agentToolPermission.create({
    data: { tenantId: tenant.id, departmentId: billingDept.id, tenantToolId: tenantProcessRefund.id, isAllowed: true, requireApproval: false },
  });

  console.log("Agent tool permissions configured");

  // ─── Conversations with realistic message threads ────────────
  const now = new Date();
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60000);

  // Conversation 1: WhatsApp - Sales inquiry (assigned, multi-message)
  const conv1 = await prisma.conversation.create({
    data: {
      tenantId: tenant.id,
      channel: "WHATSAPP",
      channelAccountId: waAccount.id,
      customerExternalId: "+972501234567",
      customerName: "David Cohen",
      assignedAgentId: agents[0].id,
      departmentId: salesDept.id,
      status: "OPEN",
      lastMessageAt: ago(3),
    },
  });
  const conv1Messages = [
    { dir: "INBOUND" as const, body: "Hi, I saw your product online. Can you tell me about pricing?", sender: "David Cohen", at: ago(30) },
    { dir: "OUTBOUND" as const, body: "Hi David! Thanks for your interest. We have 3 plans: Starter ($49/mo), Pro ($149/mo), and Enterprise (custom). What's your team size?", sender: "Dana Avraham", at: ago(25) },
    { dir: "INBOUND" as const, body: "We're about 15 people. Mostly customer support agents.", sender: "David Cohen", at: ago(20) },
    { dir: "OUTBOUND" as const, body: "For a team of 15, I'd recommend our Pro plan. It includes AI copilot, analytics, and up to 20 agent seats. Want me to set up a demo?", sender: "Dana Avraham", at: ago(15) },
    { dir: "INBOUND" as const, body: "Yes please! Can we do it this week?", sender: "David Cohen", at: ago(3) },
  ];
  for (const m of conv1Messages) {
    await prisma.message.create({
      data: { tenantId: tenant.id, conversationId: conv1.id, channel: "WHATSAPP", direction: m.dir, body: m.body, senderName: m.sender, status: "DELIVERED", createdAt: m.at },
    });
  }

  // Conversation 2: Messenger - Support issue (open, waiting on customer)
  const conv2 = await prisma.conversation.create({
    data: {
      tenantId: tenant.id,
      channel: "MESSENGER",
      channelAccountId: msgAccount.id,
      customerExternalId: "psid_100001",
      customerName: "Sarah Levi",
      assignedAgentId: agents[2].id,
      departmentId: supportDept.id,
      status: "WAITING",
      lastMessageAt: ago(120),
    },
  });
  const conv2Messages = [
    { dir: "INBOUND" as const, body: "My dashboard is showing an error when I try to export reports", sender: "Sarah Levi", at: ago(180) },
    { dir: "OUTBOUND" as const, body: "Hi Sarah, sorry about that. Can you tell me which browser you're using and share a screenshot of the error?", sender: "Maya Ben-David", at: ago(170) },
    { dir: "INBOUND" as const, body: "Chrome latest version. Here's what I see: 'Export failed: timeout error'", sender: "Sarah Levi", at: ago(150) },
    { dir: "OUTBOUND" as const, body: "Thanks! This looks like a known issue with large exports. I've applied a fix to your account. Can you try again and let me know?", sender: "Maya Ben-David", at: ago(120) },
  ];
  for (const m of conv2Messages) {
    await prisma.message.create({
      data: { tenantId: tenant.id, conversationId: conv2.id, channel: "MESSENGER", direction: m.dir, body: m.body, senderName: m.sender, status: "DELIVERED", createdAt: m.at },
    });
  }

  // Conversation 3: Instagram - New lead (unassigned)
  const conv3 = await prisma.conversation.create({
    data: {
      tenantId: tenant.id,
      channel: "INSTAGRAM",
      channelAccountId: insAccount.id,
      customerExternalId: "igid_200001",
      customerName: "Noa Mizrahi",
      status: "OPEN",
      lastMessageAt: ago(5),
    },
  });
  await prisma.message.create({
    data: { tenantId: tenant.id, conversationId: conv3.id, channel: "INSTAGRAM", direction: "INBOUND", body: "Love your product! How much is the starter plan? Also do you integrate with Shopify?", senderName: "Noa Mizrahi", status: "DELIVERED", createdAt: ago(5) },
  });

  // Conversation 4: Gmail - Billing question (assigned)
  const conv4 = await prisma.conversation.create({
    data: {
      tenantId: tenant.id,
      channel: "GMAIL",
      channelAccountId: gmailAccount.id,
      customerExternalId: "billing@acmecorp.com",
      customerName: "Yael Shapira",
      assignedAgentId: agents[3].id,
      departmentId: billingDept.id,
      status: "OPEN",
      lastMessageAt: ago(45),
    },
  });
  const conv4Messages = [
    { dir: "INBOUND" as const, body: "Hi, I was charged twice for last month's subscription. Invoice #INV-2024-0891. Please look into this.", sender: "Yael Shapira", at: ago(60) },
    { dir: "OUTBOUND" as const, body: "Hi Yael, I'm looking into this right now. Let me check your billing history.", sender: "Eli Rosenberg", at: ago(55) },
    { dir: "OUTBOUND" as const, body: "I found the duplicate charge. I've initiated a refund of $149 to your card ending in 4242. You should see it within 3-5 business days. Sorry for the inconvenience!", sender: "Eli Rosenberg", at: ago(45) },
  ];
  for (const m of conv4Messages) {
    await prisma.message.create({
      data: { tenantId: tenant.id, conversationId: conv4.id, channel: "GMAIL", direction: m.dir, body: m.body, senderName: m.sender, status: "DELIVERED", createdAt: m.at },
    });
  }

  // Conversation 5: Slack - Internal request
  const conv5 = await prisma.conversation.create({
    data: {
      tenantId: tenant.id,
      channel: "SLACK",
      channelAccountId: slackAccount.id,
      customerExternalId: "U0SLACK001",
      customerName: "Ron Peretz",
      assignedAgentId: agents[1].id,
      departmentId: salesDept.id,
      status: "OPEN",
      lastMessageAt: ago(10),
    },
  });
  await prisma.message.create({
    data: { tenantId: tenant.id, conversationId: conv5.id, channel: "SLACK", direction: "INBOUND", body: "Quick question - can we get an API key for the sandbox environment? We want to test the integration before going live.", senderName: "Ron Peretz", status: "DELIVERED", createdAt: ago(10) },
  });

  // Conversation 6: WhatsApp - Closed conversation (for history/replay)
  const conv6 = await prisma.conversation.create({
    data: {
      tenantId: tenant.id,
      channel: "WHATSAPP",
      channelAccountId: waAccount.id,
      customerExternalId: "+972509876543",
      customerName: "Amit Goldberg",
      assignedAgentId: agents[0].id,
      departmentId: salesDept.id,
      status: "CLOSED",
      closedAt: ago(60),
      lastMessageAt: ago(65),
      aiSummary: "Customer inquired about enterprise pricing and API access. Agent provided pricing details and scheduled a technical demo for next week.",
    },
  });
  const conv6Messages = [
    { dir: "INBOUND" as const, body: "Hi, we're evaluating communication platforms for our enterprise. What API capabilities do you offer?", sender: "Amit Goldberg", at: ago(120) },
    { dir: "OUTBOUND" as const, body: "Welcome Amit! Our Enterprise plan includes full REST API access, webhooks, and SDKs for Node.js, Python, and Java. What's your use case?", sender: "Dana Avraham", at: ago(115) },
    { dir: "INBOUND" as const, body: "We need to integrate with our existing CRM (Salesforce) and have automated messaging for order updates.", sender: "Amit Goldberg", at: ago(100) },
    { dir: "OUTBOUND" as const, body: "Great news - we have native Salesforce integration and support automated transactional messages. I'll schedule a technical demo. Does Thursday work?", sender: "Dana Avraham", at: ago(90) },
    { dir: "INBOUND" as const, body: "Thursday at 2pm works. Send me a calendar invite to amit@goldberg-tech.com", sender: "Amit Goldberg", at: ago(80) },
    { dir: "OUTBOUND" as const, body: "Done! You'll receive the invite shortly. Looking forward to the demo. Have a great day!", sender: "Dana Avraham", at: ago(65) },
  ];
  for (const m of conv6Messages) {
    await prisma.message.create({
      data: { tenantId: tenant.id, conversationId: conv6.id, channel: "WHATSAPP", direction: m.dir, body: m.body, senderName: m.sender, status: "DELIVERED", createdAt: m.at },
    });
  }

  console.log("Conversations: 6 (4 open, 1 waiting, 1 closed)");

  // ─── Conversation Intelligence (for closed conversation) ────
  await prisma.conversationIntelligence.upsert({
    where: { conversationId: conv6.id },
    update: {},
    create: {
      tenantId: tenant.id,
      conversationId: conv6.id,
      summary: "Enterprise customer exploring platform capabilities. Focused on API access and Salesforce integration. Demo scheduled for Thursday.",
      detectedIntent: "enterprise_inquiry",
      intentConfidence: 0.92,
      sentiment: "positive",
      sentimentScore: 0.85,
      topics: ["enterprise", "API", "CRM integration", "Salesforce", "pricing"],
      toolsUsed: [{ tenantToolId: tenantCrmLookup.id, toolName: "Customer CRM Lookup", success: true }],
      resolutionOutcome: "resolved",
      customerEffort: 1,
      aiConfidence: 0.88,
    },
  });

  // Intelligence for billing conversation
  await prisma.conversationIntelligence.upsert({
    where: { conversationId: conv4.id },
    update: {},
    create: {
      tenantId: tenant.id,
      conversationId: conv4.id,
      summary: "Customer reported duplicate billing charge. Agent verified and initiated refund.",
      detectedIntent: "billing_dispute",
      intentConfidence: 0.95,
      sentiment: "negative",
      sentimentScore: -0.3,
      topics: ["billing", "duplicate charge", "refund"],
      toolsUsed: [
        { tenantToolId: tenantOrderLookup.id, toolName: "Order Lookup", success: true },
        { tenantToolId: tenantProcessRefund.id, toolName: "Process Refund", success: true },
      ],
      resolutionOutcome: "resolved",
      customerEffort: 2,
      aiConfidence: 0.91,
    },
  });

  // ─── Agent Scores (for closed conversation) ─────────────────
  await prisma.agentScore.upsert({
    where: { conversationId_agentId: { conversationId: conv6.id, agentId: agents[0].id } },
    update: {},
    create: {
      tenantId: tenant.id,
      conversationId: conv6.id,
      agentId: agents[0].id,
      responseQuality: 5,
      responseSpeed: 4,
      resolutionScore: 5,
      protocolAdherence: 5,
      customerHandling: 5,
      overallScore: 93,
      strengths: ["Excellent product knowledge", "Proactive demo scheduling", "Professional tone"],
      improvements: ["Could mention specific SLA guarantees"],
      summary: "Outstanding handling of enterprise inquiry. Agent demonstrated deep product knowledge and moved efficiently toward scheduling a demo.",
      copilotUsageRate: 0.6,
      toolsUsedCount: 1,
      messageCount: 6,
    },
  });

  // ─── Tool Executions (sample audit log) ─────────────────────
  await prisma.toolExecution.create({
    data: {
      tenantId: tenant.id,
      conversationId: conv4.id,
      tenantToolId: tenantOrderLookup.id,
      input: { email: "billing@acmecorp.com" },
      output: { orderId: "ORD-2024-0891", amount: 149, status: "paid", duplicate: true },
      success: true,
      durationMs: 230,
      triggeredBy: "agent",
      createdAt: ago(52),
    },
  });

  await prisma.toolExecution.create({
    data: {
      tenantId: tenant.id,
      conversationId: conv4.id,
      tenantToolId: tenantProcessRefund.id,
      input: { orderId: "ORD-2024-0891", amount: 149, reason: "duplicate charge" },
      output: { refundId: "REF-2024-0445", status: "processing", estimatedDays: 5 },
      success: true,
      durationMs: 450,
      triggeredBy: "agent",
      createdAt: ago(48),
    },
  });

  await prisma.toolExecution.create({
    data: {
      tenantId: tenant.id,
      conversationId: conv6.id,
      tenantToolId: tenantCrmLookup.id,
      input: { email: "amit@goldberg-tech.com" },
      output: { contactId: "HS-12345", company: "Goldberg Tech", lifecycle: "lead", dealStage: "qualified" },
      success: true,
      durationMs: 180,
      triggeredBy: "ai",
      createdAt: ago(110),
    },
  });

  // ─── Knowledge Base ─────────────────────────────────────────
  const kb = await prisma.knowledgeBase.create({
    data: {
      tenantId: tenant.id,
      name: "Product FAQ",
      description: "Frequently asked questions and product documentation",
      isActive: true,
    },
  });

  const kbDoc = await prisma.knowledgeDocument.create({
    data: {
      knowledgeBaseId: kb.id,
      tenantId: tenant.id,
      title: "Pricing & Plans",
      content: "We offer 3 plans:\n\n**Starter** - $49/mo: Up to 5 agents, WhatsApp + Messenger, basic analytics\n**Pro** - $149/mo: Up to 20 agents, all channels, AI copilot, advanced analytics, knowledge base\n**Enterprise** - Custom pricing: Unlimited agents, dedicated support, API access, custom integrations, SLA guarantees\n\nAll plans include a 14-day free trial. Annual billing saves 20%.",
      sourceType: "text",
      status: "indexed",
      chunkCount: 1,
    },
  });

  await prisma.knowledgeChunk.create({
    data: {
      documentId: kbDoc.id,
      tenantId: tenant.id,
      content: kbDoc.content,
      chunkIndex: 0,
    },
  });

  const kbDoc2 = await prisma.knowledgeDocument.create({
    data: {
      knowledgeBaseId: kb.id,
      tenantId: tenant.id,
      title: "Refund Policy",
      content: "We offer a 30-day money-back guarantee on all plans. Refunds are processed within 3-5 business days. For annual plans, pro-rated refunds are available within the first 90 days. Contact billing@demo.com for refund requests.",
      sourceType: "text",
      status: "indexed",
      chunkCount: 1,
    },
  });

  await prisma.knowledgeChunk.create({
    data: {
      documentId: kbDoc2.id,
      tenantId: tenant.id,
      content: kbDoc2.content,
      chunkIndex: 0,
    },
  });

  console.log("Knowledge base: 2 documents indexed");

  // ─── Chatbot Flow ───────────────────────────────────────────
  await prisma.chatbotFlow.create({
    data: {
      tenantId: tenant.id,
      name: "Welcome Flow",
      description: "Greets customers and routes to appropriate department",
      isActive: true,
      channel: null,
      nodes: [
        { id: "start-1", type: "start", data: {} },
        { id: "msg-welcome", type: "message", data: { text: "Welcome! 👋 How can we help you today?" } },
        { id: "qr-department", type: "quick_reply", data: { text: "Please select a topic:", buttons: [{ id: "sales", title: "Sales & Pricing" }, { id: "support", title: "Technical Support" }, { id: "billing", title: "Billing" }] } },
        { id: "msg-sales", type: "message", data: { text: "Great! Connecting you with our sales team..." } },
        { id: "msg-support", type: "message", data: { text: "Connecting you with technical support..." } },
        { id: "msg-billing", type: "message", data: { text: "Connecting you with our billing team..." } },
        { id: "handover-1", type: "handover", data: {} },
      ],
      edges: [
        { id: "e1", source: "start-1", target: "msg-welcome" },
        { id: "e2", source: "msg-welcome", target: "qr-department" },
        { id: "e3", source: "qr-department", target: "msg-sales", sourceHandle: "sales" },
        { id: "e4", source: "qr-department", target: "msg-support", sourceHandle: "support" },
        { id: "e5", source: "qr-department", target: "msg-billing", sourceHandle: "billing" },
        { id: "e6", source: "msg-sales", target: "handover-1" },
        { id: "e7", source: "msg-support", target: "handover-1" },
        { id: "e8", source: "msg-billing", target: "handover-1" },
      ],
    },
  });
  console.log("Chatbot flow: Welcome Flow");

  // ─── Action Contracts (deterministic tool chains) ──────────
  // Seeds the demo tenant with the spec's three canonical examples so the
  // bot enforces them out of the box.
  const ACTION_CONTRACTS = [
    {
      // Booking a meeting requires ONLY the booking tool. A CRM sync must never
      // be a BLOCKING prerequisite of booking - if the CRM write fails (e.g.
      // missing OAuth scopes), the bot would otherwise be unable to "complete"
      // the booking and would escalate to a human instead of just scheduling
      // the demo. CRM updates happen via the normal lead create/update flow.
      trigger: "booking",
      requiredTools: [{ name: "schedule_meeting" }],
      executionMode: "ALL_REQUIRED",
      order: null as string[] | null,
      blocking: true,
    },
    {
      trigger: "refund",
      requiredTools: [{ name: "refund_payment" }, { name: "create_ticket" }],
      executionMode: "SEQUENCE",
      order: ["refund_payment", "create_ticket"],
      blocking: true,
    },
    {
      trigger: "close_conversation",
      requiredTools: [{ name: "close_conversation" }],
      executionMode: "ALL_REQUIRED",
      order: null as string[] | null,
      blocking: false,
    },
  ];
  for (const c of ACTION_CONTRACTS) {
    await (prisma as any).actionContract.upsert({
      where: { tenantId_trigger: { tenantId: tenant.id, trigger: c.trigger } },
      update: {
        requiredTools: c.requiredTools,
        executionMode: c.executionMode,
        order: c.order ?? undefined,
        blocking: c.blocking,
        isActive: true,
      },
      create: {
        tenantId: tenant.id,
        trigger: c.trigger,
        requiredTools: c.requiredTools,
        executionMode: c.executionMode,
        order: c.order ?? undefined,
        blocking: c.blocking,
        isActive: true,
      },
    });
  }
  console.log(`Action contracts: ${ACTION_CONTRACTS.map((c) => c.trigger).join(", ")}`);

  // ─── Industry Intelligence Packs (V2 - system, shared) ───────
  // Each pack `fields` entry is a scope-tagged template cloned into
  // per-tenant FieldDefinition rows when applied. scope/type are lowercase
  // here and normalized to the Prisma enums by the apply route.
  // See docs/customer-intelligence-domain-model.md §4.4.
  await seedIntelligencePacks(prisma);

  // ─── Done ───────────────────────────────────────────────────
  console.log("\n✅ Seed complete!\n");
  console.log("Login credentials:");
  console.log("  System Admin : system@demo.com / admin123");
  console.log("  Admin        : admin@demo.com / admin123");
  console.log("  Agent (Sales): dana@demo.com / agent123");
  console.log("  Agent (Sales): yossi@demo.com / agent123");
  console.log("  Agent (Supp) : maya@demo.com / agent123");
  console.log("  Agent (Bill) : eli@demo.com / agent123");
  console.log("  Tenant slug  : demo-company");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
