'use client';

import { ChevronRight, Maximize, Minus, Plus, Search } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';

import {
  ISSUE_CODES,
  type Automation,
  type AutomationNode,
  type Catalog,
  type CatalogItem,
  type Issue,
  type NodeStats,
  type Trigger,
  type WebhookTrigger,
} from '@/api/contracts/automations';
import { Link } from '@/i18n/navigation';

import { publishAutomation, readCatalog } from './automation-actions';
import {
  NODE_W,
  TRIGGER_NODE,
  freeHandles,
  insertAfter,
  isLabelled,
  layout,
  type Graph,
} from './graph';
import { Inspector, type Choices } from './Inspector';
import { NodeCard } from './NodeCard';
import { RunLog } from './RunLog';
import { StepSheet, nodeKey } from './StepSheet';
import styles from './Builder.module.css';

const ZOOMS = [0.6, 0.75, 0.9, 1] as const;
const CARD_H = 112;

/**
 * 09d - the builder (design 6): the library on the left, the canvas in the
 * middle, the chosen step's settings on the right.
 *
 *   canvas    the graph, top down; each branch labelled on its line; a "+"
 *             on every output with nothing after it opens 09e for that spot
 *   library   the same catalogue: a step chosen there goes after the chosen
 *             step, on its first free output
 *   Publish   PUT then - if not live - activate (contract v1, until
 *             versioned publish). A live automation's save is validated and
 *             refused whole; a draft is kept even when it cannot go live,
 *             and the issues are said, the steps they name marked.
 *
 * ★ Test is Phase 3: drawn, off, saying so. Edits are this page's until
 *   Publish - the bar says so, and closing the tab with changes asks first.
 */
