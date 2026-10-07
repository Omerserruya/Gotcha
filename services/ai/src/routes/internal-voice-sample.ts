/**
 * POST /api/internal/voice-sample - what this voice would actually sound like.
 *
 * INTERNAL ONLY. The customer-facing endpoint is
 * POST /api/workspace/voice/sample in services/auth, which composes the rest
 * of the workspace settings screen. It delegates here because a NEW model call
 * belongs only in this service, and that rule is worth more than saving a hop.
 *
 * Goes through `generateResponse` rather than the OpenAI client directly, so
 * the sample is billed, rate-limited and logged like every other model call.
 * A preview that quietly bypassed the AI Units check would be a way to spend
 * a tenant's budget without it appearing anywhere.
 */
import { Router, type Request, type Response } from "express";
import { requireInternalKey } from "@chatcenter/shared";
import { generateResponse, getDefaultModel } from "../services/ai.service";
import { getCompanyContext } from "../services/company-context.service";
import { humanizeReply } from "../services/reply-style";

const router = Router();

/** The customer turn every sample answers, so two drafts are comparable. */
const SAMPLE_QUESTION = "Hi, I ordered last week and it still hasn't arrived. What's going on?";

router.post("/internal/voice-sample", requireInternalKey, async (req: Request, res: Response) => {
  const { tenantId, guidance } = (req.body ?? {}) as { tenantId?: string; guidance?: string };
  if (!tenantId || typeof guidance !== "string" || !guidance.trim()) {
    res.status(400).json({ error: "tenantId and guidance are required" });
    return;
  }

  try {
    const company = await getCompanyContext(tenantId);

    // The same company block a real answer is built with. Without it the
    // sample would demonstrate the voice against a business that does not
    // exist, which is a preview of nothing.
    const companyBlock = company
      ? [
          "# The business",
          company.organizationName ? `Name: ${company.organizationName}` : "",
          company.businessDescription ? `What it does: ${company.businessDescription}` : "",
          company.industry ? `Industry: ${company.industry}` : "",
        ].filter(Boolean).join("\n")
      : "";

    const result = await generateResponse({
      tenantId,
      model: getDefaultModel(),
      messages: [
        {
          role: "system",
          content: [
            "You are this business's customer service employee, writing one reply.",
            companyBlock,
            "# How this business writes",
            // The DRAFT, not the stored voice: the screen is asking what this
            // text would do before anyone commits to it.
            guidance.trim(),
            "",
            "Write only the reply itself. No preamble, no explanation, no quotation marks.",
            "Answer in the language the customer wrote in.",
          ].filter(Boolean).join("\n"),
        },
        { role: "user", content: SAMPLE_QUESTION },
      ],
      metadata: { type: "voice_sample" },
    });

    const reply = humanizeReply((result?.content ?? "").trim()) ?? "";
    if (!reply) {
      // An empty completion is a failed sample, not an empty one. Reported as
      // unavailable so the caller shows "could not generate" rather than an
      // empty bubble that reads like the voice produces nothing.
      res.status(503).json({ error: "empty_sample" });
      return;
    }
    res.json({ reply });
  } catch (err) {
    console.error("[voice-sample] generation failed:", (err as Error).message);
    res.status(503).json({ error: "sample_unavailable" });
  }
});

export default router;
