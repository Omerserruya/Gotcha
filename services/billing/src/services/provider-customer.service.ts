/**
 * Provider customer mapping.
 *
 * The rule this exists to enforce: a tenant may never end up using another
 * tenant's provider customer. Matching on email would allow exactly that, since
 * two organizations can share a billing contact, so the mapping is keyed on
 * (provider, environment, billableEntityId) and carries a stable opaque
 * reference we generate ourselves.
 *
 * Environment is part of the identity on purpose. A simulator customer id is
 * meaningless against a production account, and silently reusing one would
 * point real charges at a fictional customer.
 */
import { randomBytes } from "crypto";
import { prisma } from "@chatcenter/shared";
import type { ProviderCustomer } from "@prisma/client";
import { isMock } from "../providers/icount-config";

/** Which provider environment the current configuration targets. */
export function providerEnvironment(): string {
  if (isMock()) return "mock";
  // The account in use is a simulator/trial account; that is not the same
  // thing as production, and the mapping must not be reused across them.
  return process.env.ICOUNT_ENVIRONMENT || "simulator";
}

/** Opaque, unguessable, ours. Sent to the provider so we can re-find a customer. */
export function newExternalCustomerReference(): string {
  return `gcust_${randomBytes(18).toString("base64url")}`;
}

export class ProviderCustomerConflict extends Error {
  constructor(readonly code: string, detail?: string) {
    super(`[billing] provider customer conflict: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "ProviderCustomerConflict";
  }
}

/**
 * The existing mapping for an entity, if any.
 *
 * Returns null rather than creating: creation requires a provider round trip,
 * and callers that only need to read must not trigger one.
 */
export async function findProviderCustomer(billableEntityId: string): Promise<ProviderCustomer | null> {
  return prisma.providerCustomer.findUnique({
    where: {
      provider_environment_billableEntityId: {
        provider: "ICOUNT",
        environment: providerEnvironment(),
        billableEntityId,
      },
    },
  });
}

/**
 * Record a provider customer mapping, idempotently.
 *
 * Safe to call concurrently: the unique index on
 * (provider, environment, billableEntityId) means a race resolves to one row,
 * and the loser reads the winner's rather than creating a duplicate.
 *
 * Refuses to re-point an entity at a different provider customer. That is
 * either a provider-side surprise or a bug, and silently overwriting it would
 * orphan whatever cards were stored against the old one.
 */
export async function recordProviderCustomer(input: {
  tenantId: string;
  billableEntityId: string;
  providerCustomerId: string;
  externalReference?: string;
}): Promise<ProviderCustomer> {
  const environment = providerEnvironment();

  const existing = await findProviderCustomer(input.billableEntityId);
  if (existing) {
    if (existing.providerCustomerId !== input.providerCustomerId) {
      throw new ProviderCustomerConflict(
        "entity_already_mapped_to_a_different_provider_customer",
        `entity ${input.billableEntityId}`,
      );
    }
    return prisma.providerCustomer.update({
      where: { id: existing.id },
      data: { lastSyncedAt: new Date(), status: "ACTIVE" },
    });
  }

  try {
    return await prisma.providerCustomer.create({
      data: {
        provider: "ICOUNT",
        environment,
        tenantId: input.tenantId,
        billableEntityId: input.billableEntityId,
        providerCustomerId: input.providerCustomerId,
        externalReference: input.externalReference ?? newExternalCustomerReference(),
        status: "ACTIVE",
        lastSyncedAt: new Date(),
      },
    });
  } catch (err: any) {
    if (err?.code !== "P2002") throw err;

    // Lost a race, or the provider customer is already claimed elsewhere.
    const mine = await findProviderCustomer(input.billableEntityId);
    if (mine) return mine;

    // The provider id belongs to a DIFFERENT entity. This is the cross-tenant
    // case, and it must fail loudly rather than be papered over.
    throw new ProviderCustomerConflict(
      "provider_customer_already_claimed_by_another_entity",
      input.providerCustomerId,
    );
  }
}

/** Mark a mapping stale so the next use re-resolves it against the provider. */
export async function markProviderCustomerStale(billableEntityId: string): Promise<void> {
  const existing = await findProviderCustomer(billableEntityId);
  if (!existing) return;
  await prisma.providerCustomer.update({ where: { id: existing.id }, data: { status: "STALE" } });
}

/**
 * Guard for any operation that charges or stores a card against a customer.
 *
 * Confirms the mapping belongs to the tenant being acted upon. Without it, a
 * bug that passed the wrong entity id would charge the wrong organization.
 */
export function assertOwnedBy(customer: ProviderCustomer, tenantId: string): void {
  if (customer.tenantId !== tenantId) {
    throw new ProviderCustomerConflict("provider_customer_belongs_to_another_tenant");
  }
}
