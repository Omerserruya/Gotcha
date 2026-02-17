import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant } from "@chatcenter/shared";
import * as aiService from "../services/ai-assist.service";

const router = Router();
router.use(authenticate, resolveTenant);

// Static routes BEFORE parameterized routes
router.get("/config", async (req: Request, res: Response) => {
  try {
    const config = await aiService.getTenantCopilotConfig(req.tenantId!);
    res.json({ data: config });
  } catch (err) { console.error("AI config error:", err); res.status(500).json({ error: "Failed to get config" }); }
});

router.get("/:conversationId/suggestions", async (req: Request, res: Response) => {
  try {
    const convId = req.params.conversationId as string;
    const conversation = await prisma.conversation.findFirst({ where: { id: convId, tenantId: req.tenantId! } });
    if (!conversation) { res.status(404).json({ error: "Conversation not found" }); return; }

    const messages = await prisma.message.findMany({
      where: { conversationId: convId, tenantId: req.tenantId! },
      orderBy: { createdAt: "desc" }, take: 20,
      select: { direction: true, body: true, senderName: true, createdAt: true },
    });

    const copilotConfig = await aiService.getTenantCopilotConfig(req.tenantId!);

    const context: aiService.ConversationContext = {
      tenantId: req.tenantId!, conversationId: conversation.id,
      customerName: conversation.customerName || undefined,
      messages: messages.reverse().map((m: any) => ({
        direction: m.direction, body: m.body, senderName: m.senderName || undefined, createdAt: m.createdAt.toISOString(),
      })),
      copilotConfig,
    };
    const suggestions = await aiService.getSuggestions(context);
    res.json({ data: suggestions });
  } catch (err) { console.error("AI suggestions error:", err); res.status(500).json({ error: "Failed to get suggestions" }); }
});

router.get("/:conversationId/summary", async (req: Request, res: Response) => {
  try {
    const convId = req.params.conversationId as string;
    const conversation = await prisma.conversation.findFirst({ where: { id: convId, tenantId: req.tenantId! } });
    if (!conversation) { res.status(404).json({ error: "Conversation not found" }); return; }

    const messages = await prisma.message.findMany({
      where: { conversationId: convId, tenantId: req.tenantId! },
      orderBy: { createdAt: "asc" },
      select: { direction: true, body: true, senderName: true, createdAt: true },
    });

    const copilotConfig = await aiService.getTenantCopilotConfig(req.tenantId!);

    const context: aiService.ConversationContext = {
      tenantId: req.tenantId!, conversationId: conversation.id,
      customerName: conversation.customerName || undefined,
      messages: messages.map((m: any) => ({
        direction: m.direction, body: m.body, senderName: m.senderName || undefined, createdAt: m.createdAt.toISOString(),
      })),
      copilotConfig,
    };
    const summary = await aiService.summarizeConversation(context);
    res.json({ data: { summary } });
  } catch (err) { console.error("AI summary error:", err); res.status(500).json({ error: "Failed to get summary" }); }
});

export default router;
