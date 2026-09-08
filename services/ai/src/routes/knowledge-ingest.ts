/**
 * GET /api/knowledge/ingest/latest — what came back from pointing GOTCHA at a
 * website.
 *
 * Day one's feedback line: pages read, answers drafted, answers needing
 * confirmation. Nothing reported it, so the screen had no way to show that the
 * scan had done anything at all - the owner pointed us at their site and got
 * silence.
 *
 * Every figure is a COUNT of rows that exist, never a progress estimate. A
 * scan that half-finished reports what it actually produced rather than a
 * percentage of a total nobody knows.
 */
import { Router, type Request, type Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant } from "@chatcenter/shared";

const router = Router();
router.use("/knowledge/ingest/latest", authenticate, resolveTenant, requireActiveTenant());

/** What the onboarding website scan writes its pages as. */
const SCAN_SOURCE_TYPES = ["onboarding_scan", "url", "website", "web"];

router.get("/knowledge/ingest/latest", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;

    const [pages, latest, drafted, needingConfirmation] = await Promise.all([
      prisma.knowledgeDocument.count({
        where: { tenantId, sourceType: { in: SCAN_SOURCE_TYPES } },
      }),
      prisma.knowledgeDocument.findFirst({
        where: { tenantId, sourceType: { in: SCAN_SOURCE_TYPES } },
        select: { createdAt: true, status: true },
        orderBy: { createdAt: "desc" },
      }),
      prisma.knowledgeCandidate.count({ where: { tenantId } }),
      prisma.knowledgeCandidate.count({ where: { tenantId, status: "PENDING" } }),
    ]);

    if (!latest) {
      // No scan has ever run. Null rather than a row of zeros: "we read nothing"
      // and "you have not asked us to read anything" are different answers, and
      // only one of them is a reason to worry.
      res.json({ data: null });
      return;
    }

    // `finishedAt` stays null while anything is still being processed, which is
    // what the screen uses to keep showing progress rather than a result.
    const stillWorking = await prisma.knowledgeDocument.count({
      where: {
        tenantId,
        sourceType: { in: SCAN_SOURCE_TYPES },
        status: { notIn: ["ready", "failed"] },
      },
    });

    res.json({
      data: {
        pagesRead: pages,
        answersDrafted: drafted,
        answersNeedingConfirmation: needingConfirmation,
        finishedAt: stillWorking > 0 ? null : latest.createdAt.toISOString(),
      },
    });
  } catch (err) {
    console.error("Knowledge ingest result error:", err);
    res.status(500).json({ error: "Failed to get ingest result" });
  }
});

export default router;
