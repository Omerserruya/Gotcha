/**
 * Contact-created-from-the-channel probe.
 *
 * Goes through the REAL path: enqueues `IncomingMessageJob`s onto the actual
 * `incoming-messages` queue and lets the running worker process them. Nothing
 * here calls `ensureContactForInbound` directly - that would prove the function
 * works and say nothing about whether the worker uses it.
 *
 * Four cases, chosen so a wrong answer looks wrong rather than merely absent:
 *
 *   1  new WHATSAPP sender   -> contact created, `phone` == externalId
 *   2  new SHOPIFY sender    -> contact created, `phone` IS NULL
 *                               (an opaque channel id must not land in a column
 *                               other code dials and matches on)
 *   3  case 1's sender again -> still exactly ONE row, not two
 *   4  a MERGED-AWAY sender  -> resolves to the survivor, NO new row
 *
 * Cases 1 and 2 differ only in channel, so a create that ignored channel when
 * deciding `phone` passes one and fails the other. Case 3 is the unique
 * constraint doing its job. Case 4 is the merge-following that comes free from
 * reusing the resolver, and is the one a naive `upsert`-only implementation
 * would fail - it would resurrect the merged row.
 *
 * CONTROL: every case asserts the MESSAGE was persisted. Contact creation must
 * never be able to fail the message, and a probe that only counted contacts
 * would pass just as happily if the worker had started dropping messages.
 *
 * Run inside the incoming-worker container (no source bind mount, so the image
 * must be rebuilt first):
 *     docker compose exec -u root incoming-worker mkdir -p /app/services/incoming-worker/scripts
 *     docker compose cp services/incoming-worker/scripts/probe-contact-on-inbound.ts \
 *         incoming-worker:/app/services/incoming-worker/scripts/probe-contact-on-inbound.ts
 *     docker compose exec incoming-worker sh -lc "cd /app && npx tsx services/incoming-worker/scripts/probe-contact-on-inbound.ts"
 */
import { prisma, incomingMessageQueue } from "@chatcenter/shared";

const TENANT = process.env.PROBE_TENANT ?? "cms4ug98n0004chmrp4lv6ujl";
const WA_ACCOUNT = process.env.PROBE_WA_ACCOUNT ?? "cms1pp6n00006nsdtuy55g9sl";
const SHOP_ACCOUNT = process.env.PROBE_SHOP_ACCOUNT ?? "cms5ozp2y00167lc9xm44tagi";

const WA_SENDER = "972500000941";
const SHOP_SENDER = "d54c-shopify-visitor-941";
const MERGED_SENDER = "972500000942";
const SIBLING_SENDER = "972500000943";   // staff-entered contact already holds this number
const TAG = "probe-contact-on-inbound";

async function enqueue(channel: string, channelAccountId: string, senderId: string, n: number) {
  await incomingMessageQueue.add("inbound", {
    tenantId: TENANT,
    channel,
    channelAccountId,
    normalizedMessage: {
      externalMessageId: `${TAG}-${senderId}-${n}`,
      senderId,
      senderDisplayName: `Probe ${senderId}`,
      timestamp: new Date().toISOString(),
      contentType: "text",
      body: `${TAG} message ${n}`,
      messageType: "text",
    },
  } as any);
}

async function contactsFor(externalId: string) {
  return prisma.contact.findMany({ where: { tenantId: TENANT, externalId } });
}

async function cleanup() {
  const ids = [WA_SENDER, SHOP_SENDER, MERGED_SENDER, SIBLING_SENDER, `${SIBLING_SENDER}-staff`];
  const log = (w: string) => (e: any) => console.warn(`cleanup ${w}:`, e?.message ?? e);
  await prisma.message
    .deleteMany({ where: { tenantId: TENANT, externalMessageId: { startsWith: TAG } } })
    .catch(log("messages"));
  await prisma.conversation
    .deleteMany({ where: { tenantId: TENANT, customerExternalId: { in: ids } } })
    .catch(log("conversations"));
  await prisma.contact
    .deleteMany({ where: { tenantId: TENANT, externalId: { in: [...ids, `${MERGED_SENDER}-survivor`] } } })
    .catch(log("contacts"));
}

