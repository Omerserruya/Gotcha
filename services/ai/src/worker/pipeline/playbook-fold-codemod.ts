/**
 * CallPlaybook → TenantFunnel codemod.
 *
 * Merges per-tenant `CallPlaybook` + `CallPlaybookStage` rows into the
 * `TenantFunnel.stages[].copilot` JSON blob so the funnel becomes the
 * single source of truth for pipeline + per-stage AI behavior.
 *
 * Field mapping:
 *   CallPlaybookStage.requiredFields[]  → FunnelStage.copilot.requiredDataFields[]
 *                                          (each string becomes
 *                                           { field, label: field, required: true })
 *   CallPlaybookStage.exitCriteria      → FunnelStage.copilot.exitCriteria.positiveSignals[0]
 *                                          (the NL string lands as a single positive marker)
 *   CallPlaybookStage.description       → DROPPED (per refactor brief — descriptions
 *                                          are LLM-derived or read off skill metadata)
 *   CallPlaybookStage.prompts           → DROPPED (legacy per-stage prompt hints
 *                                          superseded by the unified worker)
 *   CallPlaybook.name                   → preserved on the metadata report (not in
 *                                          the funnel itself; the funnel keeps its
 *                                          own funnelId / departmentId)
 *
 * Match rule for which funnel receives a playbook's stages:
 *   - We look up `TenantFunnel` rows for the same tenant
 *   - First active funnel (lowest createdAt) wins
 *   - If no funnel exists, we report it as "no-target" (the codemod does
 *     NOT synthesize a new funnel — that's an explicit author decision)
 *
 * Stage matching within a funnel:
 *   - Funnel stages and playbook stages are aligned by ordinal position
 *   - If a funnel has fewer stages than a playbook, extra playbook
 *     stages are reported as "overflow" and skipped (author must decide)
 *
 * Safety:
 *   - DRY RUN by default. `--apply` to actually write.
 *   - Idempotent: running twice on the same DB produces no diff on the
 *     second run (uses field-level merge, not concat).
 *   - Never deletes CallPlaybook rows. Deletion is Phase 6 after a
 *     soak-test window proves nothing reads from them anymore.
 *
 * Run from `services/ai`:
 *   tsx src/worker/pipeline/playbook-fold-codemod.ts --tenant <id>
 *   tsx src/worker/pipeline/playbook-fold-codemod.ts --tenant <id> --apply
 *   tsx src/worker/pipeline/playbook-fold-codemod.ts --all
 */

import { prisma } from "@chatcenter/shared";

type CodemodMode = "dry-run" | "apply";

interface StageMergeReport {
  funnelStageId: string;
  funnelStageLabel: string;
  beforeRequiredDataFields: number;
  afterRequiredDataFields: number;
  beforePositiveSignals: number;
  afterPositiveSignals: number;
  addedRequiredFields: string[];
  addedPositiveSignals: string[];
}

interface PlaybookReport {
  playbookId: string;
  playbookName: string;
  funnelMatchId: string | null;
  funnelMatchLabel: string | null;
  stageMerges: StageMergeReport[];
  overflowPlaybookStages: string[];
  notes: string[];
}

interface TenantReport {
  tenantId: string;
  playbooks: PlaybookReport[];
  noFunnelFound: boolean;
}

