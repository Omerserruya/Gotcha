/**
 * CRM operation set - the vendor-NEUTRAL bridge between the Runtime and whichever CRM
 * CONNECTOR a tenant has connected (HubSpot / Salesforce / Zoho / …, resolved by
 * `getCrmAdapter`). The Connector - the vendor adapter - is the only thing that knows
 * an external system; this layer only declares generic Operations and their world.
 *
 * Three jobs, no more (no reasoning / planning / workflow / orchestration - those are
 * the Reasoner's):
 *   1. describeWorld()  - the world-state these operations own (is a CRM connected?).
 *   2. expose operations - the generic Operations available now (gated on connectivity).
 *   3. execute()        - hand an Operation to the shared Runtime, which reaches the
 *      resolved Connector (`CrmPort` → `getCrmAdapter().findCustomer`). Existing
 *      production code; wrapped, not reimplemented.
 *
 * The cognitive layer never learns a vendor exists; it only carries this opaque world
 * view. Registering this changes nothing in Reasoner/Loop/Runtime/Oracle/Prompt/
 * Guardrails - a new external system is exactly: contracts + port + bindings +
 * describeWorld + registerCapability, and the vendor Connector underneath.
 */

import type {
  AvailableOperation,
  CapabilityWorldView,
  ExecutionRequest,
  OperationContract,
} from "@chatcenter/shared";
import { CRM_CONTRACTS } from "../capability-runtime/crm.contracts";
import { executeCrmOperation } from "../capability-runtime/crm.runtime";
import { createProdCrmPort } from "../capability-runtime/crm.port.prod";
import type { CapabilityRegistration } from "./registry";

const port = createProdCrmPort();
const CONTRACTS: OperationContract[] = Object.values(CRM_CONTRACTS);

function toAvailableOperation(c: OperationContract): AvailableOperation {
  return {
    name: c.id,
    meaning: c.meaning,
    params: c.params.map((p) => ({ name: p.key, meaning: p.meaning, required: !!p.required })),
    businessPreconditions: c.invariants
      .filter((i) => i.checkpoint === "PRE" && i.strength === "MUST")
      .map((i) => i.statement),
  };
}

export const CrmCapability: CapabilityRegistration = {
  name: "CRM",

  ownsOperation: (op) => op in CRM_CONTRACTS,

  async describeWorld(ctx): Promise<CapabilityWorldView> {
    const { connected, vendor } = await port.connection({
      tenantId: ctx.tenantId,
      conversationId: ctx.conversationId,
      customerExternalId: ctx.customerExternalId,
      customerEmail: ctx.customerEmail,
    });
    return {
      capability: "CRM",
      summary: connected
        ? `A CRM (${vendor}) is connected; customer records can be searched.`
        : "No CRM is connected.",
      facts: { crmConnected: connected, crmVendor: vendor },
      operations: connected ? CONTRACTS.map(toAvailableOperation) : [],
    };
  },

  async execute(req: ExecutionRequest) {
    return executeCrmOperation(req, { port, strategyId: "crm" });
  },
};
