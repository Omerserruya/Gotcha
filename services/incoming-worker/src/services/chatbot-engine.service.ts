import { prisma, getOutboundAdapter, getRedis, decryptCredentials } from "@chatcenter/shared";
import type { ChannelCredentials } from "@chatcenter/shared";

interface FlowNode {
  id: string;
  type: "start" | "message" | "quick_reply" | "condition" | "handover" | "department_route" | "end";
  data: {
    text?: string;
    buttons?: Array<{ id: string; title: string }>;
    variable?: string;
    conditions?: Array<{ value: string; targetNodeId: string }>;
    defaultTargetNodeId?: string;
    departmentId?: string;
  };
}

interface FlowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
}

interface FlowDefinition {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

interface ChannelSendContext {
  channel: "WHATSAPP" | "MESSENGER";
  channelAccountExternalId: string;
  credentials: ChannelCredentials;
  recipientId: string;
}

export async function processChatbotFlow(tenantId: string, conversationId: string, incomingMessage: string): Promise<boolean> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    include: { chatbotFlow: true, channelAccount: true },
  });

  if (!conversation || conversation.isHandedOver || conversation.assignedAgentId) return false;

  // Build send context from channel account or legacy tenant config
  const sendContext = await buildSendContext(conversation, tenantId);
  if (!sendContext) return false;

  // Select the appropriate chatbot flow based on tenant's bot flow mode
  let flow = conversation.chatbotFlow;
  if (!flow) {
    flow = await selectBotFlow(tenantId, conversation.channel as "WHATSAPP" | "MESSENGER");
    if (!flow) return false;
    await prisma.conversation.update({ where: { id: conversationId }, data: { chatbotFlowId: flow.id } });
  }

  const definition: FlowDefinition = {
    nodes: flow.nodes as unknown as FlowNode[],
    edges: flow.edges as unknown as FlowEdge[],
  };

  let currentNodeId = conversation.chatbotNodeId;
  if (!currentNodeId) {
    const startNode = definition.nodes.find((n) => n.type === "start");
    if (!startNode) return false;
    const startEdge = definition.edges.find((e) => e.source === startNode.id);
    if (!startEdge) return false;
    currentNodeId = startEdge.target;
  } else {
    const currentNode = definition.nodes.find((n) => n.id === currentNodeId);
    if (!currentNode) return false;
    if (currentNode.type === "quick_reply" || currentNode.type === "condition") {
      const nextNodeId = resolveCondition(currentNode, incomingMessage, definition.edges);
      if (!nextNodeId) return false;
      currentNodeId = nextNodeId;
    } else {
      const edge = definition.edges.find((e) => e.source === currentNodeId);
      if (!edge) return false;
      currentNodeId = edge.target;
    }
  }

  return await executeFromNode(currentNodeId, definition, tenantId, conversationId, sendContext);
}

async function buildSendContext(conversation: any, tenantId: string): Promise<ChannelSendContext | null> {
  if (!conversation.channelAccount) return null;

  const rawCreds = conversation.channelAccount.credentials;
  const creds = typeof rawCreds === "string" ? decryptCredentials(rawCreds) : (rawCreds as any);
  return {
    channel: conversation.channel,
    channelAccountExternalId: conversation.channelAccount.externalId,
    credentials: { accessToken: creds.accessToken, appSecret: creds.appSecret },
    recipientId: conversation.customerExternalId,
  };
}

async function selectBotFlow(tenantId: string, channel: "WHATSAPP" | "MESSENGER") {
  // Check tenant's bot flow mode
  const config = await prisma.tenantChannelConfig.findUnique({ where: { tenantId } });
  const mode = config?.botFlowMode || "UNIFIED";

  if (mode === "PER_CHANNEL") {
    // Try channel-specific flow first
    const channelFlow = await prisma.chatbotFlow.findFirst({
      where: { tenantId, channel, isActive: true },
    });
    if (channelFlow) return channelFlow;
  }

  // Fall back to universal flow (channel = null means ALL)
  return prisma.chatbotFlow.findFirst({
    where: { tenantId, channel: null, isActive: true },
  });
}

