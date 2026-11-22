/**
 * SYSTEM_ADMIN console: the self sign-up settings (2026-11-22).
 *
 *   GET /api/system/self-signup   the four settings, the deployment's own
 *                                 switch, and the bounds the form may offer
 *   PUT /api/system/self-signup   all four settings at once
 *
 * The settings and their bounds live in @chatcenter/shared (lib/self-signup),
 * because the public sign-up and billing's card sweep read them too. This file
 * only guards the door, saves, and writes the audit line.
 *
 * `envEnabled` is read-only here on purpose: the deployment decides whether
 * sign-up can be open at all (SELF_SIGNUP=on), and the console shows it so
 * "enabled but nothing happens" explains itself.
 */
import { Router, Request, Response } from "express";
import {
  authenticate,
  requireSystemAdmin,
  crossTenantMiddleware,
  writeAudit,
  AuditAction,
  SELF_SIGNUP_BOUNDS,
  readSelfSignupSettings,
  writeSelfSignupSettings,
  validateSelfSignupSettings,
  selfSignupEnvEnabled,
  systemTenantId,
  type SelfSignupSettings,
} from "@chatcenter/shared";

const router = Router();
router.use("/self-signup", authenticate, requireSystemAdmin(), crossTenantMiddleware);

const view = (s: SelfSignupSettings) => ({
  enabled: s.enabled,
  trialDays: s.trialDays,
  cardRequiredAfterDays: s.cardRequiredAfterDays,
  trialCredits: s.trialCredits,
  envEnabled: selfSignupEnvEnabled(),
  bounds: SELF_SIGNUP_BOUNDS,
});

router.get("/self-signup", async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json(view(await readSelfSignupSettings()));
  } catch (err) {
    console.error("[self-signup] settings read failed:", (err as Error)?.message);
    res.status(500).json({ error: "Failed to read the sign-up settings" });
  }
});

router.put("/self-signup", async (req: Request, res: Response): Promise<void> => {
  try {
    const checked = validateSelfSignupSettings(req.body);
    if (!checked.ok) {
      res.status(400).json({ error: "validation", fields: checked.fields });
      return;
    }
    const actorId = ((req as any).user?.userId as string | undefined) ?? undefined;
    const before = await readSelfSignupSettings();
    const saved = await writeSelfSignupSettings(checked.value, actorId);
    if (!saved) {
      // The settings hang on the System organization. Without it there is
      // nowhere to save, and saying "saved" would be a lie.
      res.status(503).json({ error: "system_organization_missing" });
      return;
    }
    const tenantId = await systemTenantId();
    if (tenantId) {
      await writeAudit({
        tenantId,
        actorType: "user",
        actorId,
        action: AuditAction.SELF_SIGNUP_SETTINGS_CHANGED,
        targetType: "platform_setting",
        targetId: "selfSignup",
        metadata: { before, after: checked.value },
      });
    }
    res.json(view(checked.value));
  } catch (err) {
    console.error("[self-signup] settings write failed:", (err as Error)?.message);
    res.status(500).json({ error: "Failed to save the sign-up settings" });
  }
});

export default router;
