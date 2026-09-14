/**
 * GET|PUT /api/workspace/prohibited-claims — the things GOTCHA must never say.
 *
 * WHY THIS IS NOT NEW STORAGE, AND NOT A NEW WRITER
 * These are `BusinessPolicy.data.blockedTopics`, which the prompt builder
 * already reads and obeys (worker/prompt/system-core-builder.ts). An editor
 * for them already existed too - `PUT /api/ai-assist/policy` writes the whole
 * policy object, this field included.
 *
 * So this route deliberately adds no second source of truth. It is a NARROW
 * surface over the same store: the settings screen edits one list without
 * having to send, and therefore without being able to clobber, the discount
 * ceiling and the refund rule that share the blob. Both routes go through the
 * same validator, so there is one answer to "what is a legal rule", not two
 * that drift.
 *
 * Whole-list replace rather than add/remove: these are a handful of short
 * strings with no ids, and inventing ids for them would mean storing an object
 * where the prompt builder expects a string.
 */
import { Router, type Request, type Response } from "express";
import {
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant,
  requirePermission,
} from "@chatcenter/shared";
import {
  getPolicy,
  setPolicy,
  validateStringList,
  PolicyValidationError,
} from "../services/policy.service";

const router = Router();

/**
 * Reachable during onboarding: deciding what the AI may not claim is setup
 * work, done before the workspace is live, and the screen that collects it is
 * part of getting there.
 */
router.use("/workspace/prohibited-claims", authenticate, resolveTenant, requireOnboardingOrActiveTenant());

router.get(
  "/workspace/prohibited-claims",
  // The catalog already splits seeing the tenant's AI rules from changing
  // them, and prohibited claims are exactly that: a rule governing what the
  // employee may say. Reusing the existing pair rather than adding a
  // permission means a tenant that has already delegated policy reading to a
  // finance or ops lead does not have to delegate it twice.
  requirePermission("settings:business-policies:read"),
  async (req: Request, res: Response) => {
    try {
      const policy = await getPolicy(req.tenantId!);
      res.json({ data: { claims: policy.blockedTopics } });
    } catch (err) {
      console.error("prohibited-claims read error:", err);
      res.status(500).json({ error: "Failed to read prohibited claims" });
    }
  },
);

router.put(
  "/workspace/prohibited-claims",
  // Writing is a management act: this changes what the AI says to every
  // customer, so it is not the same grant as being able to read the list.
  requirePermission("settings:business-policies:manage"),
  async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!("claims" in body)) {
        res.status(400).json({ error: "claims is required", field: "claims" });
        return;
      }
      // The same validator the full-policy route uses, so a rule that is legal
      // through one surface is legal through the other.
      const claims = validateStringList("claims", body.claims);
      // A PATCH of one field, not a PUT of the policy: the discount ceiling
      // and the refund rule live in the same blob and are none of this
      // screen's business.
      const policy = await setPolicy(req.tenantId!, { blockedTopics: claims });
      res.json({ data: { claims: policy.blockedTopics } });
    } catch (err) {
      if (err instanceof PolicyValidationError) {
        res.status(400).json({ error: err.message, field: err.field });
        return;
      }
      console.error("prohibited-claims write error:", err);
      res.status(500).json({ error: "Failed to save prohibited claims" });
    }
  },
);

export default router;