async function executeFromNode(
  nodeId: string,
  flow: FlowDefinition,
  tenantId: string,
  conversationId: string,
  sendCtx: ChannelSendContext
): Promise<boolean> {
  let currentId: string | null = nodeId;
  const maxSteps = 20;
  let steps = 0;

  const adapter = getOutboundAdapter(sendCtx.channel);
  if (!adapter) {
    console.error(`No outbound adapter found for channel: ${sendCtx.channel}`);
    return false;
  }

  while (currentId && steps < maxSteps) {
    steps++;
    const node = flow.nodes.find((n) => n.id === currentId);
    if (!node) break;

    switch (node.type) {
      case "message": {
        if (node.data.text) {
          const extId = await adapter.sendTextMessage(
            sendCtx.credentials,
            sendCtx.channelAccountExternalId,
            sendCtx.recipientId,
            node.data.text
          );
          await prisma.message.create({
            data: {
              tenantId,
              conversationId,
              channel: sendCtx.channel,
              direction: "OUTBOUND",
              body: node.data.text,
              senderName: "Chatbot",
              externalMessageId: extId,

              status: extId ? "SENT" : "FAILED",
            },
          });
        }
        const edge = flow.edges.find((e) => e.source === currentId);
        currentId = edge?.target || null;
        break;
      }
      case "quick_reply": {
        if (node.data.text && node.data.buttons) {
          const extId = await adapter.sendInteractiveMessage(
            sendCtx.credentials,
            sendCtx.channelAccountExternalId,
            sendCtx.recipientId,
            node.data.text,
            node.data.buttons
          );
          await prisma.message.create({
            data: {
              tenantId,
              conversationId,
              channel: sendCtx.channel,
              direction: "OUTBOUND",
              body: node.data.text,
              messageType: "interactive",
              senderName: "Chatbot",
              externalMessageId: extId,

              status: extId ? "SENT" : "FAILED",
              metadata: { buttons: node.data.buttons },
            },
          });
        }
        await prisma.conversation.update({ where: { id: conversationId }, data: { chatbotNodeId: currentId } });
        return true;
      }
      case "condition": {
        const edge = flow.edges.find((e) => e.source === currentId);
        currentId = edge?.target || null;
        break;
      }
      case "department_route": {
        const deptId = node.data.departmentId;
        if (!deptId) {
          // No department configured, fall through to next node
          const edge = flow.edges.find((e) => e.source === currentId);
          currentId = edge?.target || null;
          break;
        }

        // Check business hours before department routing
        const deptHours = await isBusinessClosed(tenantId);
        if (deptHours.closed && deptHours.autoResponse) {
          const closedExtId = await adapter.sendTextMessage(
            sendCtx.credentials,
            sendCtx.channelAccountExternalId,
            sendCtx.recipientId,
            deptHours.autoResponse
          );
          await prisma.message.create({
            data: {
              tenantId,
              conversationId,
              channel: sendCtx.channel,
              direction: "OUTBOUND",
              body: deptHours.autoResponse,
              senderName: "Chatbot",
              externalMessageId: closedExtId,

              status: closedExtId ? "SENT" : "FAILED",
            },
          });
        }

        const dept = await prisma.department.findFirst({
          where: { id: deptId, isActive: true },
          include: { members: { include: { user: { select: { id: true, isActive: true, _count: { select: { conversations: { where: { status: { not: "CLOSED" } } } } } } } } } },
        });

        let assignedAgentId: string | null = null;
        if (dept && dept.queueMode === "ROUND_ROBIN") {
          const activeMembers = dept.members.filter((m) => m.user.isActive);
          if (activeMembers.length > 0) {
            activeMembers.sort((a, b) => a.user._count.conversations - b.user._count.conversations);
            assignedAgentId = activeMembers[0].userId;
          }
        }

        await prisma.conversation.update({
          where: { id: conversationId },
          data: {
            departmentId: deptId,
            assignedAgentId,
            isHandedOver: true,
            chatbotNodeId: null,
            status: assignedAgentId ? "OPEN" : "WAITING",
          },
        });

        await prisma.message.create({
          data: {
            tenantId,
            conversationId,
            channel: sendCtx.channel,
            direction: "INBOUND",
            body: "",
            messageType: "system",
            senderName: "System",
            status: "DELIVERED",
            metadata: {
              systemEvent: "department_route",
              departmentName: dept?.name || "Unknown",
              ...(assignedAgentId ? { agentId: assignedAgentId } : {}),
            },
          },
        });
        return true;
      }
      case "handover": {
        // Check business hours before handover
        const handoverHours = await isBusinessClosed(tenantId);
        if (handoverHours.closed && handoverHours.autoResponse) {
          const closedExtId = await adapter.sendTextMessage(
            sendCtx.credentials,
            sendCtx.channelAccountExternalId,
            sendCtx.recipientId,
            handoverHours.autoResponse
          );
          await prisma.message.create({
            data: {
              tenantId,
              conversationId,
              channel: sendCtx.channel,
              direction: "OUTBOUND",
              body: handoverHours.autoResponse,
              senderName: "Chatbot",
              externalMessageId: closedExtId,

              status: closedExtId ? "SENT" : "FAILED",
            },
          });
        }

        await prisma.conversation.update({
          where: { id: conversationId },
          data: { isHandedOver: true, chatbotNodeId: null, status: "WAITING" },
        });
        await prisma.message.create({
          data: {
            tenantId,
            conversationId,
            channel: sendCtx.channel,
            direction: "INBOUND",
            body: "",
            messageType: "system",
            senderName: "System",
            status: "DELIVERED",
            metadata: { systemEvent: "bot_handover" },
          },
        });
        return true;
      }
      case "end": {
        await prisma.conversation.update({
          where: { id: conversationId },
          data: { chatbotNodeId: null, status: "CLOSED", closedAt: new Date() },
        });
        return true;
      }
      default: {
        const defaultEdge = flow.edges.find((e) => e.source === currentId);
        currentId = defaultEdge?.target || null;
      }
    }
  }

  if (currentId) {
    await prisma.conversation.update({ where: { id: conversationId }, data: { chatbotNodeId: currentId } });
  }
  return true;
}

