import { getTranslations } from 'next-intl/server';

import {
  capabilityStance,
  choicesFor,
  currentChoice,
  hasOwnWords,
  humaniseToolName,
  isTheAdminsChoice,
  resolveAvailability,
} from '@/api/contracts/capabilities';
import { loadCapabilities } from '@/features/capabilities/load-capabilities';
import { isConnected, isFailing } from '@/api/contracts/integrations';
import { EditSheet } from '@/features/employees/edit/EditSheet';
import { HireSheet } from '@/features/employees/hire/HireSheet';
import { HiredDialog } from '@/features/employees/hired/HiredDialog';
import type { HireTool } from '@/features/employees/hire/hire-plan';
import { loadKnowledge } from '@/features/knowledge/load-knowledge';
import { Link } from '@/i18n/navigation';
import { EmployeeDetail } from '@/features/employees/EmployeeDetail';
import { EmployeeRail } from '@/features/employees/EmployeeRail';
import styles from '@/features/employees/Employees.module.css';
import {
  loadEmployees,
  loadIntegrationAccess,
  loadReachability,
} from '@/features/employees/load-employees';
import { foldWidget } from '@/features/employees/reach';
import type { ReachItem } from '@/features/employees/WhoAnswers';
import { channelName } from '@/api/contracts/inbox';
import { StudioSplit } from '@/features/studio/StudioSplit';
import { PageContainer } from '@/shell/PageContainer';
import { readTools } from '@/features/skills/skill-actions';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Studio · AI employees - screen 07.
 *
 * ── THE FOURTH VERB, AND WHY THE SENTENCE GREW ──
 * The design says *"Hire, edit, pause, fire"*. `AIAgentStatus` is
 * `ACTIVE | DRAFT | PAUSED`, so **firing is not a state this platform has**.
 *
 * The note above the list used to say only that. Then Delete was added, and
 * *"there is no way to retire one"* ended up sitting **directly above the most
 * destructive control on the screen** - so a reader denied the thing they
 * wanted would reach for the nearest thing to it. **Delete is not retirement:
 * retiring would keep the record and stop the work; delete destroys the
 * employee and leaves live conversations waiting for a person.**
 *
 * The sentence was still true and no longer sufficient. It now distinguishes
 * all three - pause keeps it, delete removes it, neither retires it - because
 * **what someone concludes before opening the dialog is the part the dialog
 * cannot fix.**
 *
 * ── AND WHAT PAUSING ACTUALLY DOES ──
 * Nothing but stop replying. No handover, no reassignment, no notification -
 * so the confirmation names the people mid-conversation, with the number.
 *
 * ── WHAT IS ABSENT ──
 * **No escalation count.** `isHandedOver` has six-plus writers sharing only
 * *"a person ended up driving"*, and the cause would need
 * `ConversationHandover.reason`, which holds **zero rows while five
 * conversations carry the flag**. A cause column would be a confident zero for
 * every employee.
 *
 * **No knowledge-coverage-by-topic and no escalation-analysis suggestions** -
 * neither has a source.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{
    readonly employee?: string;
    /** 07b-07d: the Hire sheet, and its step. */
    readonly hire?: string;
    readonly step?: string;
    /** 07f: the Edit sheet over the selected employee. */
    readonly edit?: string;
    /** 07e: "Hired", for this employee. */
    readonly hired?: string;
  }>;
} = {}) {
  const t = await getTranslations('employees');
  const tc = await getTranslations('capabilities');
  const params = (await searchParams) ?? {};
  const hiring = params.hire === '1';
  // The detail's permissions and connected tools are the business's, read once.
  const editingWanted = params.edit === '1';
  const [employees, { capabilities, integrations }, knowledgeData, toolWords] = await Promise.all([
    loadEmployees(),
    loadCapabilities(),
    // The Hire sheet's reads, only when it is open.
    hiring ? loadKnowledge() : Promise.resolve(null),
    // Each action's provider and words ("WooCommerce · Get customer"), for the
    // hire flow's Limits and 07f - the tool catalogue, as Skills reads it.
    hiring || editingWanted ? readTools() : Promise.resolve(null),
  ]);
  const wordsOf = (toolName: string) => toolWords?.find((tool) => tool.name === toolName) ?? null;
  /** "WooCommerce · Get customer"; our own words or the name made readable when the catalogue is silent. */
  const actionLabel = (toolName: string) =>
    wordsOf(toolName)?.actionLabel ??
    (hasOwnWords(toolName)
      ? tc(`tool.${toolName}` as 'tool.send_message')
      : humaniseToolName(toolName));
  const wanted = params.employee;
  /* Step 2's rows: the business's own actions, as 10 reads and words them. */
  const hireTools: readonly HireTool[] = hiring
    ? (capabilities ?? [])
        .filter((c) => isTheAdminsChoice(resolveAvailability(c)))
        .map((c) => {
          const words = wordsOf(c.toolName);
          const provider = words?.provider ?? c.integration ?? null;
          return {
            toolName: c.toolName,
            label: actionLabel(c.toolName),
            provider,
            providerLabel: words?.providerLabel ?? provider,
            choices: choicesFor(c),
            current: currentChoice(c),
          };
        })
    : [];
  const step = params.step === '2' ? 2 : params.step === '3' ? 3 : 1;
  const selected = employees?.find((e) => e.id === wanted) ?? employees?.[0] ?? null;
  const editing = params.edit === '1' && selected !== null ? selected : null;
  const hired = params.hired ? (employees?.find((e) => e.id === params.hired) ?? null) : null;
  // 07f's business systems: this employee's allowlist and every system set up.
  const access = editing ? await loadIntegrationAccess(editing.id) : null;
  /*
    Where it answers, by the playbook (Backend f79f1e6c): the selected
    employee's for 07 and 07f, and 07e's when it is another one. Named here,
    so 07's server card and the client sheets say it alike.
  */
  const tch = await getTranslations('channels');
  const reachOf = async (id: string): Promise<readonly ReachItem[] | null> => {
    const channels = await loadReachability(id);
    // The Website widget is one row, as the channel list draws it.
    return channels
      ? foldWidget(channels).map((c) => ({
          channel: c.channel,
          name: c.widget
            ? tch('widgetRow.name')
            : (channelName(c.channel, tch) ?? tch('name.other')),
          when: t(`reach.${c.reach}`),
        }))
      : null;
  };
  const reach = selected ? await reachOf(selected.id) : null;
  const hiredReach = hired ? (hired.id === selected?.id ? reach : await reachOf(hired.id)) : null;

  /*
    07, measured: 02's screen header - the title, a line that counts them,
    and "Hire an employee" on the right - over a split: the list (330) and
    the selected employee (888), each scrolling inside itself.
  */
  const summary = employees?.length
    ? t('summary', {
        working: employees.filter((e) => e.status === 'ACTIVE').length,
        paused: employees.filter((e) => e.status === 'PAUSED').length,
      })
    : t('description');

  return (
    <PageContainer
      layout="screen"
      headerPadEnd={22}
      flush
      title={t('title')}
      description={summary}
      actions={
        // 07b-07d: the Hire sheet, read-only until creating is allowed.
        <Link
          href={{ pathname: '/studio/employees', query: { hire: '1' } }}
          className={styles.hire}
          data-testid="hire"
          scroll={false}
        >
          {t('hire')}
        </Link>
      }
    >
      <StudioSplit
        label={t('rail.label')}
        list={
          employees && selected ? (
            <EmployeeRail employees={employees} selectedId={selected.id} />
          ) : null
        }
        detail={
          employees === null ? (
            <p data-testid="employees-unavailable">{t('unavailable')}</p>
          ) : selected === null ? (
            <div className={styles.empty} data-testid="employees-empty">
              <p className={styles.emptyLead}>{t('none')}</p>
              {/* The consequence, not just the absence. */}
              <p className={styles.emptyBody}>{t('noneBody')}</p>
            </div>
          ) : (
            <EmployeeDetail
              employee={selected}
              capabilities={capabilities}
              integrations={integrations}
              reach={reach}
            />
          )
        }
      />
      {editing ? (
        <EditSheet
          employee={editing}
          access={access}
          reach={reach}
          tools={integrations ? integrations.filter(isConnected).map((i) => i.name) : null}
          mayDo={
            capabilities
              ? capabilities
                  .filter((c) => c.kind === 'action')
                  .map((c) => ({
                    toolName: c.toolName,
                    label: wordsOf(c.toolName)?.providerLabel
                      ? `${wordsOf(c.toolName)!.providerLabel} · ${actionLabel(c.toolName)}`
                      : actionLabel(c.toolName),
                    stance: capabilityStance(c),
                  }))
              : null
          }
        />
      ) : null}
      {hired ? <HiredDialog employee={hired} reach={hiredReach} /> : null}
      {hiring ? (
        <HireSheet
          tools={hireTools}
          knowledge={
            knowledgeData?.sources ? knowledgeData.sources.map((k) => k.name).filter(Boolean) : null
          }
          initialStep={step}
          // Every system the workspace has set up, in any state - a new
          // employee may use each of them unless switched off here.
          systems={
            integrations
              ? integrations
                  .filter((i) => i.tenantConnection)
                  .map((i) => ({ slug: i.slug, failing: isFailing(i.tenantConnection) }))
              : null
          }
        />
      ) : null}
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.studio');
