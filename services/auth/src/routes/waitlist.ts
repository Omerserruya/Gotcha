import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma, validate, authenticate, requireSystemAdmin } from "@chatcenter/shared";
import { sendWaitlistWelcomeEmail } from "../services/notification.service";
import { notifyNewLead } from "../services/lead-alert.service";

const router = Router();

// ─── Public: Submit Waitlist Entry ──────────────────────────

// email/role/companySize are optional at the SCHEMA level so the lightweight
// landing form (name + phone + industry) can submit against the same endpoint.
// The full early-access form is held to a stricter rule below. The `email`
// column is NOT NULL + unique, so phone-first leads get a synthetic,
// clearly-marked key.
const waitlistSchema = z.object({
  firstName: z.string().min(1).max(100),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(30).optional().default(""),
  company: z.string().max(200).optional().default(""),
  // The full form's industry picker. It used to be sent by the client and
  // dropped silently here - zod strips what it does not declare - so every
  // early-access lead lost the one field that says what business they run.
  // It lands in `company`, which is where the landing form already puts the
  // industry label and which the full form never otherwise fills.
  companyDomain: z.string().max(200).optional().default(""),
  role: z.string().max(100).optional().default(""),
  companySize: z.string().max(50).optional().default(""),
  frustration: z.string().max(500).optional().default(""),
  source: z.string().max(100).optional(),
});

/** The source the full /early-access wizard submits under. */
const FULL_FORM_SOURCE = "early-access-form";

router.post("/", validate(waitlistSchema), async (req: Request, res: Response): Promise<void> => {
  const { firstName, email, phone, company, companyDomain, role, companySize, frustration, source } = req.body;

  const cleanPhone = (phone || "").trim();
  const realEmail = email ? email.toLowerCase().trim() : "";
  const leadSource = source || FULL_FORM_SOURCE;

  // The full wizard asks for both and makes both mandatory in the UI. Enforced
  // again here so the rule holds for anything posting straight at the endpoint:
  // a lead with only one of the two is a lead half the team cannot follow up on.
  if (leadSource === FULL_FORM_SOURCE) {
    if (!realEmail) {
      res.status(400).json({ error: "Email is required." });
      return;
    }
    if (cleanPhone.replace(/\D/g, "").length < 7) {
      res.status(400).json({ error: "A valid phone number is required." });
      return;
    }
  }

  // Dedup by email when given, otherwise by phone.
  if (realEmail) {
    const existing = await prisma.waitlistEntry.findUnique({ where: { email: realEmail } });
    if (existing) {
      res.status(409).json({ error: "This email is already on the waitlist." });
      return;
    }
  } else if (cleanPhone) {
    const existingByPhone = await prisma.waitlistEntry.findFirst({ where: { phone: cleanPhone } });
    if (existingByPhone) {
      res.status(409).json({ error: "This phone number is already on the waitlist." });
      return;
    }
  }

  // The email column is required + unique; synthesize a placeholder for phone-first leads.
  const handleKey = cleanPhone ? cleanPhone.replace(/\D/g, "") : Date.now().toString(36);
  const emailKey = realEmail || `lead-${handleKey}@no-email.gotcha`;

  const entry = await prisma.waitlistEntry.create({
    data: {
      firstName: firstName.trim(),
      email: emailKey,
      phone: cleanPhone || null,
      company: company || companyDomain || null,
      role: role || "",
      companySize: companySize || "",
      frustration: frustration || null,
      source: leadSource,
    },
  });

  // Get position and send welcome email only when we have a real address (non-blocking)
  const position = await prisma.waitlistEntry.count();
  if (realEmail) sendWaitlistWelcomeEmail(entry.email, entry.firstName, position).catch(() => {});

  // Alert the team on every configured channel (non-blocking). `realEmail`
  // rather than entry.email: a phone-first lead carries a synthetic
  // lead-…@no-email.gotcha key that exists to satisfy a unique column, and
  // showing it in the alert reads as an address someone can write to.
  notifyNewLead({
    firstName: entry.firstName,
    email: realEmail,
    phone: entry.phone,
    company: entry.company,
    role: entry.role,
    companySize: entry.companySize,
    frustration: entry.frustration,
    source: entry.source,
    createdAt: entry.createdAt,
  }).catch(() => {});

  res.status(201).json({ data: { id: entry.id } });
});

// ═══════════════════════════════════════════════════════════════
// Admin endpoints (SYSTEM_ADMIN only)
// ═══════════════════════════════════════════════════════════════

// ─── List Leads (search, filter, sort, paginate) ────────────

