import bcrypt from "bcryptjs";
import { prisma, signToken } from "@chatcenter/shared";

const SALT_ROUNDS = 10;

export async function register(tenantId: string, email: string, password: string, name: string, role: string = "AGENT") {
  const existing = await prisma.user.findFirst({ where: { tenantId, email } });
  if (existing) throw new Error("User with this email already exists for this tenant");

  const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await prisma.user.create({
    data: { tenantId, email, password: hashedPassword, name, role: role as any },
  });

  const token = signToken({ userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email });
  return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role, tenantId: user.tenantId } };
}

export async function login(tenantId: string, email: string, password: string) {
  const user = await prisma.user.findFirst({ where: { tenantId, email, isActive: true } });
  if (!user) throw new Error("Invalid email or password");

  const isValid = await bcrypt.compare(password, user.password);
  if (!isValid) throw new Error("Invalid email or password");

  const token = signToken({ userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email });
  return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role, tenantId: user.tenantId } };
}