async function main() {
  await cleanup();
  const fail: string[] = [];

  // Case 4 needs its rows BEFORE the message arrives: a survivor, and a
  // merged-away row pointing at it that carries the sender's identifier.
  const survivor = await prisma.contact.create({
    data: { tenantId: TENANT, channel: "WHATSAPP", externalId: `${MERGED_SENDER}-survivor`, displayName: "Survivor" } as any,
  });
  await prisma.contact.create({
    data: {
      tenantId: TENANT, channel: "WHATSAPP", externalId: MERGED_SENDER,
      displayName: "Merged away", mergedIntoId: survivor.id,
    } as any,
  });

  // Case 5 needs a staff-entered contact holding the SAME phone on a DIFFERENT
  // channel, created before the message arrives and carrying no personId.
  const staffRow = await prisma.contact.create({
    data: {
      tenantId: TENANT, channel: "WEBCHAT", externalId: `${SIBLING_SENDER}-staff`,
      displayName: "Entered by staff", phone: SIBLING_SENDER, phoneVerified: true,
    } as any,
  });

  await enqueue("WHATSAPP", WA_ACCOUNT, WA_SENDER, 1);
  await enqueue("SHOPIFY_LIVE_CHAT", SHOP_ACCOUNT, SHOP_SENDER, 1);
  await enqueue("WHATSAPP", WA_ACCOUNT, MERGED_SENDER, 1);
  await enqueue("WHATSAPP", WA_ACCOUNT, SIBLING_SENDER, 1);
  // Wait for those three before sending the duplicate, so case 3 tests a
  // SECOND message against an existing row rather than two racing creates.
  await new Promise((r) => setTimeout(r, 6000));
  await enqueue("WHATSAPP", WA_ACCOUNT, WA_SENDER, 2);
  await new Promise((r) => setTimeout(r, 5000));

  // 1 - WhatsApp: created, phone populated from the identifier.
  const wa = await contactsFor(WA_SENDER);
  const w = wa[0];
  console.log(`1 whatsapp   rows=${wa.length} phone=${w?.phone ?? "null"} source=${w?.source ?? "-"} lastInteractionAt=${w?.lastInteractionAt ? "set" : "null"}`);
  if (wa.length !== 1) fail.push(`whatsapp rows ${wa.length} != 1`);
  if (w?.phone !== WA_SENDER) fail.push(`whatsapp phone ${w?.phone} != ${WA_SENDER}`);
  if (w?.source !== "inbound:whatsapp") fail.push(`whatsapp source ${w?.source}`);
  if (!w?.lastInteractionAt) fail.push("whatsapp lastInteractionAt null");

  // 2 - Shopify: created, phone NOT populated.
  const sh = await contactsFor(SHOP_SENDER);
  const s = sh[0];
  console.log(`2 shopify    rows=${sh.length} phone=${s?.phone ?? "null"} source=${s?.source ?? "-"}`);
  if (sh.length !== 1) fail.push(`shopify rows ${sh.length} != 1`);
  if (s?.phone != null) fail.push(`shopify phone should be null, got ${s?.phone}`);

  // 3 - second message from case 1's sender: still one row.
  console.log(`3 duplicate  rows=${wa.length} (after 2 messages)`);
  if (wa.length !== 1) fail.push(`duplicate created: ${wa.length} rows`);

  // 4 - merged-away sender: no THIRD row, and the pointer still points.
  const mg = await contactsFor(MERGED_SENDER);
  const m = mg[0];
  console.log(`4 merged     rows=${mg.length} mergedIntoId=${m?.mergedIntoId ? "intact" : "CLEARED"}`);
  if (mg.length !== 1) fail.push(`merged sender produced ${mg.length} rows`);
  if (m?.mergedIntoId !== survivor.id) fail.push("merge pointer lost");

  // 5 - the point of the whole change: a WhatsApp sender and a staff-entered
  // contact holding the same number end up as ONE person.
  const sib = await contactsFor(SIBLING_SENDER);
  const staffAfter = await prisma.contact.findUnique({ where: { id: staffRow.id } });
  const shared = !!sib[0]?.personId && sib[0]?.personId === staffAfter?.personId;
  console.log(`5 unified    wa.personId=${sib[0]?.personId ? "set" : "null"} staff.personId=${staffAfter?.personId ? "set" : "null"} shared=${shared}`);
  if (!sib[0]?.personId) fail.push("whatsapp sibling got no personId");
  if (!shared) fail.push("personId not shared with the staff-entered contact");

  // 6 - PHONE-BLIND CHECK. The shopify contact has no phone, so nothing may be
  // matched and it must get NO personId. An implementation that called
  // unifyContact unconditionally would mint one here regardless - that function
  // assigns a fresh personId even when it finds no sibling at all.
  console.log(`6 no-phone   shopify.personId=${s?.personId ?? "null"}`);
  if (s?.personId) fail.push(`shopify contact got a personId (${s.personId}) with no phone to match on`);

  // CONTROL - the messages themselves. A probe that only counted contacts would
  // pass identically if the worker had begun dropping messages.
  const msgs = await prisma.message.count({ where: { tenantId: TENANT, externalMessageId: { startsWith: TAG } } });
  console.log(`C control    messages persisted=${msgs} (expect 5)`);
  if (msgs !== 5) fail.push(`messages persisted ${msgs} != 5`);

  console.log(fail.length === 0 ? "PASS" : `FAIL: ${fail.join(" | ")}`);
  await cleanup();
  process.exit(fail.length === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("PROBE ERROR", e);
  await cleanup();
  process.exit(1);
});
