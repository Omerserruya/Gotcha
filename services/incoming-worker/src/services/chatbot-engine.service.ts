import { prisma } from "@chatcenter/shared";
import { sendWhatsAppMessage, sendQuickReply } from "./whatsapp.service";

interface FlowNode {
  id: string;
  type: "start" | "message" | "quick_reply" | "condition" | "handover" | "end";
  data: {
    text?: string;
    buttons?: Array<{ id: string; title: string }>;
    variable?: string;
    conditions?: Array<{ value: string; targetNodeId: string }>;
    defaultTargetNodeId?: string;
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

export async function processChatbotFlow(tenantId: string, conversationId: string, incomingMessage: string): Promise<boolean> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    include: { chatbotFlow: true },
  });

  if (!conversation || conversation.isHandedOver || conversation.assignedAgentId) return false;

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant?.waPhoneNumberId || !tenant?.waAccessToken) return false;

  let flow = conversation.chatbotFlow;
  if (!flow) {
    flow = await prisma.chatbotFlow.findFirst({ where: { tenantId, isActive: true } });
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

  return await executeFromNode(currentNodeId, definition, tenantId, conversationId, conversation.customerPhone, tenant.waPhoneNumberId, tenant.waAccessToken);
}

async function executeFromNode(nodeId: string, flow: FlowDefinition, tenantId: string, conversationId: string, customerPhone: string, phoneNumberId: string, accessToken: string): Promise<boolean> {
  let currentId: string | null = nodeId;
  const maxSteps = 20;
  let steps = 0;

  while (currentId && steps < maxSteps) {
    steps++;
    const node = flow.nodes.find((n) => n.id === currentId);
    if (!node) break;

    switch (node.type) {
      case "message": {
        if (node.data.text) {
          const waId = await sendWhatsAppMessage(phoneNumberId, accessToken, customerPhone, node.data.text);
          await prisma.message.create({
            data: { tenantId, conversationId, direction: "OUTBOUND", body: node.data.text, senderName: "Chatbot", waMessageId: waId, status: waId ? "SENT" : "FAILED" },
          });
        }
        const edge = flow.edges.find((e) => e.source === currentId);
        currentId = edge?.target || null;
        break;
      }
      case "quick_reply": {
        if (node.data.text && node.data.buttons) {
          const waId = await sendQuickReply(phoneNumberId, accessToken, customerPhone, node.data.text, node.data.buttons);
          await prisma.message.create({
            data: { tenantId, conversationId, direction: "OUTBOUND", body: node.data.text, messageType: "interactive", senderName: "Chatbot", waMessageId: waId, status: waId ? "SENT" : "FAILED", metadata: { buttons: node.data.buttons } },
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
      case "handover": {
        await prisma.conversation.update({ where: { id: conversationId }, data: { isHandedOver: true, chatbotNodeId: null, status: "WAITING" } });
        return true;
      }
      case "end": {
        await prisma.conversation.update({ where: { id: conversationId }, data: { chatbotNodeId: null, status: "CLOSED", closedAt: new Date() } });
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
