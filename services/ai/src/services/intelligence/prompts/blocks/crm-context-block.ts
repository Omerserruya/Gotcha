/**
 * CRM context block.
 *
 * Phase 3 ships a stub that accepts a flat key/value snapshot from the
 * caller and renders it as compact lines. Lazy-loaded once per call (the
 * runner constructs the snapshot before the first turn and reuses it).
 *
 * Concrete CRM-extractor wiring lands later — for now the runner can pass
 * an empty snapshot and the block degrades gracefully.
 */
export interface CrmSnapshot {
  customerName?: string;
  contactEmail?: string;
  contactPhone?: string;
  /** Free-form key/value pairs the runner has discovered so far. */
  extra?: Record<string, string | number | boolean | null>;
}

export function crmContextBlock(snap?: CrmSnapshot): string {
  if (!snap || isEmpty(snap)) {
    return `CRM CONTEXT: no prior CRM data loaded for this call.`;
  }
  const lines: string[] = ["CRM CONTEXT:"];
  if (snap.customerName) lines.push(`  customer.name = ${snap.customerName}`);
  if (snap.contactEmail) lines.push(`  contact.email = ${snap.contactEmail}`);
  if (snap.contactPhone) lines.push(`  contact.phone = ${snap.contactPhone}`);
  if (snap.extra) {
    for (const [k, v] of Object.entries(snap.extra)) {
      if (v === null || v === undefined) continue;
      lines.push(`  ${k} = ${String(v)}`);
    }
  }
  return lines.join("\n");
}

function isEmpty(s: CrmSnapshot): boolean {
  if (s.customerName || s.contactEmail || s.contactPhone) return false;
  if (s.extra && Object.keys(s.extra).length > 0) return false;
  return true;
}
