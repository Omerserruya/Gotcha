import { Router, Request, Response } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireActiveTenant,
  requireRole,
  listSupportedCountries,
} from "@chatcenter/shared";

/**
 * Per-tenant operational settings. Today this exposes only the default
 * country code used to E.164-normalize bare phone numbers at broadcast
 * fan-out time. Kept under conversation service since the same service
 * owns the broadcast/audience flows that consume it.
 *
 *   GET   /api/tenant-settings   → { defaultCountryCode, supportedCountries }
 *   PATCH /api/tenant-settings   { defaultCountryCode } → updated
 */
const router = Router();
router.use(authenticate, resolveTenant, requireActiveTenant());

router.get("/", async (req: Request, res: Response) => {
  try {
    const [tenant, activeChannelCount] = await Promise.all([
      prisma.tenant.findUnique({
        where: { id: req.tenantId! },
        select: {
          defaultCountryCode: true,
          voiceCopilotEnabled: true,
          voiceInboxUiEnabled: true,
          voiceIncomingEnabled: true,
        },
      }),
      // Cheap precondition for the frontend: skip /api/voice-copilot/token
      // entirely when the tenant has no active voice channel yet.
      prisma.communicationChannel.count({
        where: { tenantId: req.tenantId!, channelType: "VOICE", status: "ACTIVE" },
      }),
    ]);
    res.json({
      data: {
        defaultCountryCode: tenant?.defaultCountryCode ?? "IL",
        supportedCountries: listSupportedCountries(),
        // Phase 1 — Live Call CoPilot feature flags. All default-false so
        // tenants without the rollout see byte-identical UI to today.
        voiceCopilotEnabled: !!tenant?.voiceCopilotEnabled,
        voiceInboxUiEnabled: !!tenant?.voiceInboxUiEnabled,
        voiceIncomingEnabled: !!tenant?.voiceIncomingEnabled,
        hasActiveVoiceChannel: activeChannelCount > 0,
      },
    });
  } catch (err) {
    console.error("tenant-settings.get error:", err);
    res.status(500).json({ error: "Failed to load tenant settings" });
  }
});

router.patch("/", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const raw = (req.body?.defaultCountryCode ?? "").toString().trim().toUpperCase();
    if (!raw) {
      res.status(400).json({ error: "defaultCountryCode required" });
      return;
    }
    const allowed = new Set(listSupportedCountries().map((c) => c.code));
    if (!allowed.has(raw)) {
      res.status(400).json({ error: `Unsupported country code: ${raw}` });
      return;
    }
    const tenant = await prisma.tenant.update({
      where: { id: req.tenantId! },
      data: { defaultCountryCode: raw },
      select: { defaultCountryCode: true },
    });
    res.json({ data: { defaultCountryCode: tenant.defaultCountryCode } });
  } catch (err) {
    console.error("tenant-settings.patch error:", err);
    res.status(500).json({ error: "Failed to update tenant settings" });
  }
});

export default router;
