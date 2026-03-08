import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  // Create tenant
  const tenant = await prisma.tenant.upsert({
    where: { slug: "gotcha" },
    update: {},
    create: {
      name: "Gotcha",
      slug: "gotcha",
    },
  });
  console.log(`Tenant: ${tenant.name} (${tenant.id})`);

  // Create channel accounts (one per platform)
  const waAccount = await prisma.channelAccount.upsert({
    where: { channel_externalId: { channel: "WHATSAPP", externalId: process.env.WHATSAPP_PHONE_NUMBER_ID || "demo-wa-id" } },
    update: {},
    create: {
      tenantId: tenant.id,
      channel: "WHATSAPP",
      externalId: process.env.WHATSAPP_PHONE_NUMBER_ID || "demo-wa-id",
      displayName: "Gotcha WhatsApp",
      credentials: {
        accessToken: process.env.WHATSAPP_ACCESS_TOKEN || "demo-token",
        webhookSecret: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "demo-secret",
      },
    },
  });

  const msgAccount = await prisma.channelAccount.upsert({
    where: { channel_externalId: { channel: "MESSENGER", externalId: process.env.MESSENGER_PAGE_ID || "demo-msn-id" } },
    update: {},
    create: {
      tenantId: tenant.id,
      channel: "MESSENGER",
      externalId: process.env.MESSENGER_PAGE_ID || "demo-msn-id",
      displayName: "Gotcha Messenger",
      credentials: {
        accessToken: process.env.MESSENGER_ACCESS_TOKEN || "demo-messenger-token",
      },
    },
  });

  const insAccount = await prisma.channelAccount.upsert({
    where: { channel_externalId: { channel: "INSTAGRAM", externalId: "demo-ins-id" } },
    update: {},
    create: {
      tenantId: tenant.id,
      channel: "INSTAGRAM",
      externalId: "demo-ins-id",
      displayName: "Gotcha Instagram",
      credentials: { accessToken: "demo-instagram-token" },
    },
  });

  const gmailAccount = await prisma.channelAccount.upsert({
    where: { channel_externalId: { channel: "GMAIL", externalId: "demo-gmail-id" } },
    update: {},
    create: {
      tenantId: tenant.id,
      channel: "GMAIL",
      externalId: "demo-gmail-id",
      displayName: "Gotcha Gmail",
      credentials: { accessToken: "demo-gmail-token" },
    },
  });

  const outlookAccount = await prisma.channelAccount.upsert({
    where: { channel_externalId: { channel: "OUTLOOK", externalId: "demo-outlook-id" } },
    update: {},
    create: {
      tenantId: tenant.id,
      channel: "OUTLOOK",
      externalId: "demo-outlook-id",
      displayName: "Gotcha Outlook",
      credentials: { accessToken: "demo-outlook-token" },
    },
  });

  const slackAccount = await prisma.channelAccount.upsert({
    where: { channel_externalId: { channel: "SLACK", externalId: "demo-slack-id" } },
    update: {},
    create: {
      tenantId: tenant.id,
      channel: "SLACK",
      externalId: "demo-slack-id",
      displayName: "Gotcha Slack",
      credentials: { accessToken: "demo-slack-token" },
    },
  });

  console.log("Channel accounts created: WhatsApp, Messenger, Instagram, Gmail, Outlook, Slack");

  // Create tenant channel config
  await prisma.tenantChannelConfig.upsert({
    where: { tenantId: tenant.id },
    update: {},
    create: {
      tenantId: tenant.id,
      botFlowMode: "UNIFIED",
    },
  });

  // Create admin user
  const adminPassword = await bcrypt.hash("admin123", 10);
  const admin = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: "omer.serruya@gotcha.co.il" } },
    update: {},
    create: {
      tenantId: tenant.id,
      email: "omer.serruya@gotcha.co.il",
      password: adminPassword,
      name: "Omer Serruya",
      role: "ADMIN",
    },
  });
  console.log(`Admin: ${admin.email}`);

  // Create agent users
  const agentPassword = await bcrypt.hash("agent123", 10);
  const agent1 = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: "agent1@gotcha.co.il" } },
    update: {},
    create: {
      tenantId: tenant.id,
      email: "agent1@gotcha.co.il",
      password: agentPassword,
      name: "Agent One",
      role: "AGENT",
    },
  });

  const agent2 = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: "agent2@gotcha.co.il" } },
    update: {},
    create: {
      tenantId: tenant.id,
      email: "agent2@gotcha.co.il",
      password: agentPassword,
      name: "Agent Two",
      role: "AGENT",
    },
  });
  console.log(`Agents: ${agent1.email}, ${agent2.email}`);

  // Create departments
  const salesDept = await prisma.department.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: "Sales" } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: "Sales",
      description: "Sales and pre-sales inquiries",
      queueMode: "ROUND_ROBIN",
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
    },
  });

  // Assign agents to departments
  await prisma.departmentMember.upsert({
    where: { userId: agent1.id },
    update: {},
    create: {
      userId: agent1.id,
      tenantId: tenant.id,
      departmentId: salesDept.id,
      departmentRole: "MANAGER",
    },
  });

  await prisma.departmentMember.upsert({
    where: { userId: agent2.id },
    update: {},
    create: {
      userId: agent2.id,
      tenantId: tenant.id,
      departmentId: supportDept.id,
      departmentRole: "AGENT",
    },
  });

  // Create one conversation per channel with one inbound message each
  const channels = [
    { channel: "WHATSAPP" as const, accountId: waAccount.id, customerId: "+972501234567", customerName: "David Cohen", body: "Hi, I'm interested in your services" },
    { channel: "MESSENGER" as const, accountId: msgAccount.id, customerId: "psid_100001", customerName: "Sarah Levi", body: "Hey! Saw your page, do you offer demos?" },
    { channel: "INSTAGRAM" as const, accountId: insAccount.id, customerId: "igid_200001", customerName: "Noa Mizrahi", body: "Love your product! How can I get started?" },
    { channel: "GMAIL" as const, accountId: gmailAccount.id, customerId: "customer@example.com", customerName: "Yael Shapira", body: "Hello, I'd like to schedule a meeting" },
    { channel: "OUTLOOK" as const, accountId: outlookAccount.id, customerId: "contact@company.com", customerName: "Amit Goldberg", body: "Can you send me the pricing details?" },
    { channel: "SLACK" as const, accountId: slackAccount.id, customerId: "U0SLACK001", customerName: "Ron Peretz", body: "Quick question about the integration" },
  ];

  for (const ch of channels) {
    const conv = await prisma.conversation.create({
      data: {
        tenantId: tenant.id,
        channel: ch.channel,
        channelAccountId: ch.accountId,
        customerExternalId: ch.customerId,
        customerName: ch.customerName,
        status: "OPEN",
        lastMessageAt: new Date(),
      },
    });

    await prisma.message.create({
      data: {
        tenantId: tenant.id,
        conversationId: conv.id,
        channel: ch.channel,
        direction: "INBOUND",
        body: ch.body,
        senderName: ch.customerName,
        status: "DELIVERED",
      },
    });

    console.log(`Conversation [${ch.channel}]: ${ch.customerName}`);
  }

  // Create example chatbot flow
  await prisma.chatbotFlow.create({
    data: {
      tenantId: tenant.id,
      name: "Welcome Flow",
      description: "Greets customers and routes to appropriate department",
      isActive: true,
      channel: null,
      nodes: [
        { id: "start-1", type: "start", data: {} },
        { id: "msg-welcome", type: "message", data: { text: "Welcome to Gotcha! How can we help you today?" } },
        { id: "qr-department", type: "quick_reply", data: { text: "Please select a department:", buttons: [{ id: "sales", title: "Sales" }, { id: "support", title: "Support" }] } },
        { id: "msg-sales", type: "message", data: { text: "Connecting you with our sales team..." } },
        { id: "msg-support", type: "message", data: { text: "Connecting you with technical support..." } },
        { id: "handover-1", type: "handover", data: {} },
      ],
      edges: [
        { id: "e1", source: "start-1", target: "msg-welcome" },
        { id: "e2", source: "msg-welcome", target: "qr-department" },
        { id: "e3", source: "qr-department", target: "msg-sales", sourceHandle: "sales" },
        { id: "e4", source: "qr-department", target: "msg-support", sourceHandle: "support" },
        { id: "e5", source: "msg-sales", target: "handover-1" },
        { id: "e6", source: "msg-support", target: "handover-1" },
      ],
    },
  });

  console.log("\nSeed complete!");
  console.log("\nLogin credentials:");
  console.log("  Admin: omer.serruya@gotcha.co.il / admin123");
  console.log("  Agent: agent1@gotcha.co.il / agent123");
  console.log("  Agent: agent2@gotcha.co.il / agent123");
  console.log("  Tenant slug: gotcha");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
