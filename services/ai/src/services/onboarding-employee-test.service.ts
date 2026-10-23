/**
 * The onboarding test of the go-live employee (2026-10-23): one question,
 * answered by the REAL runtime (runSandboxTurn -> generateAIBotReply) with
 * the employee's actual prompt, brand, knowledge and READ order tools.
 *
 * What makes it a test and not a conversation:
 *   - the sandbox conversation ("sandbox:<agent>:<user>", handledBy sandbox)
 *     is reset every time, so it holds only this turn's 2 messages; analytics,
 *     usage and the inbox already exclude sandbox conversations;
 *   - onboardingTest: read-only tool surface, no background CRM round, no
 *     CRM prefetch, agent loop off, store reads as the OWNER with the admin as
 *     the audited actor (reason "onboarding_test");
 *   - writes mode "safe": the dispatcher simulates anything that acts;
 *   - platform-paid: every model call of the turn is logged, never debited.
 * Nothing is sent: no channel, no outbox - the worker that sends is never involved.
 */
import { readDurableSetting, prisma } from "@chatcenter/shared";
import { runSandboxTurn } from "./sandbox-conversation.service";
import { platformPaidScope } from "./ai.service";
import { EMPLOYEE_SETTING, orderNumberIn } from "./onboarding-employee.service";

export { orderNumberIn };

export class EmployeeTestRefused extends Error {
  constructor(readonly code: string) { super(code); this.name = "EmployeeTestRefused"; }
}

const ORDER_TOOL = /\.(get_order|get_orders|order_lookup|search_orders|find_latest_order|get_customer_orders|list_orders|list_customer_orders|track_shipment|get_shipment_status|get_shipment_tracking|get_tracking_number|get_tracking_url|get_order_items)$/;
const FAILED = /^\s*(\{\s*"(error|ok)"\s*:\s*(false|")|error\b|access_denied|refused|tool_failed|failed)/i;

export interface EmployeeTestResult {
  answer: string;
  toolsUsed: Array<{ name: string; ok: boolean }>;
  sources: Array<{ title: string; sourceType: string | null }>;
  usedRealOrder: boolean;
  orderNumber: string | null;
  platform: string | null;
}

export async function testOnboardingEmployee(input: { tenantId: string; userId: string; question: string }): Promise<EmployeeTestResult> {
  const agentId = await readDurableSetting(input.tenantId, EMPLOYEE_SETTING);
  const agent = agentId
    ? await prisma.aIAgent.findFirst({ where: { id: agentId, tenantId: input.tenantId, status: "ACTIVE" }, select: { id: true } })
    : null;
  if (!agent) throw new EmployeeTestRefused("NOT_LIVE");

  const turn = await platformPaidScope.run({ reason: "onboarding_test" }, () =>
    runSandboxTurn({
      tenantId: input.tenantId,
      agentId: agent.id,
      userId: input.userId,
      message: input.question,
      writes: "safe",
      reset: true,
      onboardingTest: { actorUserId: input.userId },
    }),
  );
  if (!turn) throw new EmployeeTestRefused("NOT_LIVE");

  const toolsUsed = turn.toolCallLog.map((t) => ({ name: t.tool, ok: !FAILED.test(t.result) && t.decision !== "denied" }));
  let orderNumber: string | null = null;
  let platform: string | null = null;
  for (const t of turn.toolCallLog) {
    if (!ORDER_TOOL.test(t.tool) || FAILED.test(t.result)) continue;
    const n = orderNumberIn(t.result);
    if (n) { orderNumber = n; platform = t.tool.split(".")[0] ?? null; break; }
  }
  return {
    answer: turn.reply,
    toolsUsed,
    sources: turn.diagnostics.knowledgeUsed,
    usedRealOrder: !!orderNumber,
    orderNumber,
    platform,
  };
}
