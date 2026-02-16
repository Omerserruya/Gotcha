import { Job } from "bullmq";
import { getRedis, createWorker, AnalyticsJob } from "@chatcenter/shared";

async function processAnalyticsEvent(job: Job<AnalyticsJob>): Promise<void> {
  const { tenantId, event, data, timestamp } = job.data;
  const redis = getRedis();
  const dateKey = timestamp.slice(0, 10);
  const hourKey = timestamp.slice(0, 13);

  switch (event) {
    case "message_received":
      await redis.hincrby(`analytics:${tenantId}:${dateKey}`, "messages_inbound", 1);
      await redis.hincrby(`analytics:${tenantId}:hourly:${hourKey}`, "messages_inbound", 1);
      await redis.hincrby(`analytics:${tenantId}:${dateKey}`, "messages_total", 1);
      break;
    case "message_sent":
      await redis.hincrby(`analytics:${tenantId}:${dateKey}`, "messages_outbound", 1);
      await redis.hincrby(`analytics:${tenantId}:hourly:${hourKey}`, "messages_outbound", 1);
      await redis.hincrby(`analytics:${tenantId}:${dateKey}`, "messages_total", 1);
      break;
    case "conversation_claimed": {
      const agentId = data.agentId;
      await redis.hincrby(`analytics:${tenantId}:agent:${agentId}:${dateKey}`, "claimed", 1);
      if (data.conversationId) {
        await redis.set(`analytics:${tenantId}:claim_time:${data.conversationId}`, timestamp, "EX", 86400 * 7);
      }
      break;
    }
    case "conversation_closed": {
      await redis.hincrby(`analytics:${tenantId}:${dateKey}`, "conversations_closed", 1);
      if (data.conversationId && data.createdAt) {
        const resolutionMs = new Date(timestamp).getTime() - new Date(data.createdAt).getTime();
        await redis.lpush(`analytics:${tenantId}:resolution_times:${dateKey}`, resolutionMs.toString());
        await redis.expire(`analytics:${tenantId}:resolution_times:${dateKey}`, 86400 * 30);
      }
      break;
    }
    case "agent_response": {
      if (data.conversationId && data.agentId) {
        const claimTime = await redis.get(`analytics:${tenantId}:claim_time:${data.conversationId}`);
        if (claimTime) {
          const responseMs = new Date(timestamp).getTime() - new Date(claimTime).getTime();
          await redis.lpush(`analytics:${tenantId}:response_times:${dateKey}`, responseMs.toString());
          await redis.expire(`analytics:${tenantId}:response_times:${dateKey}`, 86400 * 30);
          await redis.lpush(`analytics:${tenantId}:agent:${data.agentId}:response_times:${dateKey}`, responseMs.toString());
          await redis.expire(`analytics:${tenantId}:agent:${data.agentId}:response_times:${dateKey}`, 86400 * 30);
        }
      }
      break;
    }
  }
  await redis.expire(`analytics:${tenantId}:${dateKey}`, 86400 * 30);
  await redis.expire(`analytics:${tenantId}:hourly:${hourKey}`, 86400 * 7);
}

let worker: any;
export function startAnalyticsWorker() {
  worker = createWorker<AnalyticsJob>("analytics-aggregation", processAnalyticsEvent, 10);
  console.log("[analytics-service] Analytics worker started");
}
