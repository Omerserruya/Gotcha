/**
 * PLUG-AND-PLAY PROOF — a COMPLETELY FOREIGN domain (Commerce) runs through the
 * cognitive kernel with ZERO changes to any cognitive component.
 *
 * Commerce has nothing in common with Calendar: stock quantities, order placement,
 * insufficient-stock failure — not times, availability, or bookings. If the kernel
 * (loop / Reasoner / Oracle assembler / Facts / guardrails / renderer) needed ANY
 * edit to support it, this file could not exist as it does: a SINGLE new file that
 * imports only the public contract types + `resolveExecution` + the registry
 * interface, defines its own contracts + bindings + oracle, registers itself, and
 * is driven by the unchanged `runAgentLoop`.
 *
 * The whole Commerce capability is defined INLINE here to make the claim
 * unambiguous: adding a capability = contracts + bindings + oracle provider +
 * register. Nothing else.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  resolveExecution,
  EMPTY_AGENT_MEMORY,
  type OperationContract,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutionTrace,
  type RuntimeBindings,
  type AvailableOperation,
  type CapabilityWorldView,
  type ReasonerInput,
  type ReasonerProvider,
  type ReasonerProviderResult,
} from "@chatcenter/shared";
import { runAgentLoop } from "../services/agent-loop/agent-loop";
import { setReasonerProvider } from "../services/reasoner";
import {
  clearCapabilities,
  registerCapability,
  ensureCapabilitiesRegistered,
  type CapabilityRegistration,
} from "../services/capability-plane";

// ─────────────────────────────────────────────────────────────────────────────
// 1. RUNTIME CONTRACTS (business model — foreign domain, no calendar semantics)
// ─────────────────────────────────────────────────────────────────────────────
const COMMERCE_CONTRACTS: Record<string, OperationContract> = {
  CHECK_STOCK: {
    id: "CHECK_STOCK",
    capability: "COMMERCE",
    effect: "read",
    meaning: "check the available stock for a product",
    params: [{ key: "product_sku", meaning: "the product identifier", required: true }],
    outcome: "the available quantity for the product",
    success: { id: "stock_known", statement: "the stock level is known" },
    invariants: [
      {
        id: "product_exists",
        statement: "the product exists in the catalog",
        strength: "MUST",
        checkpoint: "PRE",
        enforcement: "RUNTIME_VERIFIED",
        onUnsatisfied: { kind: "FAILED", reason: "unknown_product" },
      },
    ],
    failureModes: ["unknown_product"],
    recoveryPosture: { retries: "none", alternatives: false, askCustomer: true, escalate: "last_resort" },
    approval: "none",
  },
  PLACE_ORDER: {
    id: "PLACE_ORDER",
    capability: "COMMERCE",
    effect: "write",
    meaning: "place an order for a quantity of a product",
    params: [
      { key: "product_sku", meaning: "the product identifier", required: true },
      { key: "quantity", meaning: "how many units to order", required: true },
    ],
    outcome: "a confirmed order for the product",
    success: { id: "order_placed", statement: "an order exists for the product" },
    invariants: [
      {
        id: "product_exists",
        statement: "the product exists in the catalog",
        strength: "MUST",
        checkpoint: "PRE",
        enforcement: "RUNTIME_VERIFIED",
        onUnsatisfied: { kind: "FAILED", reason: "unknown_product" },
      },
      {
        id: "sufficient_stock",
        statement: "there is enough stock to fulfil the order",
        strength: "MUST",
        checkpoint: "PRE",
        enforcement: "RUNTIME_VERIFIED",
        onUnsatisfied: { kind: "FAILED", reason: "insufficient_stock" },
      },
      {
        id: "order_created",
        statement: "the order was created",
        strength: "MUST",
        checkpoint: "POST",
        enforcement: "RUNTIME_VERIFIED",
      },
    ],
    failureModes: ["unknown_product", "insufficient_stock"],
    recoveryPosture: { retries: "none", alternatives: true, askCustomer: true, escalate: "last_resort" },
    approval: "none",
    dedupKey: ["product_sku"],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. In-memory domain store (the "provider", below the Runtime)
// ─────────────────────────────────────────────────────────────────────────────
interface CommerceStore {
  stock: Map<string, number>;
  orders: { sku: string; qty: number; id: string }[];
}
const makeStore = (): CommerceStore => ({ stock: new Map([["WIDGET", 5]]), orders: [] });

// ─────────────────────────────────────────────────────────────────────────────
// 3. RUNTIME BINDINGS (rules-as-verifiers + strategy) over the store
// ─────────────────────────────────────────────────────────────────────────────
function buildBindings(store: CommerceStore, emitTrace: (t: ExecutionTrace) => void): RuntimeBindings {
  const sku = (req: ExecutionRequest) => String(req.params.product_sku ?? "");
  const qty = (req: ExecutionRequest) => Number(req.params.quantity ?? 0);
  return {
    verifiers: {
      product_exists: (req) => store.stock.has(sku(req)),
      sufficient_stock: (req) => (store.stock.get(sku(req)) ?? 0) >= qty(req),
      stock_known: () => true,
      order_placed: (req) => store.orders.some((o) => o.sku === sku(req)),
      order_created: (req) => store.orders.some((o) => o.sku === sku(req)),
    },
    runSatisfier: async () => ({ ok: false, reason: "no_satisfier" }),
    executeStrategy: async (contract, req) => {
      if (contract.id === "CHECK_STOCK") {
        return { ok: true, outcome: `stock: ${store.stock.get(sku(req)) ?? 0}`, data: { available: store.stock.get(sku(req)) ?? 0 } };
      }
      if (contract.id === "PLACE_ORDER") {
        const s = sku(req);
        const q = qty(req);
        store.stock.set(s, (store.stock.get(s) ?? 0) - q);
        const id = `ord_${store.orders.length + 1}`;
        store.orders.push({ sku: s, qty: q, id });
        return { ok: true, outcome: `ordered ${q} × ${s}`, data: { orderId: id } };
      }
      return { ok: false, reason: `unhandled:${contract.id}` };
    },
    emitTrace,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE CAPABILITY (ownsOperation + describeWorld oracle + execute)
// ─────────────────────────────────────────────────────────────────────────────
function toAvailableOperation(c: OperationContract): AvailableOperation {
  return { name: c.id, meaning: c.meaning, params: c.params.map((p) => ({ name: p.key, meaning: p.meaning, required: !!p.required })) };
}

function commerceCapability(store: CommerceStore): CapabilityRegistration {
  const CONTRACTS = Object.values(COMMERCE_CONTRACTS);
  return {
    name: "COMMERCE",
    ownsOperation: (op) => op in COMMERCE_CONTRACTS,
    async describeWorld(): Promise<CapabilityWorldView> {
      const products = [...store.stock.entries()].map(([sku, available]) => ({ sku, available }));
      return {
        capability: "COMMERCE",
        summary: `${products.length} product(s) in catalog; ${store.orders.length} order(s) placed.`,
        facts: { products, orderCount: store.orders.length },
        operations: CONTRACTS.map(toAvailableOperation),
      };
    },
    async execute(req: ExecutionRequest) {
      const contract = COMMERCE_CONTRACTS[req.operation];
      if (!contract) {
        const result: ExecutionResult = { status: "BLOCKED", reason: `unknown_operation:${req.operation}` };
        return { result, trace: emptyTrace(req, "BLOCKED", result.reason) };
      }
      let captured: ExecutionTrace | undefined;
      try {
        const result = await resolveExecution(contract, req, buildBindings(store, (t) => (captured = t)));
        return { result, trace: captured ?? emptyTrace(req, result.status) };
      } catch (err: any) {
        const reason = `runtime_error:${String(err?.message || err)}`;
        return { result: { status: "FAILED", reason, recoverable: true }, trace: emptyTrace(req, "FAILED", reason) };
      }
    },
    loopPolicy: { maxIterations: 6 },
  };
}

function emptyTrace(req: ExecutionRequest, result: ExecutionTrace["result"], reason?: string): ExecutionTrace {
  return { operation: req.operation, capability: "COMMERCE", mode: req.mode, invariants: [], optimizations: [], executed: false, result, reason };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scripted Reasoner — reasons GENERICALLY over the world (no domain code)
// ─────────────────────────────────────────────────────────────────────────────
function commerceReasoner(): ReasonerProvider {
  return {
    name: "scripted", model: "s",
    async reason(input: ReasonerInput): Promise<ReasonerProviderResult> {
      const com = input.facts.world.find((w) => w.capability === "COMMERCE");
      const orderCount = Number((com?.facts as any)?.orderCount ?? 0);
      const wm = input.context.workingMemory;
      const checked = !!wm?.iterations?.some((it) => it.proposedOperation === "CHECK_STOCK");
      const lastFailed = wm?.iterations?.some((it) => it.runtimeResult === "FAILED");

      let decision;
      if (orderCount > 0) decision = { type: "FINISH" as const, reason: "order placed" };
      else if (lastFailed) decision = { type: "ESCALATE" as const, reason: "cannot fulfil order" };
      else if (checked) decision = { type: "EXECUTE" as const, operation: "PLACE_ORDER", params: { product_sku: "WIDGET", quantity: 2 } };
      else decision = { type: "EXECUTE" as const, operation: "CHECK_STOCK", params: { product_sku: "WIDGET" } };

      return {
        output: {
          read: { situation: "customer wants widgets", customerState: "ready", goal: null, missingInformation: [], rationale: "fulfil order" },
          decision,
          replyIntent: { purpose: "confirm", keyPoints: ["Your order is placed."] },
          memoryUpdate: EMPTY_AGENT_MEMORY,
        },
      };
    },
  };
}

const baseInputs = {
  tenantId: "t1", conversationId: "c1", turnId: "turn1", aiAgentId: "a1",
  customerExternalId: "cust1", mode: "autonomous" as const,
  customer: { id: "cust1", knownFields: {}, identityResolved: true },
  permissions: { allowedOperations: [] },
  transcript: [{ role: "customer" as const, text: "I want to order 2 widgets" }],
  mission: { businessDescription: "Store clerk" },
  goal: null,
  memory: EMPTY_AGENT_MEMORY,
};

describe("PLUG-AND-PLAY: a foreign Commerce domain runs on the UNCHANGED kernel", () => {
  afterEach(() => {
    clearCapabilities();
    setReasonerProvider(null);
  });

  it("check stock → place order → finish (real runtime, real mutation)", async () => {
    ensureCapabilitiesRegistered();
    clearCapabilities();
    const store = makeStore();
    registerCapability(commerceCapability(store));
    setReasonerProvider(commerceReasoner());

    const result = await runAgentLoop({ ...baseInputs });

    expect(result.terminationReason).toBe("finish");
    expect(result.iterations).toBe(3);
    expect(store.orders.length).toBe(1); // real mutation via real resolveExecution
    expect(store.stock.get("WIDGET")).toBe(3); // 5 - 2, foreign quantity semantics
    expect(result.workingMemory.iterations.map((i) => i.proposedOperation).filter(Boolean)).toEqual(["CHECK_STOCK", "PLACE_ORDER"]);
    expect(result.reply && result.reply.length).toBeTruthy();
  });

  it("insufficient stock → runtime FAILED re-enters → Reasoner escalates (no mutation)", async () => {
    ensureCapabilitiesRegistered();
    clearCapabilities();
    const store = makeStore();
    registerCapability(commerceCapability(store));
    // Reasoner tries to order more than exists; the Runtime's invariant fails; the
    // observation re-enters; the Reasoner (not the loop) decides to escalate.
    setReasonerProvider({
      name: "s", model: "s",
      async reason(input) {
        const wm = input.context.workingMemory;
        const failed = wm?.iterations?.some((it) => it.runtimeResult === "FAILED");
        const decision = failed
          ? { type: "ESCALATE" as const, reason: "insufficient stock" }
          : { type: "EXECUTE" as const, operation: "PLACE_ORDER", params: { product_sku: "WIDGET", quantity: 999 } };
        return {
          output: {
            read: { situation: "x", customerState: "y", goal: null, missingInformation: [], rationale: "r" },
            decision, replyIntent: { purpose: "p", keyPoints: ["I couldn't complete that order."] }, memoryUpdate: EMPTY_AGENT_MEMORY,
          },
        };
      },
    });

    const result = await runAgentLoop({ ...baseInputs, conversationId: "c2" });

    expect(store.orders.length).toBe(0); // invariant blocked the write
    expect(result.terminationReason).toBe("escalate"); // Reasoner's decision, not the loop's
  });
});
