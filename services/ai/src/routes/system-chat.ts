import { Router, Request, Response } from "express";
import { prisma, authenticate, requireSystemAdmin } from "@chatcenter/shared";
import { processDocument } from "../services/embedding.service";
import { deleteByDocumentId } from "../services/qdrant.service";
import { parseFile, isAllowedMimeType, resolveMimeType } from "../services/file-parser.service";
import { retrieveRelevantChunks, buildKnowledgeContext } from "../services/knowledge.service";
import { generateResponse, getDefaultModel } from "../services/ai.service";
import multer from "multer";

const router = Router();
const CHAT_MODEL = process.env.OPENAI_DEFAULT_MODEL || "gpt-4o-mini";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.use(authenticate, requireSystemAdmin());

// ─── Knowledge Base CRUD ────────────────────────────────────

router.get("/knowledge-bases", async (req: Request, res: Response) => {
  try {
    const knowledgeBases = await prisma.knowledgeBase.findMany({
      where: { tenantId: req.tenantId! },
      include: {
        documents: {
          select: { id: true, title: true, status: true, chunkCount: true, sourceType: true, createdAt: true },
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: knowledgeBases });
  } catch (err) {
    console.error("[SystemChat] List KB error:", err);
    res.status(500).json({ error: "Failed to list knowledge bases" });
  }
});

router.post("/knowledge-bases", async (req: Request, res: Response) => {
  try {
    const { name, description } = req.body;
    if (!name) { res.status(400).json({ error: "Name is required" }); return; }

    const kb = await prisma.knowledgeBase.create({
      data: { tenantId: req.tenantId!, name, description: description || null },
    });
    res.status(201).json({ data: kb });
  } catch (err) {
    console.error("[SystemChat] Create KB error:", err);
    res.status(500).json({ error: "Failed to create knowledge base" });
  }
});

router.patch("/knowledge-bases/:id", async (req: Request, res: Response) => {
  try {
    const kb = await prisma.knowledgeBase.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });
    if (!kb) { res.status(404).json({ error: "Knowledge base not found" }); return; }

    const { name, description, isActive } = req.body;
    const updated = await prisma.knowledgeBase.update({
      where: { id: kb.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
      },
    });
    res.json({ data: updated });
  } catch (err) {
    console.error("[SystemChat] Update KB error:", err);
    res.status(500).json({ error: "Failed to update knowledge base" });
  }
});

router.delete("/knowledge-bases/:id", async (req: Request, res: Response) => {
  try {
    const kb = await prisma.knowledgeBase.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });
    if (!kb) { res.status(404).json({ error: "Knowledge base not found" }); return; }

    await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    res.json({ data: { deleted: true } });
  } catch (err) {
    console.error("[SystemChat] Delete KB error:", err);
    res.status(500).json({ error: "Failed to delete knowledge base" });
  }
});

// ─── Document Management ────────────────────────────────────

router.post("/knowledge-bases/:id/documents", async (req: Request, res: Response) => {
  try {
    const kb = await prisma.knowledgeBase.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });
    if (!kb) { res.status(404).json({ error: "Knowledge base not found" }); return; }

    const { title, content, sourceType, sourceUrl } = req.body;
    if (!title || !content) { res.status(400).json({ error: "Title and content are required" }); return; }

    const doc = await prisma.knowledgeDocument.create({
      data: {
        knowledgeBaseId: kb.id,
        tenantId: req.tenantId!,
        title,
        content,
        sourceType: sourceType || "text",
        sourceUrl: sourceUrl || null,
        status: "pending",
      },
    });
    res.status(201).json({ data: doc });
  } catch (err) {
    console.error("[SystemChat] Upload document error:", err);
    res.status(500).json({ error: "Failed to upload document" });
  }
});

