import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma, authenticate, resolveTenant, requireRole, validate } from "@chatcenter/shared";

const router = Router();
router.use(authenticate, resolveTenant);

const flowSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  channel: z.enum(["WHATSAPP", "MESSENGER"]).nullable().optional(),
  nodes: z.array(z.any()).default([]),
  edges: z.array(z.any()).default([]),
  isActive: z.boolean().optional(),
});

router.get("/", async (req: Request, res: Response) => {
  try {
    const where: any = { tenantId: req.tenantId! };
    const channelParam = req.query.channel as string | undefined;
    if (channelParam === "null" || channelParam === "universal") {
      where.channel = null;
    } else if (channelParam) {
      where.channel = channelParam;
    }
    const flows = await prisma.chatbotFlow.findMany({ where, orderBy: { updatedAt: "desc" } });
    res.json(flows);
  } catch (err) { console.error("List flows error:", err); res.status(500).json({ error: "Failed to list flows" }); }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const flow = await prisma.chatbotFlow.findFirst({ where: { id: req.params.id as string, tenantId: req.tenantId! } });
    if (!flow) { res.status(404).json({ error: "Flow not found" }); return; }
    res.json(flow);
  } catch (err) { console.error("Get flow error:", err); res.status(500).json({ error: "Failed to get flow" }); }
});

router.post("/", requireRole("ADMIN"), validate(flowSchema), async (req: Request, res: Response) => {
  try {
    const { name, description, channel, nodes, edges, isActive } = req.body;
    const flow = await prisma.chatbotFlow.create({
      data: { tenantId: req.tenantId!, name, description, channel: channel ?? null, nodes, edges, isActive: isActive || false },
    });
    res.status(201).json(flow);
  } catch (err) { console.error("Create flow error:", err); res.status(500).json({ error: "Failed to create flow" }); }
});

router.put("/:id", requireRole("ADMIN"), validate(flowSchema), async (req: Request, res: Response) => {
  try {
    const existing = await prisma.chatbotFlow.findFirst({ where: { id: req.params.id as string, tenantId: req.tenantId! } });
    if (!existing) { res.status(404).json({ error: "Flow not found" }); return; }
    const { name, description, nodes, edges, isActive } = req.body;
    const flow = await prisma.chatbotFlow.update({
      where: { id: req.params.id as string },
      data: { name, description, nodes, edges, isActive: isActive ?? existing.isActive },
    });
    res.json(flow);
  } catch (err) { console.error("Update flow error:", err); res.status(500).json({ error: "Failed to update flow" }); }
});

router.delete("/:id", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const existing = await prisma.chatbotFlow.findFirst({ where: { id: req.params.id as string, tenantId: req.tenantId! } });
    if (!existing) { res.status(404).json({ error: "Flow not found" }); return; }
    await prisma.chatbotFlow.delete({ where: { id: req.params.id as string } });
    res.json({ success: true });
  } catch (err) { console.error("Delete flow error:", err); res.status(500).json({ error: "Failed to delete flow" }); }
});

router.post("/:id/activate", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const existing = await prisma.chatbotFlow.findFirst({ where: { id: req.params.id as string, tenantId: req.tenantId! } });
    if (!existing) { res.status(404).json({ error: "Flow not found" }); return; }
    const flow = await prisma.chatbotFlow.update({ where: { id: req.params.id as string }, data: { isActive: true } });
    res.json(flow);
  } catch (err) { console.error("Activate flow error:", err); res.status(500).json({ error: "Failed to activate flow" }); }
});

export default router;
