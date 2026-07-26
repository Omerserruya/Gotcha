import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma, authenticate, resolveTenant, requireRole, requirePermission, requireDepartmentRole, enforceMfaEnrollment, validate, requireCapacity } from "@chatcenter/shared";

const router = Router();
router.use(authenticate, resolveTenant, enforceMfaEnrollment());

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
      select: { id: true, name: true, role: true, avatarColor: true },
    });

    // Map department → its attached AI employees (many per department). Each
    // attachment is a RouterRule; grouping by routeTarget gives the roster the
    // overview shows inline next to human members.
    const aiRules = await prisma.routerRule.findMany({
      where: { tenantId: req.tenantId!, routeType: "AI_AGENT", aiAgentId: { not: null } },
      orderBy: { position: "asc" },
      select: { aiAgentId: true, routeTarget: true },
    });
    const agentById = new Map(aiAgents.map((a) => [a.id, a]));
    const aiByDept = new Map<string, any[]>();
    for (const r of aiRules) {
      if (!r.routeTarget || !r.aiAgentId) continue;
      const agent = agentById.get(r.aiAgentId);
      if (!agent) continue; // tenant-scoped list already; drops stale ids
      (aiByDept.get(r.routeTarget) ?? aiByDept.set(r.routeTarget, []).get(r.routeTarget)!).push(agent);
    }

    // Build tree: root departments (no parent) with nested children
    const deptMap = new Map(departments.map(d => [d.id, { ...d, aiEmployees: aiByDept.get(d.id) ?? [], children: [] as any[] }]));
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