router.post("/knowledge-bases/:id/documents/upload", upload.single("file"), async (req: Request, res: Response) => {
  try {
    const kb = await prisma.knowledgeBase.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });
    if (!kb) { res.status(404).json({ error: "Knowledge base not found" }); return; }

    const file = req.file;
    if (!file) { res.status(400).json({ error: "File is required" }); return; }

    const mime = resolveMimeType(file.mimetype, file.originalname);
    if (!isAllowedMimeType(mime)) {
      res.status(400).json({ error: "Unsupported file type. Allowed: PDF, DOCX, DOC, MD, TXT" });
      return;
    }

    const title = (req.body.title as string) || file.originalname.replace(/\.[^.]+$/, "");
    const content = await parseFile(file.buffer, mime);

    if (!content.trim()) {
      res.status(400).json({ error: "Could not extract text from file" });
      return;
    }

    const doc = await prisma.knowledgeDocument.create({
      data: {
        knowledgeBaseId: kb.id,
        tenantId: req.tenantId!,
        title,
        content,
        sourceType: "file",
        status: "pending",
        metadata: {
          originalFilename: file.originalname,
          mimeType: file.mimetype,
          fileSize: file.size,
        },
      },
    });

    processDocument(doc.id).catch((err) => {
      console.error(`[SystemChat] Background processing failed for ${doc.id}:`, err.message);
    });

    res.status(201).json({ data: doc });
  } catch (err: any) {
    console.error("[SystemChat] File upload error:", err.message);
    res.status(500).json({ error: "Failed to upload file" });
  }
});

router.delete("/knowledge-bases/:id/documents/:docId", async (req: Request, res: Response) => {
  try {
    const doc = await prisma.knowledgeDocument.findFirst({
      where: { id: req.params.docId, knowledgeBaseId: req.params.id, tenantId: req.tenantId! },
    });
    if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

    await deleteByDocumentId(doc.id);
    await prisma.knowledgeDocument.delete({ where: { id: doc.id } });
    res.json({ data: { deleted: true } });
  } catch (err) {
    console.error("[SystemChat] Delete document error:", err);
    res.status(500).json({ error: "Failed to delete document" });
  }
});

router.post("/knowledge-bases/:id/documents/:docId/process", async (req: Request, res: Response) => {
  try {
    const doc = await prisma.knowledgeDocument.findFirst({
      where: { id: req.params.docId, knowledgeBaseId: req.params.id, tenantId: req.tenantId! },
    });
    if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

    processDocument(doc.id).catch((err) => {
      console.error(`[SystemChat] Background processing failed for ${doc.id}:`, err.message);
    });

    res.json({ data: { status: "processing", documentId: doc.id } });
  } catch (err) {
    console.error("[SystemChat] Process document error:", err);
    res.status(500).json({ error: "Failed to trigger processing" });
  }
});

// ─── Chat (RAG) ─────────────────────────────────────────────

router.post("/ask", async (req: Request, res: Response) => {
  try {
    const { question, history } = req.body;
    if (!question) { res.status(400).json({ error: "Question is required" }); return; }

    const chunks = await retrieveRelevantChunks(req.tenantId!, question, 5);
    const knowledgeContext = buildKnowledgeContext(chunks);

    const systemPrompt = `You are an AI assistant for the system administrator of a multi-tenant customer support platform called GOTCHA.
Answer questions based on the provided knowledge base context. Be accurate, concise, and helpful.
If the knowledge base context does not contain relevant information to answer the question, say so honestly rather than making up an answer.
${knowledgeContext ? `\n${knowledgeContext}` : "\nNo knowledge base documents are available. Let the user know they can upload documents to get contextual answers."}`;

    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: systemPrompt },
    ];

    if (Array.isArray(history)) {
      for (const msg of history) {
        if (msg.role === "user" || msg.role === "assistant") {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
    }

    messages.push({ role: "user", content: question });

    const result = await generateResponse({
      tenantId: req.tenantId!,
      model: CHAT_MODEL,
      messages,
      temperature: 0.3,
      maxTokens: 1024,
      metadata: { type: "chat" },
    });

    const answer = result.content || "I was unable to generate a response.";

    const sources = chunks
      .filter((c) => c.score > 0.3)
      .map((c) => ({ documentTitle: c.documentTitle, score: Math.round(c.score * 100) / 100 }));

    res.json({ answer, sources });
  } catch (err: any) {
    console.error("[SystemChat] Ask error:", err.message);
    res.status(500).json({ error: "Failed to generate answer" });
  }
});

// ─── Token Usage Analytics ───────────────────────────────────

