/**
 * Disconnecting an integration, once, in one place.
 *
 * There were two disconnect routes and they disagreed in opposite directions:
 *
 *   `POST /:slug/disconnect` (integrations.ts)
 *       deleted every tenant tool row, and cleared credentials.
 *   `POST /connectors/:slug/disconnect` (connectors-admin.ts)
 *       preserved the tool rows, and left the credentials live.
 *
 * So depending on which button an operator pressed, they either lost their
 * configuration or kept a working access token on an integration the UI now
 * called disconnected. Each route had half the right answer and neither had
 * both, which is what happens when a lifecycle transition is written twice.
 *
 * The correct behaviour, in one function:
 *
 *   - credentials are cleared, always. A disconnected integration must not hold
 *     a usable token.
 *   - tenant tool POLICY is preserved, always. Disconnecting a provider is not
 *     consent to reset how the tenant has configured it. An operator who
 *     disabled a tool, disconnected to re-grant scopes, and reconnected was
 *     getting that tool back enabled - their decision was never overridden, the
 *     record of it was deleted.
 *   - the transition is dated, attributed and audited.
 *
 * Nothing executes afterwards, and that is enforced somewhere else on purpose:
 * the AI's tool surface requires a CONNECTED integration. Availability and
 * policy are different questions - "may this tenant use this tool" and "can we
 * reach the provider right now" - and answering the first by destroying the
 * answer to the second is what created this defect.
 */

import { prisma } from "@chatcenter/shared";

export interface DisconnectResult {
  tenantIntegrationId: string;
  status: "DISCONNECTED";
  /** Policy rows deliberately left in place, for the audit line and the caller. */
  policyRowsPreserved: number;
  credentialsCleared: boolean;
}

/**
 * Take a connection out of service without taking the tenant's configuration
 * with it.
 *
 * Idempotent: disconnecting an already-disconnected integration re-clears the
 * credentials and re-stamps the transition rather than failing, because the
 * only thing worse than a duplicate disconnect is one that half-completed and
 * cannot be repeated.
 */
export async function disconnectIntegration(opts: {
  tenantId: string;
  tenantIntegrationId: string;
  slug: string;
  actorId?: string | null;
}): Promise<DisconnectResult> {
  const policyRowsPreserved = await prisma.tenantTool.count({
    where: { tenantId: opts.tenantId, tenantIntegrationId: opts.tenantIntegrationId },
  });

  await prisma.tenantIntegration.update({
    where: { id: opts.tenantIntegrationId },
    data: {
      status: "DISCONNECTED",
      // Non-negotiable. The other disconnect route used to skip this, leaving a
      // live access token on an integration the product described as
      // disconnected.
      credentials: {},
      disconnectedAt: new Date(),
      disconnectedBy: opts.actorId ?? null,
    },
  });

  await recordDisconnectAudit({
    tenantId: opts.tenantId,
    slug: opts.slug,
    tenantIntegrationId: opts.tenantIntegrationId,
    actorId: opts.actorId ?? null,
    policyRowsPreserved,
  });

  return {
    tenantIntegrationId: opts.tenantIntegrationId,
    status: "DISCONNECTED",
    policyRowsPreserved,
    credentialsCleared: true,
  };
}

/**
 * Record that a connection was ended deliberately.
 *
 * This matters more now than it did before: the policy rows survive, so
 * somebody reading them later sees configuration for an integration that is not
 * connected, and needs to be able to tell "an operator ended this" from "this
 * never worked". Never throws - a failed audit write must not leave a
 * half-disconnected integration holding credentials.
 *
 * No credential material is recorded. The metadata is deliberately limited to
 * what a person needs to understand the event.
 */
export async function recordDisconnectAudit(opts: {
  tenantId: string;
  slug: string;
  tenantIntegrationId: string;
  actorId: string | null;
  policyRowsPreserved?: number;
}): Promise<void> {
  try {
    await (prisma as any).auditLog.create({
      data: {
        tenantId: opts.tenantId,
        actorType: opts.actorId ? "user" : "system",
        actorId: opts.actorId ?? undefined,
        action: "integration.disconnected",
        targetType: "tenant_integration",
        targetId: opts.tenantIntegrationId,
        metadata: {
          slug: opts.slug,
          credentialsCleared: true,
          policyPreserved: true,
          policyRowsPreserved: opts.policyRowsPreserved ?? null,
        } as any,
      },
    });
  } catch (err: any) {
    console.error("[integrations] disconnect audit write failed:", err?.message);
  }
}
