import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole } from "@chatcenter/shared";

const router = Router();

router.use(authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"));

// GET / — List all active TenantTools for the tenant (with catalog info)
router.get("/", async (req: Request, res: Response) => {
  try {
    const tools = await prisma.tenantTool.findMany({
      where: { tenantId: req.tenantId!, isEnabled: true },
      include: {
        catalogTool: true,
        tenantIntegration: {
          include: {
            integration: { select: { name: true, slug: true, icon: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: tools });
  } catch (err) {
    console.error("List tools error:", err);
    res.status(500).json({ error: "Failed to list tools" });
  }
});

// GET /permissions/:departmentId — Get tool permissions for a department
router.get("/permissions/:departmentId", async (req: Request, res: Response) => {
  try {
    const departmentId = req.params.departmentId as string;

    const department = await prisma.department.findFirst({
      where: { id: departmentId, tenantId: req.tenantId! },
    });
    if (!department) {
      res.status(404).json({ error: "Department not found" });
      return;
    }

    const tools = await prisma.tenantTool.findMany({
      where: { tenantId: req.tenantId!, isEnabled: true },
      include: {
        catalogTool: true,
        agentToolPermissions: {
          where: { departmentId },
          select: { id: true, isAllowed: true, requireApproval: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({ data: tools });
  } catch (err) {
    console.error("Get tool permissions error:", err);
    res.status(500).json({ error: "Failed to get tool permissions" });
  }
});

// PUT /permissions/:departmentId — Batch update tool permissions for a department
router.put("/permissions/:departmentId", async (req: Request, res: Response) => {
  try {
    const departmentId = req.params.departmentId as string;
    const { permissions } = req.body;

    if (!Array.isArray(permissions)) {
      res.status(400).json({ error: "permissions array is required" });
      return;
    }

    const department = await prisma.department.findFirst({
      where: { id: departmentId, tenantId: req.tenantId! },
    });
    if (!department) {
      res.status(404).json({ error: "Department not found" });
      return;
    }

    const results = await Promise.all(
      permissions.map(
        (p: { tenantToolId: string; isAllowed: boolean; requireApproval?: boolean }) =>
          prisma.agentToolPermission.upsert({
            where: {
              tenantToolId_departmentId: {
                tenantToolId: p.tenantToolId,
                departmentId,
              },
            },
            create: {
              tenantToolId: p.tenantToolId,
              departmentId,
              isAllowed: p.isAllowed,
              requireApproval: p.requireApproval ?? false,
            },
            update: {
              isAllowed: p.isAllowed,
              requireApproval: p.requireApproval ?? false,
            },
          })
      )
    );

    res.json({ data: results });
  } catch (err) {
    console.error("Update tool permissions error:", err);
    res.status(500).json({ error: "Failed to update tool permissions" });
  }
});

export default router;
