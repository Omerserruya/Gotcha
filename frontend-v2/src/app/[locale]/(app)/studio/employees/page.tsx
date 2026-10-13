import { getTranslations } from 'next-intl/server';

import {
  choicesFor,
  currentChoice,
  hasOwnWords,
  humaniseToolName,
  isTheAdminsChoice,
  resolveAvailability,
} from '@/api/contracts/capabilities';
import { loadCapabilities } from '@/features/capabilities/load-capabilities';
import { catalogName, isFailing } from '@/api/contracts/integrations';
import { HireSheet } from '@/features/employees/hire/HireSheet';
import { loadEmployeeTools } from '@/features/employees/page/load-employee-tools';
import { toolLevelRows } from '@/features/employees/page/tool-label';
import { loadViewerId } from '@/features/roles/load-person';
import { HiredDialog } from '@/features/employees/hired/HiredDialog';
import type { HireTool } from '@/features/employees/hire/hire-plan';
import { loadHireSkills } from '@/features/employees/hire/load-hire-skills';
import { loadEmployeeKnowledge } from '@/features/employees/page/load-employee-knowledge';
import { Link } from '@/i18n/navigation';
import { EmployeeDetail } from '@/features/employees/EmployeeDetail';
import { EmployeeRail } from '@/features/employees/EmployeeRail';
import styles from '@/features/employees/Employees.module.css';
import { loadEmployees, loadReachability } from '@/features/employees/load-employees';
import { foldWidget } from '@/features/employees/reach';
import type { ReachItem } from '@/features/employees/WhoAnswers';
import { ltr } from '@/lib/bidi';
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
    /** 07e: "Hired", for this employee. */
    readonly hired?: string;
  }>;
} = {}) {
  const t = await getTranslations('employees');
  const tc = await getTranslations('capabilities');
  const params = (await searchParams) ?? {};
  const hiring = params.hire === '1';
  // H6: whose hire draft this is - read only while hiring.
  const viewerId = hiring ? await loadViewerId() : null;
  // The detail's permissions and connected tools are the business's, read once.
  const [employees, { capabilities, integrations }, knowledge, skills, toolWords] =
    await Promise.all([
      loadEmployees(),
      loadCapabilities(),
      // The Hire sheet's reads, only when it is open: the knowledge bases with
      // their scope (the employee page's read) and the skills it may carry (H4).
      hiring ? loadEmployeeKnowledge() : Promise.resolve(null),
      hiring ? loadHireSkills() : Promise.resolve(null),
      // Each action's provider and words ("WooCommerce · Get customer"), for the
      // hire flow's Limits - the tool catalogue, as Skills reads it.
      hiring ? readTools() : Promise.resolve(null),
    ]);
  const wordsOf = (toolName: string) => toolWords?.find((tool) => tool.name === toolName) ?? null;
  /*
    ★ H2 (Omer, 2026-10-13): an integration's action in the reader's
    language - the catalogue's own name from the integrations read, which the
    platform answers in the interface language (Accept-Language), so
    WooCommerce's limits read in Hebrew on a Hebrew page. Never hard-coded:
    a new tool in the catalogue is named the day it ships.
  */
  const integrationOf = (slug: string | null | undefined) =>
    (slug ? integrations?.find((integration) => integration.slug === slug) : null) ?? null;
  /** "WooCommerce · Get customer"; our own words or the name made readable when the catalogue is silent. */
  const actionLabel = (toolName: string, integration?: string | null) =>
    catalogName(toolName, integrationOf(integration)) ??
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
            label: actionLabel(c.toolName, c.integration),
            provider,
            providerLabel: words?.providerLabel ?? provider,
            choices: choicesFor(c),
            current: currentChoice(c),
          };
        })
    : [];
  const step = params.step === '2' ? 2 : params.step === '3' ? 3 : params.step === '4' ? 4 : 1;
  const selected = employees?.find((e) => e.id === wanted) ?? employees?.[0] ?? null;
  const hired = params.hired ? (employees?.find((e) => e.id === params.hired) ?? null) : null;
  /*
    Where it answers, by the playbook (Backend f79f1e6c): the selected
    employee's for 07, and 07e's when it is another one. Named here, so 07's
    server card and 07e say it alike.
  */
  const tch = await getTranslations('channels');
  const reachOf = async (id: string): Promise<readonly ReachItem[] | null> => {
    const channels = await loadReachability(id);
    // The Website widget is one row, as the channel list draws it.
    /*
      ★ E1 (Omer, 2026-10-13): the platform, then the channel's own name -
      "וואטסאפ · שירות לקוחות" - one line per account. The name is the
      account's display name, else its phone (isolated, so it reads left to
      right), else the channel alone. The widget stays one row.
    */
    return channels
      ? foldWidget(channels).flatMap((c): ReachItem[] => {
          const when = t(`reach.${c.reach}`);
          if (c.widget) {
            // The widget's row wears the web chat's globe, as the channel list does.
            return [{ channel: 'WEBCHAT', name: tch('widgetRow.name'), when }];
          }
          const platform = channelName(c.channel, tch) ?? tch('name.other');
          const named = (c.accounts ?? []).flatMap((a) => {
            const own = a.displayName?.trim() || (a.detail?.trim() ? ltr(a.detail.trim()) : '');
            return own ? [{ key: a.channelAccountId, own }] : [];
          });
          return named.length === 0
            ? [{ channel: c.channel, name: platform, when }]
            : named.map((a) => ({
                key: a.key,
                channel: c.channel,
                name: `${platform} · ${a.own}`,
                when,
              }));
        })
      : null;
  };
  // E5: the card's "may do" is this employee's own levels, named as its profile names them.
  const [reach, selectedTools] = await Promise.all([
    selected ? reachOf(selected.id) : Promise.resolve(null),
    selected ? loadEmployeeTools(selected.id) : Promise.resolve(null),
  ]);
  const levels = toolLevelRows(
    selectedTools,
    (slug) => integrationOf(slug)?.name ?? null,
    (toolName) => tc(`tool.${toolName}` as 'tool.send_message'),
  );
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
        // 07b-07d: the Hire sheet; hiring from it is live (H5).
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
              levels={levels}
              integrations={integrations}
              reach={reach}
            />
          )
        }
      />
      {hired ? <HiredDialog employee={hired} reach={hiredReach} /> : null}
      {hiring ? (
        <HireSheet
          tools={hireTools}
          knowledge={knowledge}
          skills={skills}
          initialStep={step}
          viewerId={viewerId}
          // Every system the workspace has CONNECTED - a new employee may use
          // each of them unless switched off here. A disconnected or broken
          // one is not offered: the runtime reads an integration's actions
          // only from a CONNECTED connection (Backend f14afdbd, the same rule
          // for an employee's tools). Dev, 2026-10-13: the summary listed a
          // disconnected Shopify.
          systems={
            integrations
              ? integrations
                  .filter((i) => i.tenantConnection?.status === 'CONNECTED')
                  .map((i) => ({
                    slug: i.slug,
                    name: i.name,
                    failing: isFailing(i.tenantConnection),
                  }))
              : null
          }
        />
      ) : null}
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.studio');
