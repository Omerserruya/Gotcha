import type { Transcript } from "../stt/provider";

export interface VoiceStreamBody {
  type: "voice_stream";
  tenantId: string;
  conversationId: string;
  messages: Transcript[];
}

export interface PostVoiceStreamOptions {
  aiServiceUrl: string;
  internalKey: string;
  tenantId: string;
  idempotencyKey: string;
  timeoutMs: number;
}

export interface PostResult {
  ok: boolean;
  status: number;
  body?: unknown;
  error?: string;
}

export type AiAssistClient = (
  body: VoiceStreamBody,
  opts: PostVoiceStreamOptions
) => Promise<PostResult>;

export const postVoiceStream: AiAssistClient = async (
  body: VoiceStreamBody,
  opts: PostVoiceStreamOptions
): Promise<PostResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  try {
    const res = await fetch(`${opts.aiServiceUrl}/api/ai-assist/voice`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.internalKey}`,
        "X-Tenant-Id": opts.tenantId,
        "X-Idempotency-Key": opts.idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const responseBody = await res.json().catch(() => undefined);
    return { ok: res.ok, status: res.status, body: responseBody };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("aborted"))
    ) {
      return { ok: false, status: 0, error: "timeout" };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, error: message };
  } finally {
    clearTimeout(timer);
  }
};
