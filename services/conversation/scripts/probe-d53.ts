/**
 * D53 probe. Two sockets, one tenant, two agents.
 *
 * THE ASSERTION IS B'S ABSENCE. That agent A receives its own call proves
 * nothing - it was receiving everything before this change. The test is that
 * agent B, connected and authenticated at the same moment, does NOT receive
 * agent A's transcript.
 *
 * Deliberately asymmetric so a wrong answer looks wrong: the two conversations
 * are in the SAME department, so only the assignment distinguishes them. A
 * rule that fell back to department scope would pass a same-agent fixture and
 * fail here.
 *
 * Also runs a NEGATIVE CONTROL: an event with no channel must reach BOTH
 * sockets. Without it, a client that silently failed to attach a listener would
 * produce the same zero as perfect isolation and read as a pass.
 *
 * HOW TO RUN. Inside the conversation container:
 *     npx tsx services/conversation/scripts/probe-d53.ts
 * It needs `socket.io-client` and `engine.io-client`, which that image does not
 * carry (they are frontend dependencies). Copy them in first - they are already
 * vendored in this repo, so this installs nothing:
 *     docker compose cp frontend/node_modules/socket.io-client    conversation:/app/node_modules/socket.io-client
 *     docker compose cp frontend/node_modules/engine.io-client    conversation:/app/node_modules/engine.io-client
 *     docker compose cp frontend/node_modules/xmlhttprequest-ssl  conversation:/app/node_modules/xmlhttprequest-ssl
 * The scripts dir does not exist in the image and /app is not writable by the
 * service user, so create it first:
 *     docker compose exec -u root conversation mkdir -p /app/services/conversation/scripts
 *     docker compose cp services/conversation/scripts/probe-d53.ts conversation:/app/services/conversation/scripts/probe-d53.ts
 * Recreating the container drops all of this again.
 *
 * Creates and deletes its own fixtures, including two User rows - assignedAgentId
 * is a real foreign key. They carry no Authentik identity and cannot log in.
 *
 * Result on 2026-09-21, dev:
 *     JOIN  a→own     {"ok":true}
 *     JOIN  a→other   {"ok":false,"reason":"not_permitted"}
 *     JOIN  b→own     {"ok":true}
 *     JOIN  b→other   {"ok":false,"reason":"not_permitted"}
 *     DELIVERY  targeted:   A received 1  ·  B received 0
 *     CONTROL   untargeted: A received 1  ·  B received 1
 */
import { io as ioClient, type Socket } from "socket.io-client";
import { prisma, issueRealtimeTicket, publishEvent } from "@chatcenter/shared";

const TENANT = process.env.PROBE_TENANT ?? "cms4ug98n0004chmrp4lv6ujl";
const URL = "http://localhost:4002";

const convA = "d53probe-conv-a";
const convB = "d53probe-conv-b";
const deptId = "d53probe-dept";
const userA = "d53probe-user-a";
const userB = "d53probe-user-b";

function principal(userId: string) {
  // Non-ADMIN with a department: the only shape the visibility filter applies
  // to. An ADMIN would legitimately see both and prove nothing.
  return { userId, tenantId: TENANT, role: "AGENT", email: `${userId}@probe.invalid`, departmentId: deptId } as any;
}

async function connect(userId: string): Promise<Socket> {
  const { ticket } = await issueRealtimeTicket(principal(userId));
  const s = ioClient(URL, { auth: { ticket }, transports: ["websocket"] });
  await new Promise<void>((res, rej) => {
    s.on("connect", () => res());
    s.on("connect_error", (e) => rej(e));
    setTimeout(() => rej(new Error(`${userId}: connect timeout`)), 5000);
  });
  return s;
}

function subscribe(s: Socket, conversationId: string): Promise<any> {
  return new Promise((res) => {
    s.emit("subscribe:conversation", conversationId, (r: any) => res(r));
    setTimeout(() => res({ ok: false, reason: "no-ack" }), 3000);
  });
}

