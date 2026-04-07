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
        parent: { select: { id: true, name: true } },
        children: { select: { id: true, name: true, isActive: true } },
        members: {
          select: {
            departmentRole: true,
            user: { select: { id: true, name: true, email: true, isActive: true } },
          },
        },
      },
      orderBy: { name: "asc" },
    });
    res.json({ data: departments });
  } catch (err) {
    console.error("List departments error:", err);
    res.status(500).json({ error: "Failed to list departments" });
  }
});

// GET /tree - Get departments as hierarchical tree
router.get("/tree", async (req: Request, res: Response) => {
  try {
    const departments = await prisma.department.findMany({
      where: { tenantId: req.tenantId! },
      include: {
        _count: { select: { members: true, conversations: { where: { status: { not: "CLOSED" } } } } },
        members: {
          select: {
            departmentRole: true,
            user: { select: { id: true, name: true, email: true, isActive: true } },
          },
        },
      },
      orderBy: { name: "asc" },
    });

    // Get AI agents assigned to departments via router rules
    const aiAgents = await prisma.aIAgent.findMany({
      where: { tenantId: req.tenantId!, status: "ACTIVE" },
      select: { id: true, name: true, role: true, mode: true, avatarColor: true },
    });

    // Build tree: root departments (no parent) with nested children
    const deptMap = new Map(departments.map(d => [d.id, { ...d, children: [] as any[] }]));
    const roots: any[] = [];
    for (const dept of deptMap.values()) {
      if (dept.parentId && deptMap.has(dept.parentId)) {
        deptMap.get(dept.parentId)!.children.push(dept);
      } else {
        roots.push(dept);
      }
    }

    res.json({ data: { tree: roots, aiAgents } });
  } catch (err) {
    console.error("Get department tree error:", err);
    res.status(500).json({ error: "Failed to get department tree" });
  }
});

// POST / - Create department (ADMIN only)
const createDepartmentSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  queueMode: z.enum(["CLAIM", "ROUND_ROBIN"]).optional(),
  parentId: z.string().optional(),
});

router.post("/", requireRole("ADMIN"), validate(createDepartmentSchema), async (req: Request, res: Response) => {
  try {
    const { name, description, queueMode, parentId } = req.body;
    const existing = await prisma.department.findUnique({
      where: { tenantId_name: { tenantId: req.tenantId!, name } },
    });
    if (existing) { res.status(409).json({ error: "Department with this name already exists" }); return; }

    // Validate parentId if provided
    if (parentId) {
      const parent = await prisma.department.findFirst({ where: { id: parentId, tenantId: req.tenantId! } });
      if (!parent) { res.status(404).json({ error: "Parent department not found" }); return; }
    }

    const department = await prisma.department.create({
      data: { tenantId: req.tenantId!, name, description, queueMode: queueMode || "CLAIM", parentId: parentId || null },
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
  parentId: z.string().nullable().optional(),
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

// GET /:id/ai-employee - Get assigned AI Employee for department
router.get("/:id/ai-employee", requireDepartmentRole("MANAGER"), async (req: Request, res: Response) => {
  try {
    const dept = await prisma.department.findFirst({ where: { id: req.params.id, tenantId: req.tenantId! } });
    if (!dept) { res.status(404).json({ error: "Department not found" }); return; }

    // Find AI employee assigned via router rule
    const rule = await prisma.routerRule.findFirst({
      where: {
        tenantId: req.tenantId!,
        routeType: "AI_AGENT",
        aiAgentId: { not: null },
        enabled: true,
        routeTarget: req.params.id,
      },
      orderBy: { priority: "asc" },
    });

    if (rule?.aiAgentId) {
      const agent = await prisma.aIAgent.findUnique({
        where: { id: rule.aiAgentId },
        select: { id: true, name: true, role: true, mode: true, status: true, avatarColor: true, description: true },
      });
      res.json({ data: agent, ruleId: rule.id });
      return;
    }

    res.json({ data: null });
  } catch (err) {
    console.error("Get dept AI employee error:", err);
    res.status(500).json({ error: "Failed to get department AI employee" });
  }
});

// PUT /:id/ai-employee - Assign or unassign AI Employee to department
const assignAIEmployeeSchema = z.object({
  aiAgentId: z.string().nullable(),
});

router.put("/:id/ai-employee", requireRole("ADMIN"), validate(assignAIEmployeeSchema), async (req: Request, res: Response) => {
  try {
    const dept = await prisma.department.findFirst({ where: { id: req.params.id, tenantId: req.tenantId! } });
    if (!dept) { res.status(404).json({ error: "Department not found" }); return; }

    const { aiAgentId } = req.body;

    // Find existing router rule for this department
    const existingRule = await prisma.routerRule.findFirst({
      where: {
        tenantId: req.tenantId!,
        routeType: "AI_AGENT",
        routeTarget: req.params.id,
      },
    });

    if (!aiAgentId) {
      // Unassign: delete the router rule
      if (existingRule) {
        await prisma.routerRule.delete({ where: { id: existingRule.id } });
      }
      res.json({ data: null });
      return;
    }

    // Verify agent exists and belongs to tenant
    const agent = await prisma.aIAgent.findFirst({ where: { id: aiAgentId, tenantId: req.tenantId! } });
    if (!agent) { res.status(404).json({ error: "AI Employee not found" }); return; }

    if (existingRule) {
      // Update existing rule
      const updated = await prisma.routerRule.update({
        where: { id: existingRule.id },
        data: { aiAgentId, enabled: true },
      });
      res.json({ data: agent, ruleId: updated.id });
    } else {
      // Create new router rule
      const maxPriority = await prisma.routerRule.aggregate({
        where: { tenantId: req.tenantId! },
        _max: { priority: true },
      });

      const rule = await prisma.routerRule.create({
        data: {
          tenantId: req.tenantId!,
          name: `${dept.name} AI Employee`,
          priority: (maxPriority._max.priority || 0) + 1,
          conditions: [{ field: "department", operator: "equals", value: req.params.id }],
          logic: "AND",
          routeType: "AI_AGENT",
          routeTarget: req.params.id,
          aiAgentId,
          enabled: true,
        },
      });
      res.json({ data: agent, ruleId: rule.id });
    }
  } catch (err) {
    console.error("Assign AI employee error:", err);
    res.status(500).json({ error: "Failed to assign AI employee" });
  }
});

export default router;
