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
      waPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "demo-phone-id",
      waAccessToken: process.env.WHATSAPP_ACCESS_TOKEN || "demo-token",
      waWebhookSecret: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "demo-secret",
    },
  });
  console.log(`Tenant: ${tenant.name} (${tenant.id})`);

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

  // Create sample conversations
  const conv1 = await prisma.conversation.create({
    data: {
      tenantId: tenant.id,
      customerPhone: "+1234567890",
      customerName: "John Doe",
      status: "OPEN",
      lastMessageAt: new Date(),
    },
  });

  const conv2 = await prisma.conversation.create({
    data: {
      tenantId: tenant.id,
      customerPhone: "+0987654321",
      customerName: "Jane Smith",
      assignedAgentId: agent1.id,
      status: "OPEN",
      isHandedOver: true,
      lastMessageAt: new Date(),
    },
  });

  const conv3 = await prisma.conversation.create({
    data: {
      tenantId: tenant.id,
      customerPhone: "+1122334455",
      customerName: "Bob Wilson",
      status: "WAITING",
      lastMessageAt: new Date(Date.now() - 3600000),
    },
  });

  // Create sample messages
  await prisma.message.createMany({
    data: [
      {
        tenantId: tenant.id,
        conversationId: conv1.id,
        direction: "INBOUND",
        body: "Hi, I need help with my order #12345",
        senderName: "John Doe",
        status: "DELIVERED",
      },
      {
        tenantId: tenant.id,
        conversationId: conv1.id,
        direction: "INBOUND",
        body: "It's been 3 days and I haven't received it",
        senderName: "John Doe",
        status: "DELIVERED",
      },
      {
        tenantId: tenant.id,
        conversationId: conv2.id,
        direction: "INBOUND",
        body: "Hello, I'd like to return an item",
        senderName: "Jane Smith",
        status: "DELIVERED",
      },
      {
        tenantId: tenant.id,
        conversationId: conv2.id,
        direction: "OUTBOUND",
        body: "Hi Jane! I'd be happy to help you with the return. Could you provide the order number?",
        senderName: "Sarah Johnson",
        status: "READ",
      },
      {
        tenantId: tenant.id,
        conversationId: conv2.id,
        direction: "INBOUND",
        body: "Sure, it's order #67890",
        senderName: "Jane Smith",
        status: "DELIVERED",
      },
      {
        tenantId: tenant.id,
        conversationId: conv3.id,
        direction: "INBOUND",
        body: "Is anyone available? I have a billing question.",
        senderName: "Bob Wilson",
        status: "DELIVERED",
      },
    ],
  });
  console.log(`Conversations: ${conv1.id}, ${conv2.id}, ${conv3.id}`);

  // Create example chatbot flow
  const chatbotFlow = await prisma.chatbotFlow.create({
    data: {
      tenantId: tenant.id,
      name: "Welcome Flow",
      description: "Greets customers and routes to appropriate department",
      isActive: true,
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
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