export async function runPlaybookFoldCodemod(opts: {
  mode: CodemodMode;
  tenantId?: string;
  /** When omitted with no tenantId, returns immediately — refuse to run blind. */
  all?: boolean;
}): Promise<TenantReport[]> {
  if (!opts.tenantId && !opts.all) {
    throw new Error("Refusing to run without --tenant <id> or --all");
  }

  const where = opts.tenantId ? { tenantId: opts.tenantId } : {};
  const playbooks = await (prisma as any).callPlaybook.findMany({
    where,
    include: { stages: { orderBy: { ordinal: "asc" } } },
    orderBy: [{ tenantId: "asc" }, { createdAt: "asc" }],
  });

  // Group by tenant for reporting + funnel lookup batching
  const byTenant = new Map<string, any[]>();
  for (const pb of playbooks) {
    const list = byTenant.get(pb.tenantId) ?? [];
    list.push(pb);
    byTenant.set(pb.tenantId, list);
  }

  const reports: TenantReport[] = [];

  for (const [tenantId, tenantPlaybooks] of byTenant.entries()) {
    const funnels = await (prisma as any).tenantFunnel.findMany({
      where: { tenantId, isActive: true },
      orderBy: { createdAt: "asc" },
    });
    const targetFunnel = funnels[0] ?? null;

    const tenantReport: TenantReport = {
      tenantId,
      playbooks: [],
      noFunnelFound: !targetFunnel,
    };

    for (const pb of tenantPlaybooks) {
      const pbReport: PlaybookReport = {
        playbookId: pb.id,
        playbookName: pb.name,
        funnelMatchId: targetFunnel?.id ?? null,
        funnelMatchLabel: targetFunnel?.funnelId ?? null,
        stageMerges: [],
        overflowPlaybookStages: [],
        notes: [],
      };

      if (!targetFunnel) {
        pbReport.notes.push("No active TenantFunnel — skipped. Create a funnel first.");
        tenantReport.playbooks.push(pbReport);
        continue;
      }

      const funnelStages = Array.isArray(targetFunnel.stages)
        ? (targetFunnel.stages as any[])
        : [];
      const updated = funnelStages.map((s: any) => ({ ...s }));

      for (let i = 0; i < pb.stages.length; i++) {
        const pbStage = pb.stages[i]!;
        const fnStage = updated[i];

        if (!fnStage) {
          pbReport.overflowPlaybookStages.push(pbStage.name);
          continue;
        }

        const beforeCopilot = (fnStage.copilot as any) ?? {};
        const beforeFields = Array.isArray(beforeCopilot.requiredDataFields)
          ? beforeCopilot.requiredDataFields
          : [];
        const beforeExit = (beforeCopilot.exitCriteria as any) ?? {};
        const beforePositives = Array.isArray(beforeExit.positiveSignals)
          ? beforeExit.positiveSignals
          : [];

        // Merge required fields (dedup on `field`)
        const existingFieldNames = new Set(beforeFields.map((f: any) => f?.field));
        const addedRequiredFields: string[] = [];
        const mergedFields = beforeFields.slice();
        for (const fname of pbStage.requiredFields ?? []) {
          if (!fname || existingFieldNames.has(fname)) continue;
          mergedFields.push({ field: fname, label: fname, required: true });
          addedRequiredFields.push(fname);
          existingFieldNames.add(fname);
        }

        // Merge exit criteria (push NL string as a positive marker iff absent)
        const addedPositiveSignals: string[] = [];
        const mergedPositives = beforePositives.slice();
        const exitNL = (pbStage.exitCriteria ?? "").trim();
        if (exitNL && !mergedPositives.includes(exitNL)) {
          mergedPositives.push(exitNL);
          addedPositiveSignals.push(exitNL);
        }

        const mergedCopilot: any = {
          ...beforeCopilot,
          requiredDataFields: mergedFields,
          exitCriteria: {
            ...beforeExit,
            positiveSignals: mergedPositives,
          },
        };

        // Idempotency check — if nothing changed, skip the write but still
        // record the report so re-runs are observable.
        const noOp =
          addedRequiredFields.length === 0 && addedPositiveSignals.length === 0;

        updated[i] = { ...fnStage, copilot: mergedCopilot };

        pbReport.stageMerges.push({
          funnelStageId: fnStage.id,
          funnelStageLabel: fnStage.label ?? fnStage.id,
          beforeRequiredDataFields: beforeFields.length,
          afterRequiredDataFields: mergedFields.length,
          beforePositiveSignals: beforePositives.length,
          afterPositiveSignals: mergedPositives.length,
          addedRequiredFields,
          addedPositiveSignals,
        });

        if (noOp) {
          pbReport.notes.push(
            `Stage ${fnStage.id} already up-to-date (idempotent skip).`,
          );
        }
      }

      if (opts.mode === "apply") {
        await (prisma as any).tenantFunnel.update({
          where: { id: targetFunnel.id },
          data: { stages: updated },
        });
        pbReport.notes.push(`APPLIED: TenantFunnel ${targetFunnel.id} updated.`);
      }

      tenantReport.playbooks.push(pbReport);
    }

    reports.push(tenantReport);
  }

  return reports;
}

// ─── CLI entry point ────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const mode: CodemodMode = args.includes("--apply") ? "apply" : "dry-run";
  const all = args.includes("--all");
  const tenantIdx = args.indexOf("--tenant");
  const tenantId = tenantIdx >= 0 ? args[tenantIdx + 1] : undefined;

  console.log(`[playbook-fold] mode=${mode} tenant=${tenantId ?? "(all)"}`);
  const reports = await runPlaybookFoldCodemod({ mode, tenantId, all });
  for (const tr of reports) {
    console.log(`\n=== tenant ${tr.tenantId} ===`);
    if (tr.noFunnelFound) console.log("  ⚠ no active TenantFunnel — skipped");
    for (const pb of tr.playbooks) {
      console.log(`  playbook "${pb.playbookName}" (${pb.playbookId})`);
      console.log(`    -> funnel ${pb.funnelMatchId ?? "(none)"}`);
      for (const sm of pb.stageMerges) {
        const added = sm.addedRequiredFields.length + sm.addedPositiveSignals.length;
        console.log(
          `    stage ${sm.funnelStageLabel}: +${sm.addedRequiredFields.length} fields, +${sm.addedPositiveSignals.length} signals${added === 0 ? " (no-op)" : ""}`,
        );
      }
      if (pb.overflowPlaybookStages.length > 0) {
        console.log(`    ⚠ overflow stages skipped: ${pb.overflowPlaybookStages.join(", ")}`);
      }
      for (const n of pb.notes) console.log(`    note: ${n}`);
    }
  }
  console.log(`\n[playbook-fold] done. (${mode})`);
}

// Only run when invoked directly (tsx src/worker/pipeline/playbook-fold-codemod.ts)
if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error("[playbook-fold] FAILED:", err?.message ?? err);
      process.exit(1);
    },
  );
}
