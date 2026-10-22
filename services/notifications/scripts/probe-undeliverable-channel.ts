/**
 * A channel nobody can deliver must FAIL VISIBLY, not succeed silently.
 *
 * The old branch logged `console.info(... not implemented yet - skipped)` and
 * returned. An admin ticking a WhatsApp box got a saved preference, a screen
 * showing it on, and no message - with nothing in any table to find later.
 *
 * Four cases, and the first is the one the old code passed:
 *
 *   1 undeliverable  a preference with an unknown channel produces a
 *                    notificationLog row with status="failed". THE OLD CODE
 *                    PASSES EVERY OTHER CASE HERE AND FAILS ONLY THIS ONE.
 *   2 reason         the row says WHY, naming the channel and what is
 *                    deliverable - an operator who finds it must not have to
 *                    read the dispatcher to understand it.
 *   3 siblings       the deliverable channels on the SAME preference still
 *                    went out. Recording a failure must not abort the rest.
 *   4 honest set     `isDeliverableChannel` agrees with the switch arms that
 *                    actually exist. A second list is a second chance to offer
 *                    a box that does nothing.
 */
import { prisma } from "@chatcenter/shared";
import {
  DELIVERABLE_CHANNELS,
  isDeliverableChannel,
} from "../src/services/notification-engine.service";

const T = process.env.PROBE_TENANT ?? "cms4ug98n0004chmrp4lv6ujl";
const TAG = "probe.undeliverable";

async function cleanup() {
  const log = (w: string) => (e: any) => console.warn(`cleanup ${w}:`, e?.message ?? e);
  await (prisma as any).notificationLog
    .deleteMany({ where: { tenantId: T, type: TAG } })
    .catch(log("logs"));
  await (prisma as any).notificationPreference
    .deleteMany({ where: { tenantId: T, eventType: TAG } })
    .catch(log("prefs"));
  await (prisma as any).inAppNotification
    .deleteMany({ where: { tenantId: T, eventType: TAG } })
    .catch(log("in-app"));
}

async function main() {
  await cleanup();
  const fail: string[] = [];

  // 4 - the exported set must match the arms that exist. Read the source
  // rather than trusting the constant: the whole point is that they agree.
  const src = await import("fs").then((fs) =>
    fs.readFileSync(new URL("../src/services/notification-engine.service.ts", import.meta.url), "utf-8"),
  );
  const arms = [...src.matchAll(/channel === "([a-z_]+)"/g)].map((m) => m[1]).sort();
  const declared = [...DELIVERABLE_CHANNELS].sort();
  console.log(`4 honest set   switch arms=[${arms}] declared=[${declared}]`);
  if (JSON.stringify(arms) !== JSON.stringify(declared)) {
    fail.push(`DELIVERABLE_CHANNELS [${declared}] disagrees with the switch arms [${arms}]`);
  }
  if (isDeliverableChannel("whatsapp")) fail.push("whatsapp reported deliverable but has no arm");
  if (!isDeliverableChannel("in_app")) fail.push("in_app reported undeliverable");

  // 1-3 - drive the real engine with a preference carrying one deliverable
  // channel and one that is not.
  const users = await prisma.user.findMany({ where: { tenantId: T }, select: { id: true }, take: 1 });
  if (users.length === 0) {
    console.log("FAIL: no user in the probe tenant");
    process.exit(1);
  }
  const uid = users[0]!.id;

  await (prisma as any).notificationPreference.create({
    data: {
      tenantId: T,
      eventType: TAG,
      enabled: true,
      channels: ["in_app", "whatsapp"],
      recipients: { type: "users", userIds: [uid] },
      priority: "HIGH",
    },
  });

  // A UNIQUE PAYLOAD PER RUN, and this is not cosmetic. `processEvent` calls
  // `shouldDeliver(tenantId, type, data)` - a Redis-backed dedupe that drops a
  // repeat of the SAME event payload. With `data: {}` the first run delivers
  // and every run afterwards is silently suppressed, so the probe passes once
  // and then reports a code regression that is really its own cache.
  //
  // Found by mutation-testing: reverting to the old branch AND restoring it
  // both produced all-zeros, which no code change could explain.
  const { processEvent } = await import("../src/services/notification-engine.service");
  const nonce = `${Date.now()}-${Math.random()}`;
  await processEvent({
    id: `${TAG}-${nonce}`,
    type: TAG,
    tenantId: T,
    data: { nonce },
    metadata: { timestamp: new Date().toISOString() },
  } as any);

  const failedRows = await (prisma as any).notificationLog.findMany({
    where: { tenantId: T, type: TAG, status: "failed" },
  });
  const row = failedRows[0];
  console.log(`1 undeliverable failed rows=${failedRows.length} channel=${row?.channel ?? "-"}`);
  if (failedRows.length !== 1) fail.push(`expected 1 failed row, got ${failedRows.length} - a silent skip leaves 0`);
  if (row && row.channel !== "whatsapp") fail.push(`failed row is for "${row.channel}", expected whatsapp`);

  const reason = String(row?.error ?? "");
  console.log(`2 reason        names channel=${reason.includes("whatsapp")} names deliverable=${reason.includes("in_app")}`);
  if (!reason.includes("whatsapp")) fail.push("the recorded reason does not name the channel");
  if (!reason.includes("in_app")) fail.push("the recorded reason does not say what IS deliverable");

  const inApp = await (prisma as any).inAppNotification.count({ where: { tenantId: T, eventType: TAG } });
  console.log(`3 siblings      in_app delivered=${inApp} (expect 1 - the failure must not abort the rest)`);
  if (inApp !== 1) fail.push(`in_app delivery count ${inApp} != 1 - recording the failure broke the sibling channel`);

  console.log(fail.length === 0 ? "PASS" : `FAIL: ${fail.join(" | ")}`);
  await cleanup();
  process.exit(fail.length === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("PROBE ERROR", e); await cleanup(); process.exit(1); });
