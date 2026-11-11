/**
 * POST /api/system/widget-brand-candidates { url } (platform admin only).
 *
 * The console's widget preview (Omer, 2026-11-11): the onboarding scan's
 * home-page read and brand extraction for any site, with nothing written. The
 * AI service's preview route calls this with the admin's token, then runs the
 * vetting and vision call on what it returns. Reads one page plus the
 * manifest and two stylesheets, all through the SSRF guard.
 *
 * Guarded per route (not router.use): this router shares /api/system with
 * others, and a router-level guard would run for their requests too.
 */
import { Router, Request, Response } from "express";
import { authenticate, requireSystemAdmin } from "@chatcenter/shared";
import { fetchPageForCrawl, isBlocked, isUnreadable } from "../services/site-crawl.service";
import { extractBrandCandidates, pageContext, previewOrigin } from "../services/widget-brand-extract";

const router = Router();

router.post("/widget-brand-candidates", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  const origin = previewOrigin((req.body as any)?.url);
  if (!origin) { res.status(400).json({ error: "A site address is needed", code: "BAD_URL" }); return; }
  try {
    let home = await fetchPageForCrawl(origin, 12_000);
    if (isUnreadable(home)) home = await fetchPageForCrawl(origin, 15_000);
    if (isBlocked(home)) { res.status(422).json({ error: "The site refused to be read", code: "SITE_BLOCKED", reason: home.reason }); return; }
    if (!home || isUnreadable(home)) { res.status(422).json({ error: "The site could not be read", code: "SITE_UNREACHABLE" }); return; }
    const candidates = await extractBrandCandidates(origin, home.html);
    res.json({ data: { url: origin, candidates, context: pageContext(home) } });
  } catch (err: any) {
    console.error("[widget-brand] failed:", err?.message ?? err);
    res.status(422).json({ error: "The site could not be read", code: "SITE_UNREACHABLE" });
  }
});

export default router;
