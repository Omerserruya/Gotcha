import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma, authenticate, resolveTenant, requireRole, requireDepartmentRole, validate } from "@chatcenter/shared";

const router = Router();
router.use(authenticate, resolveTenant);

// GET / - List departments (any authenticated user)
router.get("/", async (req: Request, res: Response) => {
  try {
    const departments = await prisma.department.findMany({
      where: { tenantId: req.tenantId! },
      include: {
        _count: { select: { members: true, conversations: { where: { status: { not: "CLOSED" } } } } },
      },
      orderBy: { name: "asc" },
    });
    res.json({ data: departments });
  } catch (err) {
    console.error("List departments error:", err);
    res.status(500).json({ error: "Failed to list departments" });
  }
});

// POST / - Create department (ADMIN only)
const createDepartmentSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  queueMode: z.enum(["CLAIM", "ROUND_ROBIN"]).optional(),
});

router.post("/", requireRole("ADMIN"), validate(createDepartmentSchema), async (req: Request, res: Response) => {
  try {
    const { name, description, queueMode } = req.body;
    const existing = await prisma.department.findUnique({
      where: { tenantId_name: { tenantId: req.tenantId!, name } },
    });
    if (existing) { res.status(409).json({ error: "Department with this name already exists" }); return; }

    const department = await prisma.department.create({
      data: { tenantId: req.tenantId!, name, description, queueMode: queueMode || "CLAIM" },
    });
    res.status(201).json({ data: department });
  } catch (err) {
    console.error("Create department error:", err);
    res.status(500).json({ error: "Failed to create department" });
  }
});

// PATCH /:id - Update department (ADMIN only)
const updateDepartmentSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  queueMode: z.enum(["CLAIM", "ROUND_ROBIN"]).optional(),
  isActive: z.boolean().optional(),
});

router.patch("/:id", requireRole("ADMIN"), validate(updateDepartmentSchema), async (req: Request, res: Response) => {
  try {
    const dept = await prisma.department.findFirst({ where: { id: req.params.id, tenantId: req.tenantId! } });
    if (!dept) { res.status(404).json({ error: "Department not found" }); return; }

    const updated = await prisma.department.update({
      where: { id: req.params.id },
      data: req.body,
    });
    res.json({ data: updated });
  } catch (err) {
    console.error("Update department error:", err);
    res.status(500).json({ error: "Failed to update department" });
  }
});

// DELETE /:id - Delete department (ADMIN only)
router.delete("/:id", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const dept = await prisma.department.findFirst({ where: { id: req.params.id, tenantId: req.tenantId! } });
    if (!dept) { res.status(404).json({ error: "Department not found" }); return; }

    await prisma.department.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    console.error("Delete department error:", err);
    res.status(500).json({ error: "Failed to delete department" });
  }
});

// GET /:id/members - List department members (ADMIN or MANAGER)
router.get("/:id/members", requireDepartmentRole("MANAGER"), async (req: Request, res: Response) => {
  try {
    const dept = await prisma.department.findFirst({ where: { id: req.params.id, tenantId: req.tenantId! } });
    if (!dept) { res.status(404).json({ error: "Department not found" }); return; }

    const members = await prisma.departmentMember.findMany({
      where: { departmentId: req.params.id },
      include: {
        user: {
          select: { id: true, name: true, email: true, isActive: true,
            _count: { select: { conversations: { where: { status: { not: "CLOSED" } } } } },
          },
        },
      },
    });
    res.json({ data: members });
  } catch (err) {
    console.error("List members error:", err);
    res.status(500).json({ error: "Failed to list members" });
  }
});

// POST /:id/members - Add member (ADMIN only)
const addMemberSchema = z.object({
  userId: z.string().min(1),
  departmentRole: z.enum(["AGENT", "MANAGER"]).optional(),
});