async function cleanup() {
  // tenantId on EVERY tenant-scoped where: the shared TenantGuard rejects a
  // clause without one. The first version of this omitted it and swallowed the
  // rejection, so cleanup silently did nothing and the next run collided on its
  // own leftovers. Errors are logged, not swallowed, for the same reason.
  const log = (what: string) => (e: any) => console.warn(`cleanup ${what}:`, e?.message ?? e);
  await prisma.conversation
    .deleteMany({ where: { tenantId: TENANT, id: { in: [convA, convB] } } })
    .catch(log("conversations"));
  await prisma.department
    .deleteMany({ where: { tenantId: TENANT, id: deptId } })
    .catch(log("department"));
  await prisma.user
    .deleteMany({ where: { tenantId: TENANT, id: { in: [userA, userB] } } })
    .catch(log("users"));
  await prisma.identity
    .deleteMany({ where: { id: { in: [`${userA}-idn`, `${userB}-idn`] } } })
    .catch(log("identities"));
}

async function main() {
  await cleanup();
  await prisma.department.create({ data: { id: deptId, tenantId: TENANT, name: "D53 Probe" } as any });
  // assignedAgentId is a real FK, so the two agents need rows. They carry no
  // Authentik identity and therefore cannot log in; the probe deletes them.
  for (const u of [userA, userB]) {
    await prisma.identity.create({ data: { id: `${u}-idn`, email: `${u}@probe.invalid`, name: u } as any });
    await prisma.user.create({
      data: { id: u, tenantId: TENANT, identityId: `${u}-idn`, role: "AGENT", email: `${u}@probe.invalid`, name: u } as any,
    });
  }
  for (const [id, agent] of [[convA, userA], [convB, userB]] as const) {
    await prisma.conversation.create({
      data: {
        id, tenantId: TENANT, channel: "WHATSAPP", customerExternalId: `d53-${id}`,
        status: "OPEN", assignedAgentId: agent, departmentId: deptId,
      } as any,
    });
  }

  const [a, b] = await Promise.all([connect(userA), connect(userB)]);

  // Who may join what.
  const results = {
    aJoinsOwn: await subscribe(a, convA),
    aJoinsOther: await subscribe(a, convB),
    bJoinsOwn: await subscribe(b, convB),
    bJoinsOther: await subscribe(b, convA),
  };
  console.log("JOIN  a→own    ", JSON.stringify(results.aJoinsOwn));
  console.log("JOIN  a→other  ", JSON.stringify(results.aJoinsOther));
  console.log("JOIN  b→own    ", JSON.stringify(results.bJoinsOwn));
  console.log("JOIN  b→other  ", JSON.stringify(results.bJoinsOther));

  // What actually arrives. Both sockets listen; only A is in conv A's room.
  let aGot = 0;
  let bGot = 0;
  a.on("voice.transcript", () => { aGot += 1; });
  b.on("voice.transcript", () => { bGot += 1; });

  await publishEvent({
    event: "voice.transcript",
    tenantId: TENANT,
    data: {
      conversationId: convA, channel: `conv:${convA}`,
      speaker: "customer", text: "probe utterance for agent A", isFinal: true, seq: 1, ts: Date.now(),
    },
  });

  // Generous: a false PASS here would come from the event never being
  // published at all, so the A-count is what proves the probe ran.
  await new Promise((r) => setTimeout(r, 2000));

  console.log(`DELIVERY  targeted:   A received ${aGot}  ·  B received ${bGot}`);

  // NEGATIVE CONTROL. B receiving nothing above proves isolation only if B was
  // capable of receiving anything at all - a client that silently failed to
  // attach its listener would produce the same zero and look like a pass.
  // An event with NO channel takes the tenant-wide fallback, so both sockets
  // must get it. If this reads 0, the test above proved nothing.
  let aCtl = 0;
  let bCtl = 0;
  a.on("probe.control", () => { aCtl += 1; });
  b.on("probe.control", () => { bCtl += 1; });
  await publishEvent({ event: "probe.control", tenantId: TENANT, data: { note: "no channel - tenant fallback" } });
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`CONTROL   untargeted: A received ${aCtl}  ·  B received ${bCtl}`);

  const pass = aGot === 1 && bGot === 0 && aCtl === 1 && bCtl === 1
    && results.aJoinsOwn?.ok === true && results.bJoinsOwn?.ok === true
    && results.aJoinsOther?.ok === false && results.bJoinsOther?.ok === false;
  console.log(pass ? "PASS" : "FAIL");

  a.close(); b.close();
  await cleanup();
  process.exit(pass ? 0 : 1);
}

main().catch(async (e) => {
  console.error("PROBE ERROR", e);
  await cleanup();
  process.exit(1);
});