router.get("/leads", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  try {
    const search = (req.query.search as string) || "";
    const status = req.query.status as string || "";
    const sortBy = (req.query.sortBy as string) || "createdAt";
    const sortOrder = (req.query.sortOrder as string) === "asc" ? "asc" : "desc";
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 25));
    const skip = (page - 1) * limit;

    const where: any = {};

    // Search across name, email, company
    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { company: { contains: search, mode: "insensitive" } },
      ];
    }

    // Filter by status
    if (status && ["NEW", "CONTACTED", "APPROVED", "REJECTED"].includes(status)) {
      where.status = status;
    }

    // Determine sort field
    const allowedSorts: Record<string, string> = {
      createdAt: "createdAt",
      email: "email",
      firstName: "firstName",
      status: "status",
      leadScore: "leadScore",
    };
    const orderField = allowedSorts[sortBy] || "createdAt";

    const [leads, total] = await Promise.all([
      prisma.waitlistEntry.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [orderField]: sortOrder },
      }),
      prisma.waitlistEntry.count({ where }),
    ]);

    res.json({
      data: leads,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("List leads error:", err);
    res.status(500).json({ error: "Failed to list leads" });
  }
});

// ─── Lead Stats ─────────────────────────────────────────────

router.get("/leads/stats", authenticate, requireSystemAdmin(), async (_req: Request, res: Response): Promise<void> => {
  try {
    const [total, byStatus, recentWeek] = await Promise.all([
      prisma.waitlistEntry.count(),
      prisma.waitlistEntry.groupBy({
        by: ["status"],
        _count: { id: true },
      }),
      prisma.waitlistEntry.count({
        where: { createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
      }),
    ]);

    const statusCounts: Record<string, number> = {};
    byStatus.forEach((s) => { statusCounts[s.status] = s._count.id; });

    res.json({
      data: {
        total,
        new: statusCounts.NEW || 0,
        contacted: statusCounts.CONTACTED || 0,
        approved: statusCounts.APPROVED || 0,
        rejected: statusCounts.REJECTED || 0,
        recentWeek,
      },
    });
  } catch (err) {
    console.error("Lead stats error:", err);
    res.status(500).json({ error: "Failed to get lead stats" });
  }
});

// ─── Export CSV ──────────────────────────────────────────────

router.get("/leads/export", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  try {
    const status = req.query.status as string || "";
    const where: any = {};
    if (status && ["NEW", "CONTACTED", "APPROVED", "REJECTED"].includes(status)) {
      where.status = status;
    }

    const leads = await prisma.waitlistEntry.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    const header = "ID,Name,Email,Phone,Company,Role,Company Size,Source,Status,Lead Score,Notes,Created At";
    const rows = leads.map((l) => {
      const escapeCsv = (val: string | null | undefined) => {
        if (!val) return "";
        if (val.includes(",") || val.includes('"') || val.includes("\n")) {
          return `"${val.replace(/"/g, '""')}"`;
        }
        return val;
      };
      return [
        l.id,
        escapeCsv(l.firstName),
        escapeCsv(l.email),
        escapeCsv(l.phone),
        escapeCsv(l.company),
        escapeCsv(l.role),
        escapeCsv(l.companySize),
        escapeCsv(l.source),
        l.status,
        l.leadScore,
        escapeCsv(l.notes),
        l.createdAt.toISOString(),
      ].join(",");
    });

    const csv = [header, ...rows].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=leads-${new Date().toISOString().split("T")[0]}.csv`);
    res.send(csv);
  } catch (err) {
    console.error("Export leads error:", err);
    res.status(500).json({ error: "Failed to export leads" });
  }
});

// ─── Update Lead (status, notes, leadScore) ─────────────────

const updateLeadSchema = z.object({
  status: z.enum(["NEW", "CONTACTED", "APPROVED", "REJECTED"]).optional(),
  notes: z.string().max(2000).optional(),
  leadScore: z.number().int().min(0).max(100).optional(),
});

router.patch("/leads/:id", authenticate, requireSystemAdmin(), validate(updateLeadSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const lead = await prisma.waitlistEntry.findUnique({ where: { id: req.params.id as string } });
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }

    const data: any = {};
    if (req.body.status !== undefined) data.status = req.body.status;
    if (req.body.notes !== undefined) data.notes = req.body.notes;
    if (req.body.leadScore !== undefined) data.leadScore = req.body.leadScore;

    // If approving, set convertedAt
    if (req.body.status === "APPROVED" && !lead.convertedAt) {
      data.convertedAt = new Date();
    }

    const updated = await prisma.waitlistEntry.update({
      where: { id: req.params.id as string },
      data,
    });

    res.json({ data: updated });
  } catch (err) {
    console.error("Update lead error:", err);
    res.status(500).json({ error: "Failed to update lead" });
  }
});

// ─── Get Single Lead ────────────────────────────────────────

router.get("/leads/:id", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  try {
    const lead = await prisma.waitlistEntry.findUnique({ where: { id: req.params.id as string } });
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    res.json({ data: lead });
  } catch (err) {
    console.error("Get lead error:", err);
    res.status(500).json({ error: "Failed to get lead" });
  }
});

// ─── Delete Lead ────────────────────────────────────────────

router.delete("/leads/:id", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  try {
    const lead = await prisma.waitlistEntry.findUnique({ where: { id: req.params.id as string } });
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }

    await prisma.waitlistEntry.delete({ where: { id: req.params.id as string } });
    res.json({ data: { deleted: true } });
  } catch (err) {
    console.error("Delete lead error:", err);
    res.status(500).json({ error: "Failed to delete lead" });
  }
});

export default router;
