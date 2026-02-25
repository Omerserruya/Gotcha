import { prisma } from "@chatcenter/shared";

type TokenLogType = "chat" | "embedding" | "suggestion" | "summary" | "classification";

export async function logTokenUsage(params: {
  tenantId: string;
  type: TokenLogType;
  model: string;
  promptTokens: number;
  completionTokens?: number;
  totalTokens: number;
  conversationId?: string;
  documentId?: string;
  metadata?: Record<string, any>;
}): Promise<void> {
  try {
    await prisma.tokenLog.create({
      data: {
        tenantId: params.tenantId,
        type: params.type,
        model: params.model,
        promptTokens: params.promptTokens,
        completionTokens: params.completionTokens ?? 0,
        totalTokens: params.totalTokens,
        conversationId: params.conversationId,
        documentId: params.documentId,
        metadata: params.metadata,
      },
    });
  } catch (err: any) {
    console.error("[TokenLog] Failed to log token usage:", err.message);
  }
}
