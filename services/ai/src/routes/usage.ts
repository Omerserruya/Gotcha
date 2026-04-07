import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole } from "@chatcenter/shared";

const router = Router();

// ─── Tenant Admin: Get own usage stats ──────────────────────

router.get("/stats", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId! as string;
    const days = parseInt(req.query.days as string) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Aggregate by type
    const byType = await prisma.usageLog.groupBy({
      by: ["type"],
      where: { tenantId, createdAt: { gte: since } },
      _sum: { quantity: true },
      _count: { id: true },
    });

    // Build stats map
    const stats: Record<string, { total: number; count: number }> = {};
    for (const row of byType) {
      stats[row.type] = { total: row._sum.quantity || 0, count: row._count.id };
    }

    res.json({ data: { stats, period: days } });
  } catch (err) {
    console.error("Usage stats error:", err);
    res.status(500).json({ error: "Failed to get usage stats" });
  }
});

// ─── Tenant Admin: Get usage over time ──────────────────────

router.get("/daily", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId! as string;
    const days = parseInt(req.query.days as string) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const logs = await prisma.$queryRawUnsafe<Array<{ date: string; type: string; total: bigint; count: bigint }>>(
      `SELECT DATE(created_at) as date, type, SUM(quantity)::bigint as total, COUNT(*)::bigint as count
       FROM usage_logs
       WHERE tenant_id = $1 AND created_at >= $2
       GROUP BY DATE(created_at), type
       ORDER BY date ASC`,
      tenantId,
      since,
    );

    const data = logs.map((row) => ({
      date: row.date,
      type: row.type,
      total: Number(row.total),
      count: Number(row.count),
    }));

    res.json({ data });
  } catch (err) {
    console.error("Usage daily error:", err);
    res.status(500).json({ error: "Failed to get daily usage" });
  }
});

// ─── Tenant Admin: Get recent usage logs ────────────────────

router.get("/logs", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId! as string;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const type = req.query.type as string;

    const where: any = { tenantId };
    if (type) where.type = type;

    const [logs, total] = await Promise.all([
      prisma.usageLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.usageLog.count({ where }),
    ]);

    res.json({ data: logs, total });
  } catch (err) {
    console.error("Usage logs error:", err);
    res.status(500).json({ error: "Failed to get usage logs" });
  }
});

export default router;
