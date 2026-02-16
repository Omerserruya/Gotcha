import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const CHANNEL = "chatcenter:events";

let pubClient: Redis | null = null;

function getPubClient(): Redis {
  if (!pubClient) {
    pubClient = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  }
  return pubClient;
}

export interface ServiceEvent {
  event: string;
  tenantId: string;
  data: any;
}

export async function publishEvent(event: ServiceEvent): Promise<void> {
  const client = getPubClient();
  await client.publish(CHANNEL, JSON.stringify(event));
}

export function subscribeToEvents(
  handler: (event: ServiceEvent) => void
): Redis {
  const sub = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  sub.subscribe(CHANNEL);
  sub.on("message", (_channel: string, message: string) => {
    try {
      const parsed = JSON.parse(message) as ServiceEvent;
      handler(parsed);
    } catch (err) {
      console.error("Event bus parse error:", err);
    }
  });
  return sub;
}

export async function closeEventBus(): Promise<void> {
  if (pubClient) {
    await pubClient.quit();
    pubClient = null;
  }
}
