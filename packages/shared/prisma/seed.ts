import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  // Create demo tenant
  const tenant = await prisma.tenant.upsert({
    where: { slug: "demo-company" },
    update: {},
    create: {
      name: "Demo Company",
      slug: "demo-company",
    },
  });
  console.log(`Tenant: ${tenant.name} (${tenant.id})`);

  // Create channel accounts
  const waAccount = await prisma.channelAccount.upsert({
    where: { channel_externalId: { channel: "WHATSAPP", externalId: process.env.WHATSAPP_PHONE_NUMBER_ID || "demo-phone-id" } },
    update: {},
    create: {
      tenantId: tenant.id,
      channel: "WHATSAPP",
      externalId: process.env.WHATSAPP_PHONE_NUMBER_ID || "demo-phone-id",
      displayName: "Demo Company WhatsApp",
      credentials: {
        accessToken: process.env.WHATSAPP_ACCESS_TOKEN || "demo-token",
        webhookSecret: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "demo-secret",
      },
    },
  });
  console.log(`WhatsApp channel: ${waAccount.displayName} (${waAccount.id})`);

  const msgAccount = await prisma.channelAccount.upsert({
    where: { channel_externalId: { channel: "MESSENGER", externalId: process.env.MESSENGER_PAGE_ID || "demo-page-id" } },
    update: {},
    create: {
      tenantId: tenant.id,
      channel: "MESSENGER",
      externalId: process.env.MESSENGER_PAGE_ID || "demo-page-id",
      displayName: "Demo Company Messenger",
      credentials: {
        accessToken: process.env.MESSENGER_ACCESS_TOKEN || "demo-messenger-token",
      },
    },
  });
  console.log(`Messenger channel: ${msgAccount.displayName} (${msgAccount.id})`);

  // Create tenant channel config
  await prisma.tenantChannelConfig.upsert({
    where: { tenantId: tenant.id },
    update: {},
    create: {
      tenantId: tenant.id,
      botFlowMode: "UNIFIED",
    },
  });
  console.log("Tenant channel config: UNIFIED mode");

  // Create admin user
  const adminPassword = await bcrypt.hash("admin123", 10);
  const admin = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: "admin@demo.com" } },
    update: {},
    create: {
      tenantId: tenant.id,
      email: "admin@demo.com",
      password: adminPassword,
      name: "Admin User",
      role: "ADMIN",
    },
  });
  console.log(`Admin: ${admin.email}`);

  // Create agent users
  const agentPassword = await bcrypt.hash("agent123", 10);
  const agent1 = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: "agent1@demo.com" } },
    update: {},
    create: {
      tenantId: tenant.id,
      email: "agent1@demo.com",
      password: agentPassword,
      name: "Sarah Johnson",
      role: "AGENT",
    },
  });

  const agent2 = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: "agent2@demo.com" } },
    update: {},
    create: {
      tenantId: tenant.id,
      email: "agent2@demo.com",
      password: agentPassword,
      name: "Mike Chen",
      role: "AGENT",
    },
  });
  console.log(`Agents: ${agent1.name}, ${agent2.name}`);

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
  console.log(`Departments: ${salesDept.name}, ${supportDept.name}`);

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
  console.log(`Department members: ${agent1.name} -> Sales (Manager), ${agent2.name} -> Support (Agent)`);

  // Create sample conversations (WhatsApp)
  const conv1 = await prisma.conversation.create({
    data: {
      tenantId: tenant.id,
      channel: "WHATSAPP",
      channelAccountId: waAccount.id,
      customerExternalId: "+1234567890",
      customerName: "John Doe",
      status: "OPEN",
      lastMessageAt: new Date(),
    },
  });

  const conv2 = await prisma.conversation.create({
    data: {
      tenantId: tenant.id,
      channel: "WHATSAPP",
      channelAccountId: waAccount.id,
      customerExternalId: "+0987654321",
      customerName: "Jane Smith",
      assignedAgentId: agent1.id,
      status: "OPEN",
      isHandedOver: true,
      lastMessageAt: new Date(),
    },
  });

  // Create sample conversation (Messenger)
  const conv3 = await prisma.conversation.create({
    data: {
      tenantId: tenant.id,
      channel: "MESSENGER",
      channelAccountId: msgAccount.id,
      customerExternalId: "psid_1234567890",
      customerName: "Bob Wilson",
      status: "WAITING",
      lastMessageAt: new Date(Date.now() - 3600000),
    },
  });

  // Another Messenger conversation
  const conv4 = await prisma.conversation.create({
    data: {
      tenantId: tenant.id,
      channel: "MESSENGER",
      channelAccountId: msgAccount.id,
      customerExternalId: "psid_0987654321",
      customerName: "Alice Brown",
      status: "OPEN",
      lastMessageAt: new Date(Date.now() - 1800000),
    },
  });

  // Create sample messages
  await prisma.message.createMany({
    data: [
      // WhatsApp conversations
      {
        tenantId: tenant.id,
        conversationId: conv1.id,
        channel: "WHATSAPP",
        direction: "INBOUND",
        body: "Hi, I need help with my order #12345",
        senderName: "John Doe",
        status: "DELIVERED",
      },
      {
        tenantId: tenant.id,
        conversationId: conv1.id,
        channel: "WHATSAPP",
        direction: "INBOUND",
        body: "It's been 3 days and I haven't received it",
        senderName: "John Doe",
        status: "DELIVERED",
      },
      {
        tenantId: tenant.id,
        conversationId: conv2.id,
        channel: "WHATSAPP",
        direction: "INBOUND",
        body: "Hello, I'd like to return an item",
        senderName: "Jane Smith",
        status: "DELIVERED",
      },
      {
        tenantId: tenant.id,
        conversationId: conv2.id,
        channel: "WHATSAPP",
        direction: "OUTBOUND",
        body: "Hi Jane! I'd be happy to help you with the return. Could you provide the order number?",
        senderName: "Sarah Johnson",
        status: "READ",
      },
      {
        tenantId: tenant.id,
        conversationId: conv2.id,
        channel: "WHATSAPP",
        direction: "INBOUND",
        body: "Sure, it's order #67890",
        senderName: "Jane Smith",
        status: "DELIVERED",
      },
      // Messenger conversations
      {
        tenantId: tenant.id,
        conversationId: conv3.id,
        channel: "MESSENGER",
        direction: "INBOUND",
        body: "Is anyone available? I have a billing question.",
        senderName: "Bob Wilson",
        status: "DELIVERED",
      },
      {
        tenantId: tenant.id,
        conversationId: conv4.id,
        channel: "MESSENGER",
        direction: "INBOUND",
        body: "Hey! I saw your ad on Facebook. Do you ship internationally?",
        senderName: "Alice Brown",
        status: "DELIVERED",
      },
      {
        tenantId: tenant.id,
        conversationId: conv4.id,
        channel: "MESSENGER",
        direction: "INBOUND",
        body: "Also, what's the return policy?",
        senderName: "Alice Brown",
        status: "DELIVERED",
      },
    ],
  });
  console.log(`Conversations: ${conv1.id}, ${conv2.id}, ${conv3.id}, ${conv4.id}`);

  // Create example chatbot flow (universal - works for all channels)
  const chatbotFlow = await prisma.chatbotFlow.create({
    data: {
      tenantId: tenant.id,
      name: "Welcome Flow",
      description: "Greets customers and routes to appropriate department",
      isActive: true,
      channel: null, // null = ALL channels (universal flow)
      nodes: [
        {
          id: "start-1",
          type: "start",
          data: {},
        },
        {
          id: "msg-welcome",
          type: "message",
          data: { text: "Welcome to Demo Company! How can we help you today?" },
        },
        {
          id: "qr-department",
          type: "quick_reply",
          data: {
            text: "Please select a department:",
            buttons: [
              { id: "sales", title: "Sales" },
              { id: "support", title: "Support" },
              { id: "billing", title: "Billing" },
            ],
          },
        },
        {
          id: "msg-sales",
          type: "message",
          data: { text: "Connecting you with our sales team..." },
        },
        {
          id: "msg-support",
          type: "message",
          data: { text: "Connecting you with technical support..." },
        },
        {
          id: "msg-billing",
          type: "message",
          data: { text: "Connecting you with our billing department..." },
        },
        {
          id: "handover-1",
          type: "handover",
          data: {},
        },
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
  console.log(`Chatbot flow: ${chatbotFlow.name} (${chatbotFlow.id})`);

  console.log("\nSeed complete!");
  console.log("\nLogin credentials:");
  console.log("  Admin: admin@demo.com / admin123");
  console.log("  Agent: agent1@demo.com / agent123");
  console.log("  Agent: agent2@demo.com / agent123");
  console.log("  Tenant slug: demo-company");
  console.log("\nChannels:");
  console.log(`  WhatsApp: ${waAccount.displayName} (${waAccount.externalId})`);
  console.log(`  Messenger: ${msgAccount.displayName} (${msgAccount.externalId})`);
  console.log("\nDepartments:");
  console.log(`  ${salesDept.name}: ${agent1.name} (Manager)`);
  console.log(`  ${supportDept.name}: ${agent2.name} (Agent)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
