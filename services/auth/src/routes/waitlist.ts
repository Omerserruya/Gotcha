import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma, validate } from "@chatcenter/shared";
import { sendWaitlistWelcomeEmail } from "../services/notification.service";

const router = Router();

const waitlistSchema = z.object({
  firstName: z.string().min(1).max(100),
  email: z.string().email().max(255),
  phone: z.string().max(30).optional().default(""),
  role: z.string().min(1).max(100),
  companySize: z.string().min(1).max(50),
  frustration: z.string().max(500).optional().default(""),
});

router.post("/", validate(waitlistSchema), async (req: Request, res: Response): Promise<void> => {
  const { firstName, email, phone, role, companySize, frustration } = req.body;

  const normalizedEmail = email.toLowerCase().trim();

  const existing = await prisma.waitlistEntry.findUnique({
    where: { email: normalizedEmail },
  });

  if (existing) {
    res.status(409).json({ error: "This email is already on the waitlist." });
    return;
  }

  const entry = await prisma.waitlistEntry.create({
    data: {
      firstName: firstName.trim(),
      email: normalizedEmail,
      phone: phone || null,
      role,
      companySize,
      frustration: frustration || null,
    },
  });

  // Get position (total waitlist count) and send welcome email
  const position = await prisma.waitlistEntry.count();
  sendWaitlistWelcomeEmail(entry.email, entry.firstName, position).catch(() => {});

  res.status(201).json({ data: { id: entry.id } });
});

export default router;
