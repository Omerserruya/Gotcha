import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma, signToken, generateRefreshToken } from "@chatcenter/shared";

const SALT_ROUNDS = 10;

async function getDepartmentInfo(userId: string) {
  const member = await prisma.departmentMember.findUnique({
    where: { userId },
    include: { department: { select: { id: true, name: true } } },
  });
  if (!member) return {};
  return {
    departmentId: member.departmentId,
    departmentRole: member.departmentRole,
    departmentName: member.department.name,
  };
}

export async function register(tenantId: string, email: string, password: string, name: string, role: string = "AGENT") {
  const existing = await prisma.user.findFirst({ where: { tenantId, email } });
  if (existing) throw new Error("User with this email already exists for this tenant");

  const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await prisma.user.create({
    data: { tenantId, email, password: hashedPassword, name, role: role as any },
  });

  const deptInfo = await getDepartmentInfo(user.id);
  const token = signToken({
    userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email,
    departmentId: deptInfo.departmentId, departmentRole: deptInfo.departmentRole,
  });

  const refresh = generateRefreshToken();
  await prisma.refreshToken.create({
    data: { token: refresh.token, userId: user.id, tenantId: user.tenantId, expiresAt: refresh.expiresAt },
  });

  return { token, refreshToken: refresh.token, user: { id: user.id, email: user.email, name: user.name, role: user.role, tenantId: user.tenantId, ...deptInfo } };
}

export async function login(tenantId: string, email: string, password: string) {
  const user = await prisma.user.findFirst({ where: { tenantId, email, isActive: true } });
  if (!user) throw new Error("Invalid email or password");

  const isValid = await bcrypt.compare(password, user.password);
  if (!isValid) throw new Error("Invalid email or password");

  // Get tenant status for onboarding redirect
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { status: true },
  });

  const deptInfo = await getDepartmentInfo(user.id);
  const token = signToken({
    userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email,
    departmentId: deptInfo.departmentId, departmentRole: deptInfo.departmentRole,
  });

  const refresh = generateRefreshToken();
  await prisma.refreshToken.create({
    data: { token: refresh.token, userId: user.id, tenantId: user.tenantId, expiresAt: refresh.expiresAt },
  });

  // Update tenant status from PENDING_ADMIN_SETUP to PENDING_ONBOARDING on first admin login
  if (user.role === "ADMIN" && tenant?.status === "PENDING_ADMIN_SETUP") {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { status: "PENDING_ONBOARDING" },
    });
  }

  return {
    token,
    refreshToken: refresh.token,
    user: { id: user.id, email: user.email, name: user.name, role: user.role, tenantId: user.tenantId, ...deptInfo },
    tenantStatus: tenant?.status || "ACTIVE",
  };
}

export async function changePassword(tenantId: string, userId: string, currentPassword: string, newPassword: string) {
  const user = await prisma.user.findFirst({ where: { tenantId, id: userId } });
  if (!user) throw new Error("User not found");

  const isValid = await bcrypt.compare(currentPassword, user.password);
  if (!isValid) throw new Error("Invalid current password");

  const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await prisma.user.update({ where: { id: userId }, data: { password: hashedPassword } });

  return { success: true };
}

export async function createPasswordResetToken(tenantId: string, email: string): Promise<{ token: string; userId: string } | null> {
  const user = await prisma.user.findFirst({ where: { tenantId, email } });
  if (!user) return null;

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await prisma.magicLink.create({
    data: { token, userId: user.id, tenantId, expiresAt },
  });

  return { token, userId: user.id };
}

export async function resetPassword(token: string, newPassword: string) {
  const magicLink = await prisma.magicLink.findUnique({ where: { token } });
  if (!magicLink) throw new Error("Invalid or expired token");
  if (magicLink.usedAt) throw new Error("Token has already been used");
  if (new Date() > magicLink.expiresAt) throw new Error("Token has expired");

  const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);

  await prisma.$transaction([
    prisma.user.update({ where: { id: magicLink.userId }, data: { password: hashedPassword } }),
    prisma.magicLink.update({ where: { id: magicLink.id }, data: { usedAt: new Date() } }),
  ]);

  return { success: true };
}