// Plan limit enforced before the create runs, not after.
router.post(
  "/",
  requireRole("ADMIN"),
  requireCapacity("limit:departments", (tenantId) => prisma.department.count({ where: { tenantId } })),
  validate(createDepartmentSchema),
  async (req: Request, res: Response) => {
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
    const dept = await prisma.department.findFirst({ where: { id: String(req.params.id), tenantId: req.tenantId! } });
    if (!dept) { res.status(404).json({ error: "Department not found" }); return; }

    // Explicit allowlist (updateDepartmentSchema fields); tenantId never settable.
    const { name, description, queueMode, isActive, parentId } = req.body as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (queueMode !== undefined) data.queueMode = queueMode;
    if (isActive !== undefined) data.isActive = isActive;
    if (parentId !== undefined) data.parentId = parentId;
    const updated = await prisma.department.update({
      where: { id: String(req.params.id) },
      data,
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
    const dept = await prisma.department.findFirst({ where: { id: String(req.params.id), tenantId: req.tenantId! } });
    if (!dept) { res.status(404).json({ error: "Department not found" }); return; }

    await prisma.department.delete({ where: { id: String(req.params.id) } });
    res.json({ success: true });
  } catch (err) {
    console.error("Delete department error:", err);
    res.status(500).json({ error: "Failed to delete department" });
  }
});

// GET /:id/members - List department members (ADMIN or MANAGER)
router.get("/:id/members", requireDepartmentRole("MANAGER"), async (req: Request, res: Response) => {
  try {
    const dept = await prisma.department.findFirst({ where: { id: String(req.params.id), tenantId: req.tenantId! } });
    if (!dept) { res.status(404).json({ error: "Department not found" }); return; }

    const members = await prisma.departmentMember.findMany({
      where: { departmentId: String(req.params.id) },
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
    const dept = await prisma.department.findFirst({ where: { id: String(req.params.id), tenantId: req.tenantId! } });
    if (!dept) { res.status(404).json({ error: "Department not found" }); return; }

    const user = await prisma.user.findFirst({ where: { id: req.body.userId, tenantId: req.tenantId! } });
    if (!user) { res.status(404).json({ error: "User not found" }); return; }

    // Multi-department membership: a user may belong to several departments;
    // only a duplicate membership in THIS department is refused.
    const existing = await prisma.departmentMember.findFirst({
      where: { tenantId: req.tenantId!, userId: req.body.userId, departmentId: String(req.params.id) },
    });
    if (existing) { res.status(409).json({ error: "User is already a member of this department" }); return; }

    const member = await prisma.departmentMember.create({
      data: {
        tenantId: req.tenantId!,
        userId: req.body.userId,
        departmentId: String(req.params.id),
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
      where: { tenantId: req.tenantId!, userId: String(req.params.userId), departmentId: String(req.params.id) },
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
      where: { tenantId: req.tenantId!, userId: String(req.params.userId), departmentId: String(req.params.id) },
    });
    if (!member) { res.status(404).json({ error: "Member not found" }); return; }

    await prisma.departmentMember.delete({ where: { id: member.id } });
    res.json({ success: true });
  } catch (err) {
    console.error("Remove member error:", err);
    res.status(500).json({ error: "Failed to remove member" });
  }
});

// ─── Department Copilot (= AI Employee attached to the department) ──
// The "department copilot" is the AIAgent attached to this department via
// RouterRule (routeType=AI_AGENT, routeTarget=<departmentId>). There is no
// separate copilot-config blob - reading/writing this route resolves the
// attached AIAgent and maps its fields to the UI payload shape expected by
// `frontend/src/lib/api.ts` (`getDepartmentCopilot` / `updateDepartmentCopilot`).
//
// If no AI Employee is attached yet, GET returns { data: null, source: "default" }
// and PUT returns 400 asking the caller to attach one first via PUT /:id/ai-employee.

function aiAgentToCopilotPayload(agent: any) {
  return {
    copilotMode: "READY_MESSAGE",
    systemPrompt: agent.systemPrompt ?? "",
    rules: agent.escalationRules ?? [],
    model: agent.model,
    provider: agent.provider,
    temperature: agent.temperature,
    maxTokens: agent.maxTokens,
    isActive: agent.status === "ACTIVE",
    identity: agent.identity ?? null,
    goals: agent.goals ?? null,
    tone: agent.toneConfig ?? null,
    behavioral: agent.behavioral ?? null,
  };
}

async function resolveDepartmentAIAgent(tenantId: string, departmentId: string) {
  const rule = await prisma.routerRule.findFirst({
    where: {
      tenantId,
      routeType: "AI_AGENT",
      aiAgentId: { not: null },
      routeTarget: departmentId,
    },
    orderBy: { position: "asc" },
  });
  if (!rule?.aiAgentId) return null;
  return prisma.aIAgent.findFirst({
    where: { id: rule.aiAgentId, tenantId },
  });
}

router.get("/:id/copilot", async (req: Request, res: Response) => {
  try {
    const dept = await prisma.department.findFirst({
      where: { id: String(req.params.id), tenantId: req.tenantId! },
      select: { id: true, name: true },
    });
    if (!dept) { res.status(404).json({ error: "Department not found" }); return; }
    const agent = await resolveDepartmentAIAgent(req.tenantId!, dept.id);
    if (!agent) {
      res.json({ data: null, source: "default" });
      return;
    }
    res.json({ data: aiAgentToCopilotPayload(agent), source: "department" });
  } catch (err) {
    console.error("Get department copilot error:", err);
    res.status(500).json({ error: "Failed to get department copilot" });
  }
});

const updateCopilotSchema = z.object({}).passthrough();
router.put(
  "/:id/copilot",
  requireRole("ADMIN"),
  validate(updateCopilotSchema),
  async (req: Request, res: Response) => {
    try {
      const dept = await prisma.department.findFirst({
        where: { id: String(req.params.id), tenantId: req.tenantId! },
        select: { id: true },
      });
      if (!dept) { res.status(404).json({ error: "Department not found" }); return; }
      const agent = await resolveDepartmentAIAgent(req.tenantId!, dept.id);
      if (!agent) {
        res.status(400).json({
          error:
            "No AI Employee attached to this department. Attach one via PUT /:id/ai-employee before editing its configuration.",
        });
        return;
      }
      const body = req.body ?? {};
      const data: any = {};
      if (typeof body.systemPrompt === "string") data.systemPrompt = body.systemPrompt;
      if (Array.isArray(body.rules)) data.escalationRules = body.rules as any;
      if (typeof body.model === "string") data.model = body.model;
      if (typeof body.provider === "string") data.provider = body.provider;
      if (typeof body.temperature === "number") data.temperature = body.temperature;
      if (typeof body.maxTokens === "number") data.maxTokens = body.maxTokens;
      if (typeof body.isActive === "boolean") {
        data.status = body.isActive ? "ACTIVE" : "DRAFT";
      }
      if (body.identity !== undefined) data.identity = body.identity;
      if (body.goals !== undefined) data.goals = body.goals;
      if (body.tone !== undefined) data.toneConfig = body.tone;
      if (body.behavioral !== undefined) data.behavioral = body.behavioral;
      // Note: `tools` in the UI payload is NOT persisted here - per-department
      // tool permissions live on `AgentToolPermission` and are managed via
      // PUT /api/tools/permissions/:departmentId.
      const updated = await prisma.aIAgent.update({
        where: { id: agent.id },
        data,
      });
      res.json({ data: aiAgentToCopilotPayload(updated) });
    } catch (err) {
      console.error("Update department copilot error:", err);
      res.status(500).json({ error: "Failed to update department copilot" });
    }
  },
);

// GET /:id/ai-employee - Get assigned AI Employee for department
router.get("/:id/ai-employee", requireDepartmentRole("MANAGER"), async (req: Request, res: Response) => {
  try {
    const dept = await prisma.department.findFirst({ where: { id: String(req.params.id), tenantId: req.tenantId! } });
    if (!dept) { res.status(404).json({ error: "Department not found" }); return; }

    // Find AI employee assigned via router rule
    const rule = await prisma.routerRule.findFirst({
      where: {
        tenantId: req.tenantId!,
        routeType: "AI_AGENT",
        aiAgentId: { not: null },
        enabled: true,
        routeTarget: String(req.params.id),
      },
      orderBy: { position: "asc" },
    });

    if (rule?.aiAgentId) {
      const agent = await prisma.aIAgent.findUnique({
        where: { id: rule.aiAgentId },
        select: { id: true, name: true, role: true, status: true, avatarColor: true },
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
    const dept = await prisma.department.findFirst({ where: { id: String(req.params.id), tenantId: req.tenantId! } });
    if (!dept) { res.status(404).json({ error: "Department not found" }); return; }

    const { aiAgentId } = req.body;

    // Find existing router rule for this department
    const existingRule = await prisma.routerRule.findFirst({
      where: {
        tenantId: req.tenantId!,
        routeType: "AI_AGENT",
        routeTarget: String(req.params.id),
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
        _max: { position: true },
      });

      const rule = await prisma.routerRule.create({
        data: {
          tenantId: req.tenantId!,
          name: `${dept.name} AI Employee`,
          position: (maxPriority._max?.position ?? 0) + 1,
          conditions: [{ field: "department", operator: "equals", value: String(req.params.id) }],
          logic: "AND",
          routeType: "AI_AGENT",
          routeTarget: String(req.params.id),
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

// ── Multiple AI employees per department ──
// A department may have MANY AI employees. Each attachment is its own
// RouterRule (routeType=AI_AGENT, routeTarget=<departmentId>) - so adding or
// removing one never disturbs the others. The FIRST rule by position remains
// the "primary" that resolveDepartmentAIAgent / copilot config use.

async function listDepartmentAIEmployees(tenantId: string, departmentId: string) {
  const rules = await prisma.routerRule.findMany({
    where: { tenantId, routeType: "AI_AGENT", aiAgentId: { not: null }, routeTarget: departmentId },
    orderBy: { position: "asc" },
  });
  const ids = rules.map((r) => r.aiAgentId!).filter(Boolean);
  if (ids.length === 0) return [];
  // Tenant-scoped lookup: an id that isn't this tenant's agent is silently
  // dropped, so a stale/cross-tenant rule can never leak another org's agent.
  const agents = await prisma.aIAgent.findMany({
    where: { id: { in: ids }, tenantId },
    select: { id: true, name: true, role: true, status: true, avatarColor: true },
  });
  const byId = new Map(agents.map((a) => [a.id, a]));
  return rules
    .map((r) => (byId.has(r.aiAgentId!) ? { ...byId.get(r.aiAgentId!)!, ruleId: r.id } : null))
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

// GET /:id/ai-employees - list ALL AI employees attached to the department
router.get("/:id/ai-employees", requireDepartmentRole("MANAGER"), async (req: Request, res: Response) => {
  try {
    const dept = await prisma.department.findFirst({ where: { id: String(req.params.id), tenantId: req.tenantId! } });
    if (!dept) { res.status(404).json({ error: "Department not found" }); return; }
    res.json({ data: await listDepartmentAIEmployees(req.tenantId!, dept.id) });
  } catch (err) {
    console.error("List dept AI employees error:", err);
    res.status(500).json({ error: "Failed to list department AI employees" });
  }
});

// POST /:id/ai-employees - attach one more AI employee (idempotent per agent)
const attachAIEmployeeSchema = z.object({ aiAgentId: z.string().min(1) });
router.post("/:id/ai-employees", requirePermission("settings:members:manage"), validate(attachAIEmployeeSchema), async (req: Request, res: Response) => {
  try {
    const dept = await prisma.department.findFirst({ where: { id: String(req.params.id), tenantId: req.tenantId! } });
    if (!dept) { res.status(404).json({ error: "Department not found" }); return; }

    const { aiAgentId } = req.body as { aiAgentId: string };
    // Cross-tenant guard: the agent MUST belong to the active tenant.
    const agent = await prisma.aIAgent.findFirst({
      where: { id: aiAgentId, tenantId: req.tenantId! },
      select: { id: true, name: true, role: true, status: true, avatarColor: true },
    });
    if (!agent) { res.status(404).json({ error: "AI Employee not found" }); return; }

    const existing = await prisma.routerRule.findFirst({
      where: { tenantId: req.tenantId!, routeType: "AI_AGENT", routeTarget: dept.id, aiAgentId },
    });
    if (existing) {
      // Already attached - re-enable if it was disabled, otherwise no-op.
      if (!existing.enabled) await prisma.routerRule.update({ where: { id: existing.id }, data: { enabled: true } });
      res.json({ data: agent, ruleId: existing.id });
      return;
    }

    const maxPriority = await prisma.routerRule.aggregate({ where: { tenantId: req.tenantId! }, _max: { position: true } });
    const rule = await prisma.routerRule.create({
      data: {
        tenantId: req.tenantId!,
        name: `${dept.name} AI Employee (${agent.name})`,
        position: (maxPriority._max?.position ?? 0) + 1,
        conditions: [{ field: "department", operator: "equals", value: dept.id }],
        logic: "AND",
        routeType: "AI_AGENT",
        routeTarget: dept.id,
        aiAgentId,
        enabled: true,
      },
    });
    res.status(201).json({ data: agent, ruleId: rule.id });
  } catch (err) {
    console.error("Attach dept AI employee error:", err);
    res.status(500).json({ error: "Failed to attach AI employee" });
  }
});

// DELETE /:id/ai-employees/:aiAgentId - detach ONE AI employee, leaving the rest
router.delete("/:id/ai-employees/:aiAgentId", requirePermission("settings:members:manage"), async (req: Request, res: Response) => {
  try {
    const dept = await prisma.department.findFirst({ where: { id: String(req.params.id), tenantId: req.tenantId! } });
    if (!dept) { res.status(404).json({ error: "Department not found" }); return; }
    // Scope the delete to this tenant + department + agent so removing one
    // attachment can never touch another department's or tenant's rules.
    await prisma.routerRule.deleteMany({
      where: { tenantId: req.tenantId!, routeType: "AI_AGENT", routeTarget: dept.id, aiAgentId: String(req.params.aiAgentId) },
    });
    res.json({ data: await listDepartmentAIEmployees(req.tenantId!, dept.id) });
  } catch (err) {
    console.error("Detach dept AI employee error:", err);
    res.status(500).json({ error: "Failed to detach AI employee" });
  }
});

export default router;
