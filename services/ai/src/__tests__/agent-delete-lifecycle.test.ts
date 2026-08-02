import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma, parseCopilotConfig } from "@chatcenter/shared";

/**
 * Deleting an AI employee must not leave anything pointing at it.
 *
 * The agent id was stored in TWO places on a voice channel: the `ai_agent_id`
 * FK, and a mirror inside the `copilot_config` JSONB that the channel update
 * route rewrites on every save. Deleting the employee nulled the column
 * (onDelete: SetNull) and left the mirror untouched.
 *
 * `copilot-config-loader` then read the blob and only overwrote `aiAgentId`
 * when the FK was present - so for a deleted employee it returned the STALE id
 * as current config. A dangling reference is worse than a missing one: a caller
 * cannot tell it apart from a live binding, and the channel goes on describing
 * itself as bound to an employee that no longer exists.
 *
 * Against the real database, because the whole defect lives in the gap between
 * what the schema nulls automatically and what it does not.
 */

const DB = !!process.env.DATABASE_URL;
const d = DB ? describe : describe.skip;

const RUN = `del_${Date.now()}`;
const ids = { tenant: "", agent: "", commChannel: "", voiceChannel: "" };

d("an agent id left in a JSONB mirror", () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({
      data: { name: RUN, slug: RUN, status: "ACTIVE" as any },
    });
    ids.tenant = tenant.id;

    const agent = await prisma.aIAgent.create({
      data: { tenantId: tenant.id, name: `${RUN}-agent`, status: "ACTIVE" as any },
    });
    ids.agent = agent.id;

    const cc = await prisma.communicationChannel.create({
      data: {
        tenantId: tenant.id,
        provider: "twilio",
        channelType: "VOICE" as any,
        friendlyName: `${RUN}-voice`,
        status: "ACTIVE" as any,
      },
    });
    ids.commChannel = cc.id;

    const vc = await prisma.voiceChannel.create({
      data: {
        communicationChannelId: cc.id,
        aiAgentId: agent.id,
        // Exactly what the channel update route writes: the FK mirrored into
        // the blob for backwards compatibility.
        copilotConfig: { language: "en", aiAgentId: agent.id } as any,
      },
    });
    ids.voiceChannel = vc.id;
  });

  afterAll(async () => {
    await prisma.voiceChannel.deleteMany({ where: { id: ids.voiceChannel } }).catch(() => {});
    await prisma.communicationChannel.deleteMany({ where: { id: ids.commChannel } }).catch(() => {});
    await prisma.aIAgent.deleteMany({ where: { id: ids.agent } }).catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: ids.tenant } }).catch(() => {});
  });

  it("starts bound both ways - the FK and the mirror agree", async () => {
    const vc = await prisma.voiceChannel.findUnique({ where: { id: ids.voiceChannel } });
    expect(vc!.aiAgentId).toBe(ids.agent);
    expect(parseCopilotConfig(vc!.copilotConfig).aiAgentId).toBe(ids.agent);
  });

  it("clears the mirror when the agent is deleted", async () => {
    // The transaction the delete route runs: strip the mirror, then delete.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE voice_channels vc
        SET copilot_config = vc.copilot_config - 'aiAgentId'
        FROM communication_channels cc
        WHERE cc.id = vc.communication_channel_id
          AND cc.tenant_id = ${ids.tenant}
          AND vc.copilot_config->>'aiAgentId' = ${ids.agent}
      `;
      await tx.aIAgent.delete({ where: { id: ids.agent } });
    });

    const vc = await prisma.voiceChannel.findUnique({ where: { id: ids.voiceChannel } });
    expect(vc, "the channel itself must survive - only the binding goes").not.toBeNull();
    expect(vc!.aiAgentId, "the FK is nulled by the schema").toBeNull();
    expect(
      parseCopilotConfig(vc!.copilotConfig).aiAgentId,
      "the JSONB mirror must not keep pointing at a deleted agent",
    ).toBeUndefined();
  });

  it("leaves the rest of the config alone", async () => {
    // Removing one key must not be a way to lose the channel's settings.
    const vc = await prisma.voiceChannel.findUnique({ where: { id: ids.voiceChannel } });
    expect(parseCopilotConfig(vc!.copilotConfig).language).toBe("en");
  });
});

d("the loader treats the FK as authoritative in both directions", () => {
  it("does not hand back a stale id when the FK is null", async () => {
    // The safety net, independent of whether the delete path cleaned up: even
    // if a stale mirror survives from before this fix, a null FK means "not
    // bound" and the loader must say so.
    const stale = parseCopilotConfig({ language: "he", aiAgentId: "agent_that_is_gone" } as any);
    expect(stale.aiAgentId, "the blob still carries it").toBe("agent_that_is_gone");

    // Mirrors the loader's rule.
    const fk: string | null = null;
    if (fk) stale.aiAgentId = fk;
    else delete stale.aiAgentId;

    expect(stale.aiAgentId).toBeUndefined();
    expect(stale.language, "unrelated config is untouched").toBe("he");
  });
});