async function isBusinessClosed(tenantId: string): Promise<{ closed: boolean; autoResponse: string | null }> {
  try {
    const redis = getRedis();
    const raw = await redis.get(`tenant:${tenantId}:businessHours`);
    if (!raw) return { closed: false, autoResponse: null };

    const config = JSON.parse(raw);
    if (!config.enabled) return { closed: false, autoResponse: null };

    const tz = config.timezone || "Asia/Jerusalem";
    const now = new Date();
    // Get current time in the configured timezone
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const weekday = parts.find((p) => p.type === "weekday")!.value.toLowerCase();
    const hour = parts.find((p) => p.type === "hour")!.value;
    const minute = parts.find((p) => p.type === "minute")!.value;
    const currentTime = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;

    const daySchedule = config.schedule?.[weekday];
    if (!daySchedule || !daySchedule.enabled) {
      return { closed: true, autoResponse: config.autoResponse || null };
    }

    const isOpen = daySchedule.open && daySchedule.close &&
      currentTime >= daySchedule.open && currentTime < daySchedule.close;

    if (!isOpen) {
      return { closed: true, autoResponse: config.autoResponse || null };
    }

    return { closed: false, autoResponse: null };
  } catch (err) {
    console.error("isBusinessClosed error:", err);
    return { closed: false, autoResponse: null };
  }
}

function resolveCondition(node: FlowNode, userInput: string, edges: FlowEdge[]): string | null {
  const input = userInput.toLowerCase().trim();
  if (node.type === "quick_reply" && node.data.buttons) {
    const matched = node.data.buttons.find((b) => b.id === input || b.title.toLowerCase() === input);
    if (matched) {
      const edge = edges.find((e) => e.source === node.id && e.sourceHandle === matched.id);
      if (edge) return edge.target;
    }
  }
  if (node.data.conditions) {
    for (const cond of node.data.conditions) {
      if (input.includes(cond.value.toLowerCase())) return cond.targetNodeId;
    }
  }
  if (node.data.defaultTargetNodeId) return node.data.defaultTargetNodeId;
  const fallback = edges.find((e) => e.source === node.id);
  return fallback?.target || null;
}
