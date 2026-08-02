/**
 * Capabilities - registration entry point. Registers the built-in DOMAIN
 * capabilities once per process. The Agent Loop / Oracle assembler call
 * `ensureCapabilitiesRegistered()` before use; it is idempotent and cheap.
 *
 * Adding a domain capability = import it here and register it. Nothing else
 * changes. Kernel truth (identity, billing, permissions) is NOT a capability -
 * the Oracle assembler reads it directly.
 */

import { registerCapability } from "./registry";
import { CalendarCapability } from "./calendar.capability";
import { CrmCapability } from "./crm.capability";
import { KnowledgeCapability } from "./knowledge.capability";
import { CustomCapability } from "./custom.capability";

let registered = false;

export function ensureCapabilitiesRegistered(): void {
  if (registered) return;
  registerCapability(CalendarCapability); // self-describing world + executor + policy
  registerCapability(CrmCapability); // wraps getCrmAdapter() - kernel unchanged
  registerCapability(KnowledgeCapability); // wraps the production RAG - kernel unchanged
  registerCapability(CustomCapability); // tenant-defined API/DB tools - kernel unchanged
  // Future: registerCapability(CommerceCapability), …
  registered = true;
}

export * from "./registry";