router.post("/:id/members", requireRole("ADMIN"), validate(addMemberSchema), async (req: Request, res: Response) => {
  try {
    const dept = await prisma.department.findFirst({ where: { id: req.params.id, tenantId: req.tenantId! } });
    if (!dept) { res.status(404).json({ error: "Department not found" }); return; }

    const user = await prisma.user.findFirst({ where: { id: req.body.userId, tenantId: req.tenantId! } });
    if (!user) { res.status(404).json({ error: "User not found" }); return; }

    // Check if user already belongs to a department
    const existing = await prisma.departmentMember.findUnique({ where: { userId: req.body.userId } });
    if (existing) { res.status(409).json({ error: "User already belongs to a department" }); return; }

    const member = await prisma.departmentMember.create({
      data: {
        tenantId: req.tenantId!,
        userId: req.body.userId,
        departmentId: req.params.id,
        departmentRole: req.body.departmentRole || "AGENT",
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    res.status(201).json({ data: member });
  } catch (err) {
    console.error("Add member error:", err);
    res.status(500).json({ error: "Failed to add member" });
  }
});

// PATCH /:id/members/:userId - Update member role (ADMIN only)
const updateMemberSchema = z.object({
  departmentRole: z.enum(["AGENT", "MANAGER"]),
});

router.patch("/:id/members/:userId", requireRole("ADMIN"), validate(updateMemberSchema), async (req: Request, res: Response) => {
  try {
    const member = await prisma.departmentMember.findFirst({
      where: { userId: req.params.userId, departmentId: req.params.id },
    });
    if (!member) { res.status(404).json({ error: "Member not found" }); return; }

    const updated = await prisma.departmentMember.update({
      where: { id: member.id },
      data: { departmentRole: req.body.departmentRole },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    res.json({ data: updated });
  } catch (err) {
    console.error("Update member error:", err);
    res.status(500).json({ error: "Failed to update member" });
  }
});

// DELETE /:id/members/:userId - Remove member (ADMIN only)
router.delete("/:id/members/:userId", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const member = await prisma.departmentMember.findFirst({
      where: { userId: req.params.userId, departmentId: req.params.id },
    });
    if (!member) { res.status(404).json({ error: "Member not found" }); return; }

    await prisma.departmentMember.delete({ where: { id: member.id } });
    res.json({ success: true });
  } catch (err) {
    console.error("Remove member error:", err);
    res.status(500).json({ error: "Failed to remove member" });
  }
});

// GET /:id/copilot - Get department copilot config (ADMIN or MANAGER)
router.get("/:id/copilot", requireDepartmentRole("MANAGER"), async (req: Request, res: Response) => {
  try {
    const dept = await prisma.department.findFirst({ where: { id: req.params.id, tenantId: req.tenantId! } });
    if (!dept) { res.status(404).json({ error: "Department not found" }); return; }

    let config = await prisma.departmentCopilotConfig.findUnique({ where: { departmentId: req.params.id } });
    if (!config) {
      // Fall back to tenant config
      const tenantConfig = await prisma.copilotConfig.findUnique({ where: { tenantId: req.tenantId! } });
      res.json({ data: tenantConfig, source: "tenant" });
      return;
    }
    res.json({ data: config, source: "department" });
  } catch (err) {
    console.error("Get dept copilot error:", err);
    res.status(500).json({ error: "Failed to get department copilot config" });
  }
});

// PUT /:id/copilot - Update department copilot config (ADMIN or MANAGER)
const deptCopilotSchema = z.object({
  copilotMode: z.enum(["READY_MESSAGE", "CONTEXT_ONLY"]).optional(),
  systemPrompt: z.string().optional(),
  rules: z.array(z.string()).optional(),
  tools: z.array(z.object({
    id: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    config: z.record(z.any()).optional(),
  })).optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().min(1).max(8192).optional(),
  isActive: z.boolean().optional(),
});

router.put("/:id/copilot", requireDepartmentRole("MANAGER"), validate(deptCopilotSchema), async (req: Request, res: Response) => {
  try {
    const dept = await prisma.department.findFirst({ where: { id: req.params.id, tenantId: req.tenantId! } });
    if (!dept) { res.status(404).json({ error: "Department not found" }); return; }

    const config = await prisma.departmentCopilotConfig.upsert({
      where: { departmentId: req.params.id },
      update: req.body,
      create: { tenantId: req.tenantId!, departmentId: req.params.id, ...req.body },
    });
    res.json({ data: config });
  } catch (err) {
    console.error("Update dept copilot error:", err);
    res.status(500).json({ error: "Failed to update department copilot config" });
  }
});

export default router;