router.get("/token-usage", async (req: Request, res: Response) => {
  try {
    const { from, to, type, groupBy } = req.query;
    const tenantId = (req.query.tenantId as string) || req.tenantId!;

    const where: any = { tenantId };
    if (type) where.type = type as string;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from as string);
      if (to) where.createdAt.lte = new Date(to as string);
    }

    // Totals
    const totals = await prisma.tokenLog.aggregate({
      where,
      _sum: { promptTokens: true, completionTokens: true, totalTokens: true },
      _count: { id: true },
    });

    // Breakdown by groupBy
    let breakdown: any[] = [];
    if (groupBy === "type") {
      breakdown = await prisma.tokenLog.groupBy({
        by: ["type"],
        where,
        orderBy: { type: "asc" },
        _sum: { promptTokens: true, completionTokens: true, totalTokens: true },
        _count: { id: true },
      });
    } else if (groupBy === "model") {
      breakdown = await prisma.tokenLog.groupBy({
        by: ["model"],
        where,
        orderBy: { model: "asc" },
        _sum: { promptTokens: true, completionTokens: true, totalTokens: true },
        _count: { id: true },
      });
    } else if (groupBy === "day") {
      // Raw query for daily aggregation
      const fromDate = from ? new Date(from as string) : new Date(Date.now() - 30 * 86400000);
      const toDate = to ? new Date(to as string) : new Date();
      if (type) {
        breakdown = await prisma.$queryRaw`
          SELECT DATE(created_at) as date,
                 SUM(prompt_tokens)::int as "promptTokens",
                 SUM(completion_tokens)::int as "completionTokens",
                 SUM(total_tokens)::int as "totalTokens",
                 COUNT(*)::int as count
          FROM token_logs
          WHERE tenant_id = ${tenantId}
            AND created_at >= ${fromDate}
            AND created_at <= ${toDate}
            AND type = ${type as string}
          GROUP BY DATE(created_at)
          ORDER BY date DESC
        `;
      } else {
        breakdown = await prisma.$queryRaw`
          SELECT DATE(created_at) as date,
                 SUM(prompt_tokens)::int as "promptTokens",
                 SUM(completion_tokens)::int as "completionTokens",
                 SUM(total_tokens)::int as "totalTokens",
                 COUNT(*)::int as count
          FROM token_logs
          WHERE tenant_id = ${tenantId}
            AND created_at >= ${fromDate}
            AND created_at <= ${toDate}
          GROUP BY DATE(created_at)
          ORDER BY date DESC
        `;
      }
    }

    res.json({
      totals: {
        promptTokens: totals._sum.promptTokens || 0,
        completionTokens: totals._sum.completionTokens || 0,
        totalTokens: totals._sum.totalTokens || 0,
        count: totals._count.id || 0,
      },
      breakdown,
    });
  } catch (err: any) {
    console.error("[SystemChat] Token usage error:", err.message);
    res.status(500).json({ error: "Failed to fetch token usage" });
  }
});

router.get("/token-usage/tenants", async (req: Request, res: Response) => {
  try {
    const { from, to } = req.query;
    const where: any = {};
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from as string);
      if (to) where.createdAt.lte = new Date(to as string);
    }

    const perTenant = await prisma.tokenLog.groupBy({
      by: ["tenantId"],
      where,
      orderBy: { tenantId: "asc" },
      _sum: { promptTokens: true, completionTokens: true, totalTokens: true },
      _count: { id: true },
    });

    // Enrich with tenant names
    const tenantIds = perTenant.map((t) => t.tenantId);
    const tenants = tenantIds.length > 0
      ? await prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true, slug: true } })
      : [];
    const tenantMap = Object.fromEntries(tenants.map((t) => [t.id, t]));

    const data = perTenant.map((row) => ({
      tenantId: row.tenantId,
      tenantName: tenantMap[row.tenantId]?.name || "Unknown",
      tenantSlug: tenantMap[row.tenantId]?.slug || "",
      promptTokens: row._sum.promptTokens || 0,
      completionTokens: row._sum.completionTokens || 0,
      totalTokens: row._sum.totalTokens || 0,
      count: row._count.id || 0,
    }));

    res.json({ data });
  } catch (err: any) {
    console.error("[SystemChat] Tenant token usage error:", err.message);
    res.status(500).json({ error: "Failed to fetch tenant token usage" });
  }
});

export default router;
