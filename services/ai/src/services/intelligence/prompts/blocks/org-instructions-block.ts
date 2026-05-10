/**
 * Organization-level instructions injected into every prompt assembler.
 *
 * Phase 3 ships a minimal default block. Tenants can override via the
 * existing copilot config infrastructure in ai-assist.service.ts; that
 * integration is wired by the prompt assembler when copilot config is
 * available, otherwise the default below applies. No new tenant-config
 * model is introduced in Phase 3 (per "no additional abstractions").
 */
export function orgInstructionsBlock(opts?: {
  identity?: string;
  tone?: string;
  forbidden?: string[];
}): string {
  const parts: string[] = [];

  parts.push(
    opts?.identity
      ? `IDENTITY: ${opts.identity}`
      : `IDENTITY: You assist sales/support representatives at this organization on live calls. Stay neutral, professional, and never invent facts about pricing or product details that are not present in the provided context.`,
  );

  parts.push(
    opts?.tone
      ? `TONE: ${opts.tone}`
      : `TONE: Concise. No filler. No flattery toward the rep. No editorializing about the customer.`,
  );

  if (opts?.forbidden && opts.forbidden.length > 0) {
    parts.push(`FORBIDDEN ACTIONS: ${opts.forbidden.join(", ")}`);
  }

  return parts.join("\n\n");
}