export function Builder({
  automation: initial,
  catalog,
  stats,
  webhook,
  choices,
}: {
  readonly automation: Automation;
  readonly catalog: Catalog | null;
  readonly stats: NodeStats | null;
  readonly webhook: WebhookTrigger | null;
  readonly choices: Choices;
}) {
  const t = useTranslations('automations');
  const locale = useLocale();
  const [automation, setAutomation] = useState(initial);
  const [graph, setGraph] = useState<Graph>({
    nodes: initial.nodes ?? [],
    edges: initial.edges ?? [],
  });
  const [name, setName] = useState(initial.name);
  const [trigger, setTrigger] = useState<Trigger>(initial.trigger);
  const [selected, setSelected] = useState<string | null>(
    () => (initial.nodes ?? []).find((n) => n.type === TRIGGER_NODE)?.id ?? null,
  );
  const [panel, setPanel] = useState<'inspector' | 'runs'>('inspector');
  const [sheet, setSheet] = useState<{
    readonly after: string;
    readonly handle: string;
    readonly catalog: Catalog | null | 'reading';
  } | null>(null);
  const [zoom, setZoom] = useState<number>(1);
  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState<
    | { readonly kind: 'live' | 'saved'; readonly issues: readonly Issue[] }
    | { readonly kind: 'refused'; readonly issues: readonly Issue[] }
    | { readonly kind: 'stale' | 'forbidden' | 'failed' }
    | null
  >(null);
  const [isPublishing, startPublish] = useTransition();
  const [, startRead] = useTransition();

  const dirty =
    name.trim() !== automation.name ||
    JSON.stringify(trigger) !== JSON.stringify(automation.trigger) ||
    JSON.stringify(graph) !==
      JSON.stringify({ nodes: automation.nodes ?? [], edges: automation.edges ?? [] });
  const { at, width, height } = layout(graph);

  // Closing the tab with changes not yet published asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const marked = new Set(
    outcome && 'issues' in outcome ? outcome.issues.map((i) => i.nodeId).filter(Boolean) : [],
  );
  const chosen = graph.nodes.find((n) => n.id === selected) ?? null;
  const chosenFree = chosen ? freeHandles(chosen, graph) : [];

  const add = (after: string, handle: string, item: CatalogItem) => {
    const made = insertAfter(graph, after, handle, item.type, () => crypto.randomUUID());
    setGraph(made.graph);
    setSelected(made.id);
    setPanel('inspector');
    setSheet(null);
  };

  const openSheet = (after: string, handle: string) => {
    setSheet({ after, handle, catalog: 'reading' });
    startRead(async () => {
      const read = await readCatalog({ automationId: automation.id, after });
      setSheet((now) => (now && now.after === after ? { ...now, catalog: read } : now));
    });
  };

  const publish = () =>
    startPublish(async () => {
      setOutcome(null);
      const result = await publishAutomation(automation.id, {
        name: name.trim(),
        trigger: { type: trigger.type ?? '', config: trigger.config },
        nodes: graph.nodes,
        edges: graph.edges,
        expectedUpdatedAt: automation.updatedAt,
      });
      if (!result.ok) {
        setOutcome(
          result.reason === 'invalid'
            ? { kind: 'refused', issues: result.errors }
            : { kind: result.reason },
        );
        return;
      }
      setAutomation(result.automation);
      setGraph({ nodes: result.automation.nodes ?? [], edges: result.automation.edges ?? [] });
      setName(result.automation.name);
      setTrigger(result.automation.trigger);
      setOutcome(
        result.live
          ? { kind: 'live', issues: result.warnings }
          : { kind: 'saved', issues: result.blocked },
      );
    });

  const issueText = (issue: Issue) =>
    (ISSUE_CODES as readonly string[]).includes(issue.code)
      ? t(`issues.${issue.code}` as 'issues.no_steps')
      : issue.message;

  const libraryGroups = (catalog?.groups ?? []).filter((g) => g.key !== 'trigger');
  const runs = automation.stats.runsThisWeek;

  return (
    <div className={styles.builder}>
      <header className={styles.bar}>
        <nav className={styles.crumbs} aria-label={t('builder.crumbs')}>
          <Link href="/studio/automations" className={styles.crumb}>
            {t('title')}
          </Link>
          <ChevronRight size={14} aria-hidden="true" className={styles.crumbArrow} />
          <input
            className={styles.name}
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            aria-label={t('builder.name')}
            dir="auto"
            data-testid="builder-name"
          />
          <span
            className={styles.status}
            data-status={automation.status}
            data-testid="builder-status"
          >
            {automation.status === 'live' ? (
              <span className={styles.dot} aria-hidden="true" />
            ) : null}
            {t(`builder.status.${automation.status}`)}
          </span>
          <span className={styles.quiet}>
            {automation.stats.lastRunAt === null ? t('noRuns') : t('builder.week', { count: runs })}
          </span>
        </nav>
        <span className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            aria-pressed={panel === 'runs'}
            onClick={() => setPanel(panel === 'runs' ? 'inspector' : 'runs')}
            data-testid="builder-run-log"
          >
            {t('builder.runLog')}
          </button>
          <button
            type="button"
            className={styles.secondary}
            disabled
            title={t('builder.testWhy')}
            data-testid="builder-test"
          >
            {t('builder.test')}
          </button>
          <button
            type="button"
            className={styles.primary}
            onClick={publish}
            disabled={
              isPublishing || name.trim() === '' || (!dirty && automation.status === 'live')
            }
            title={
              !dirty && automation.status === 'live' ? t('builder.nothingToPublish') : undefined
            }
            data-testid="builder-publish"
          >
            {isPublishing ? t('builder.publishing') : t('builder.publish')}
          </button>
        </span>
      </header>

      {outcome ? (
        <div
          className={styles.outcome}
          data-kind={outcome.kind}
          role={outcome.kind === 'live' || outcome.kind === 'saved' ? 'status' : 'alert'}
          data-testid="builder-outcome"
        >
          <p>{t(`builder.outcome.${outcome.kind}`)}</p>
          {'issues' in outcome && outcome.issues.length > 0 ? (
            <ul>
              {outcome.issues.map((issue, i) => (
                <li key={`${issue.code}-${i}`}>
                  {issue.nodeId ? (
                    <button
                      type="button"
                      className={styles.issueLink}
                      onClick={() => {
                        setSelected(issue.nodeId);
                        setPanel('inspector');
                      }}
                    >
                      {issueText(issue)}
                    </button>
                  ) : (
                    issueText(issue)
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : dirty ? (
        <p className={styles.unsaved} role="status" data-testid="builder-unsaved">
          {t('builder.unsaved')}
        </p>
      ) : null}

      <div className={styles.panes}>
        <aside className={styles.library} aria-label={t('builder.library')}>
          <label className={styles.find}>
            <Search size={13} aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('builder.find')}
              aria-label={t('builder.find')}
            />
          </label>
          {catalog === null ? (
            <p className={styles.quiet}>{t('sheet.unread')}</p>
          ) : (
            <>
              <p className={styles.quiet} data-testid="library-where">
                {chosen && chosenFree.length > 0
                  ? t('builder.addsAfter', { step: stepName(chosen) })
                  : t('builder.chooseFirst')}
              </p>
              {libraryGroups.map((group) => (
                <section key={group.key} className={styles.libGroup}>
                  <h3 className={styles.libTitle} data-group={group.key}>
                    {t(`groups.${group.key}`)}
                  </h3>
                  <ul className={styles.libItems}>
                    {group.items
                      .filter((item) => {
                        const q = query.trim().toLowerCase();
                        const words = [
                          t(`nodes.${nodeKey(item.type)}` as 'nodes.wait'),
                          ...item.synonyms,
                        ];
                        return q === '' || words.some((w) => w.toLowerCase().includes(q));
                      })
                      .map((item) => {
                        const can = item.available && chosen !== null && chosenFree.length > 0;
                        return (
                          <li key={item.type}>
                            <button
                              type="button"
                              className={styles.libItem}
                              disabled={!can}
                              title={
                                item.available
                                  ? can
                                    ? undefined
                                    : t('builder.chooseFirst')
                                  : t(`reasons.${item.reason ?? 'coming_later'}`)
                              }
                              onClick={() => chosen && add(chosen.id, chosenFree[0]!, item)}
                              data-testid={`library-${item.type}`}
                            >
                              {t(`nodes.${nodeKey(item.type)}` as 'nodes.wait')}
                            </button>
                          </li>
                        );
                      })}
                  </ul>
                </section>
              ))}
            </>
          )}
        </aside>

        <main className={styles.canvasWrap} aria-label={t('builder.canvas')}>
          <div className={styles.canvasScroll}>
            <div
              className={styles.canvas}
              style={{
                inlineSize: (width + NODE_W) * zoom,
                blockSize: (height + 80) * zoom,
              }}
            >
              <div
                className={styles.stage}
                style={{
                  transform: `scale(${zoom})`,
                  inlineSize: width + NODE_W,
                  blockSize: height + 80,
                }}
                data-testid="builder-canvas"
              >
                <svg
                  className={styles.lines}
                  width={width + NODE_W}
                  height={height + 80}
                  aria-hidden="true"
                >
                  {graph.edges.map((edge, i) => {
                    const from = at.get(edge.source);
                    const to = at.get(edge.target);
                    if (!from || !to) return null;
                    const x1 = from.x + NODE_W / 2 + NODE_W / 2;
                    const y1 = from.y + CARD_H + 20;
                    const x2 = to.x + NODE_W / 2 + NODE_W / 2;
                    const y2 = to.y + 20;
                    const mid = (y1 + y2) / 2;
                    return (
                      <path
                        key={edge.id ?? `${edge.source}-${edge.target}-${i}`}
                        d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`}
                      />
                    );
                  })}
                </svg>
                {graph.edges.map((edge, i) => {
                  const from = at.get(edge.source);
                  const to = at.get(edge.target);
                  if (!from || !to || !isLabelled(edge.sourceHandle)) return null;
                  const source = graph.nodes.find((n) => n.id === edge.source);
                  return (
                    <span
                      key={`label-${edge.id ?? i}`}
                      className={styles.branch}
                      // Just above the step it leads to.
                      style={{ insetInlineStart: to.x + NODE_W, insetBlockStart: to.y + 2 }}
                    >
                      {source
                        ? branchName(source, edge.sourceHandle!, graph, t, locale)
                        : edge.sourceHandle}
                    </span>
                  );
                })}
                {graph.nodes.map((node) => {
                  const place = at.get(node.id);
                  if (!place) return null;
                  const free = freeHandles(node, graph);
                  return (
                    <div
                      key={node.id}
                      className={styles.slot}
                      style={{
                        insetInlineStart: place.x + NODE_W / 2,
                        insetBlockStart: place.y + 20,
                      }}
                    >
                      <NodeCard
                        node={node}
                        trigger={trigger}
                        selected={node.id === selected}
                        marked={marked.has(node.id)}
                        onSelect={() => {
                          setSelected(node.id);
                          setPanel('inspector');
                        }}
                      />
                      {free.length > 0 ? (
                        <span className={styles.adds}>
                          {free.map((handle) => (
                            <button
                              key={handle}
                              type="button"
                              className={styles.add}
                              onClick={() => openSheet(node.id, handle)}
                              aria-label={
                                isLabelled(handle)
                                  ? t('builder.addOn', {
                                      step: stepName(node),
                                      branch: branchName(node, handle, graph, t, locale),
                                    })
                                  : t('builder.addAfter', { step: stepName(node) })
                              }
                              data-testid={`add-${node.id}-${handle}`}
                            >
                              <Plus size={12} aria-hidden="true" />
                              {isLabelled(handle) ? (
                                <span>{branchName(node, handle, graph, t, locale)}</span>
                              ) : null}
                            </button>
                          ))}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <span className={styles.zoom}>
            <button
              type="button"
              onClick={() =>
                setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(zoom as (typeof ZOOMS)[number]) - 1)] ?? 1)
              }
              aria-label={t('builder.zoomOut')}
            >
              <Minus size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() =>
                setZoom(
                  ZOOMS[
                    Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom as (typeof ZOOMS)[number]) + 1)
                  ] ?? 1,
                )
              }
              aria-label={t('builder.zoomIn')}
            >
              <Plus size={13} aria-hidden="true" />
            </button>
            <button type="button" onClick={() => setZoom(1)} aria-label={t('builder.zoomReset')}>
              <Maximize size={12} aria-hidden="true" />
            </button>
          </span>
        </main>

        <aside className={styles.side}>
          {panel === 'runs' ? (
            <RunLog automationId={automation.id} />
          ) : chosen ? (
            <Inspector
              key={chosen.id}
              node={chosen}
              graph={graph}
              trigger={trigger}
              automationId={automation.id}
              webhook={webhook}
              stats={stats?.[chosen.id] ?? null}
              statsRead={stats !== null}
              variables={catalog?.variables ?? []}
              choices={choices}
              onNode={(next: AutomationNode) =>
                setGraph({ ...graph, nodes: graph.nodes.map((n) => (n.id === next.id ? next : n)) })
              }
              onGraph={(next: Graph) => {
                setGraph(next);
                if (!next.nodes.some((n) => n.id === chosen.id)) setSelected(null);
              }}
              onTrigger={setTrigger}
            />
          ) : (
            <p className={styles.quiet}>{t('builder.pick')}</p>
          )}
        </aside>
      </div>

      {sheet ? (
        sheet.catalog === 'reading' ? null : (
          <StepSheet
            catalog={sheet.catalog}
            context={sheetContext(sheet.after, graph, trigger, t)}
            onClose={() => setSheet(null)}
            onPick={(item) => add(sheet.after, sheet.handle, item)}
          />
        )
      ) : null}
    </div>
  );

  function stepName(node: AutomationNode): string {
    const own = typeof node.data.label === 'string' ? node.data.label.trim() : '';
    if (own) return own;
    return node.type === TRIGGER_NODE
      ? t(`nodes.trigger.${trigger.type ?? 'unknown'}` as 'nodes.trigger.webhook')
      : t(`nodes.${node.type}` as 'nodes.wait');
  }
}

type T = ReturnType<typeof useTranslations<'automations'>>;

/** A branch's name on the canvas: a button's own title, else the branch in words. */
export function branchName(
  node: AutomationNode,
  handle: string,
  graph: Graph,
  t: T,
  locale: string,
): string {
  if (handle.startsWith('btn:')) {
    const id = handle.slice(4);
    const prev = graph.edges.find((e) => e.target === node.id);
    const source = prev ? graph.nodes.find((n) => n.id === prev.source) : null;
    const options = source
      ? ((source.data.buttons ?? source.data.options) as
          { id?: string; title?: string }[] | undefined)
      : undefined;
    const title = Array.isArray(options) ? options.find((o) => o?.id === id)?.title : undefined;
    return title?.trim() || t('branches.button');
  }
  if (node.type === 'language' && handle !== 'other') {
    try {
      return new Intl.DisplayNames([locale], { type: 'language' }).of(handle) ?? handle;
    } catch {
      return handle;
    }
  }
  if (node.type === 'split_channel' && handle !== 'other') {
    return t(
      `channels.${handle === 'GMAIL' || handle === 'OUTLOOK' ? 'EMAIL' : handle}` as 'channels.WHATSAPP',
    );
  }
  return t(`branches.${handle}` as 'branches.next');
}

function sheetContext(after: string, graph: Graph, trigger: Trigger, t: T): string {
  const node = graph.nodes.find((n) => n.id === after);
  const own = node && typeof node.data.label === 'string' ? node.data.label.trim() : '';
  const step = node
    ? own ||
      (node.type === TRIGGER_NODE
        ? t(`nodes.trigger.${trigger.type ?? 'unknown'}` as 'nodes.trigger.webhook')
        : t(`nodes.${node.type}` as 'nodes.wait'))
    : '';
  const channels = Array.isArray(trigger.config.channels) ? trigger.config.channels : [];
  return channels.length === 1 && typeof channels[0] === 'string'
    ? t('sheet.afterOn', { step, channel: t(`channels.${channels[0]}` as 'channels.WHATSAPP') })
    : t('sheet.after', { step });
}
