'use client';

import { ChevronRight, Maximize, Minus, MoreHorizontal, Plus, Search } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useTransition,
  type DragEvent,
  type MouseEvent,
} from 'react';

import {
  ISSUE_CODES,
  type Automation,
  type AutomationEdge,
  type AutomationNode,
  type Catalog,
  type CatalogItem,
  type Issue,
  type NodeStats,
  type Trigger,
  type WebhookTrigger,
} from '@/api/contracts/automations';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/design-system/primitives/overlay/ContextMenu';
import { Dialog, DialogContent } from '@/design-system/primitives/overlay/Dialog';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/design-system/primitives/overlay/Menu';
import {
  UnavailableAction,
  UnavailableTag,
} from '@/design-system/primitives/unavailable/Unavailable';
import { Link, useRouter } from '@/i18n/navigation';

import { checkGraph, publishAutomation, readCatalog } from './automation-actions';
import {
  NODE_W,
  TRIGGER_NODE,
  duplicateStep,
  appendTarget,
  freeHandles,
  insertAfter,
  insertBetween,
  insertRefusal,
  removeSteps,
  isLabelled,
  layout,
  type Graph,
} from './graph';
import { DeleteAutomation } from './DeleteAutomation';
import { Inspector, type Choices } from './Inspector';
import { nodeIcon } from './node-icons';
import { NodeCard } from './NodeCard';
import { RunLog } from './RunLog';
import { modLabel, shortcutsAllowed, withMod } from './shortcuts';
import { StepSheet, nodeKey } from './StepSheet';
import styles from './Builder.module.css';

const ZOOMS = [0.6, 0.75, 0.9, 1] as const;
/** How long the canvas rests before the route checks it. */
export const CHECK_AFTER_MS = 800;
/** A card's height before it has been measured (one with a title and a line). */
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
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  /** Turning on is said first, by what starts it: a draft's publish makes it live. */
  const [confirming, setConfirming] = useState(false);
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
  /** Steps picked with Shift / ⌘ / Ctrl, or ⌘/Ctrl+A - what Delete removes. */
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  /** The canvas before each change since the last publish - ⌘/Ctrl+Z walks back. */
  const [history, setHistory] = useState<readonly Graph[]>([]);
  /** Removing more than one step is said first. */
  const [removing, setRemoving] = useState<{ readonly next: Graph; readonly count: number } | null>(
    null,
  );
  /** The step right-clicked, or `'canvas'` for the background. */
  const [menuFor, setMenuFor] = useState<string | 'canvas' | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [sheet, setSheet] = useState<{
    readonly after: string;
    readonly handle: string;
    /** AU9: a step on this line, between its two steps - not after `after`. */
    readonly edge?: AutomationEdge;
    readonly catalog: Catalog | null | 'reading';
  } | null>(null);
  const [insertRefused, setInsertRefused] = useState<Exclude<
    ReturnType<typeof insertRefusal>,
    null
  > | null>(null);
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

  /*
    ★★ AU5 (dev, 2026-10-14): a line started at a fixed 112px under its card,
    and cards are as tall as their words - so most lines began in mid-air,
    a gap below the card. Each card's rendered height is measured (and
    re-measured as it changes) and its line starts at its bottom edge.
    `offsetHeight` is the layout height, unscaled by the canvas zoom.
  */
  const stageRef = useRef<HTMLDivElement>(null);
  const [cardHeights, setCardHeights] = useState<ReadonlyMap<string, number>>(new Map());
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const cards = () =>
      [...stage.querySelectorAll<HTMLElement>('[data-node-id]')].flatMap((slot) => {
        const card = slot.firstElementChild;
        return card instanceof HTMLElement ? [[slot.dataset.nodeId ?? '', card] as const] : [];
      });
    const measure = () => {
      const next = new Map(cards().map(([id, card]) => [id, card.offsetHeight] as const));
      setCardHeights((was) =>
        was.size === next.size && [...next].every(([id, h]) => was.get(id) === h) ? was : next,
      );
    };
    const frame = requestAnimationFrame(measure);
    if (typeof ResizeObserver === 'undefined') return () => cancelAnimationFrame(frame);
    const observer = new ResizeObserver(measure);
    for (const [, card] of cards()) observer.observe(card);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [graph]);
  const bottomOf = (id: string) => cardHeights.get(id) || CARD_H;

  /*
   * The route's own validator, on the canvas as it is (debounced): a step it
   * would refuse says why on the step - the 24-hour window after a cart, a
   * comment step before the customer replies. Not filled in yet is the
   * card's "To fill in", not an error.
   */
  const [checked, setChecked] = useState<ReadonlyMap<string, Issue>>(new Map());
  useEffect(() => {
    const timer = setTimeout(() => {
      void checkGraph(automation.id, {
        trigger: { type: trigger.type ?? '', config: trigger.config },
        nodes: graph.nodes,
        edges: graph.edges,
      }).then((result) => {
        if (!result) return;
        const byNode = new Map<string, Issue>();
        for (const issue of result.errors) {
          if (issue.nodeId && issue.code !== 'missing_config' && !byNode.has(issue.nodeId)) {
            byNode.set(issue.nodeId, issue);
          }
        }
        setChecked(byNode);
      });
    }, CHECK_AFTER_MS);
    return () => clearTimeout(timer);
  }, [automation.id, graph, trigger]);

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
  /*
    ★ AU6: a library step goes after the chosen step when it has a way out,
    else after the deepest step that has one - never "choose a step first".
  */
  const target =
    chosen && chosenFree.length > 0
      ? { id: chosen.id, handle: chosenFree[0]! }
      : appendTarget(graph);
  const targetNode = target ? (graph.nodes.find((n) => n.id === target.id) ?? null) : null;

  /** A change to the canvas's shape (add, remove, duplicate): kept, so ⌘/Ctrl+Z can undo it. */
  const commit = (next: Graph) => {
    setHistory((past) => [...past.slice(-49), graph]);
    setGraph(next);
  };

  const undo = () => {
    const last = history[history.length - 1];
    if (!last) return;
    setHistory(history.slice(0, -1));
    setGraph(last);
    setPicked(new Set());
    if (selected && !last.nodes.some((n) => n.id === selected)) setSelected(null);
  };

  const steps = graph.nodes.filter((n) => n.type !== TRIGGER_NODE);

  /** Delete: the picked steps, else the open one - never the trigger; more than one is asked. */
  const removeSelection = () => {
    const ids = (picked.size > 0 ? [...picked] : selected ? [selected] : []).filter(
      (id) => graph.nodes.find((n) => n.id === id)?.type !== TRIGGER_NODE,
    );
    if (ids.length === 0) return;
    const next = removeSteps(graph, ids);
    const count = graph.nodes.length - next.nodes.length;
    if (count === 0) return;
    if (count > 1) {
      setRemoving({ next, count });
      return;
    }
    applyRemoval(next);
  };

  const applyRemoval = (next: Graph) => {
    commit(next);
    setPicked(new Set());
    if (selected && !next.nodes.some((n) => n.id === selected)) setSelected(null);
  };

  const duplicate = (id: string) => {
    const made = duplicateStep(graph, id, () => crypto.randomUUID());
    if (!made) return;
    commit(made.graph);
    setSelected(made.id);
    setPicked(new Set([made.id]));
    setPanel('inspector');
  };

  const add = (after: string, handle: string, item: CatalogItem) => {
    const made = insertAfter(graph, after, handle, item.type, () => crypto.randomUUID());
    commit(made.graph);
    setSelected(made.id);
    setPanel('inspector');
    setSheet(null);
  };

  /*
    ★★ AU9 (Omer, 2026-10-14): a step on a line, between two steps
    (graph.ts insertBetween): the line keeps its id and branch, the new step
    leads on. In a comment automation, before its first wait, only what the
    catalogue calls comment-safe - one it did not say is not.
  */
  const addBetween = (edge: AutomationEdge, item: CatalogItem) => {
    const comments = {
      automation: trigger.type === 'comment_received',
      safe: (type: string) => (item.type === type ? item.commentSafe === true : false),
    };
    const why = insertRefusal(graph, edge, item.type, comments);
    const made =
      why === null
        ? insertBetween(graph, edge, item.type, () => crypto.randomUUID(), comments)
        : null;
    setSheet(null);
    if (!made) {
      setInsertRefused(why ?? 'branching');
      return;
    }
    setInsertRefused(null);
    commit(made.graph);
    setSelected(made.id);
    setPanel('inspector');
  };

  /*
    ★ AU6 step 2 (Omer, approved): a library step dragged onto the canvas -
    onto a free "+" (after that step, on that branch), onto a line's "+"
    (between the two, with AU9's rules), or anywhere else on the canvas
    (where a click would put it). The drop targets light up while it moves.
  */
  const [dragging, setDragging] = useState<CatalogItem | null>(null);
  const dropOn = (onItem: (item: CatalogItem) => void) => ({
    onDragOver: (e: DragEvent) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDrop: (e: DragEvent) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      const item = dragging;
      setDragging(null);
      onItem(item);
    },
  });

  const openSheet = (after: string, handle: string, edge?: AutomationEdge) => {
    setInsertRefused(null);
    setSheet({ after, handle, ...(edge ? { edge } : {}), catalog: 'reading' });
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
      // Published: there is nothing before it to undo to.
      setHistory([]);
      setName(result.automation.name);
      setTrigger(result.automation.trigger);
      setOutcome(
        result.live
          ? { kind: 'live', issues: result.warnings }
          : { kind: 'saved', issues: result.blocked },
      );
    });

  /** Publish, as its button does - a draft's is said first, and nothing to publish is nothing. */
  const canPublish = !isPublishing && name.trim() !== '' && (dirty || automation.status !== 'live');
  const publishAsButton = () => {
    if (!canPublish) return;
    if (automation.status === 'live') publish();
    else setConfirming(true);
  };

  /** "Add a step here": after the open step if it has room, else the first step that does. */
  const addHere = () => {
    const open = graph.nodes.find((n) => n.id === selected);
    const at =
      (open && freeHandles(open, graph).length > 0 ? open : null) ??
      graph.nodes.find((n) => freeHandles(n, graph).length > 0) ??
      null;
    if (at) openSheet(at.id, freeHandles(at, graph)[0]!);
  };

  // 09d's keys (Omer, 2026-10-07) - never while typing, never under a dialog or a menu.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!shortcutsAllowed(event)) return;
      const k = event.key.toLowerCase();
      if (withMod(event) && k === 'a') {
        event.preventDefault();
        setPicked(new Set(steps.map((n) => n.id)));
      } else if (withMod(event) && k === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if (withMod(event) && k === 's') {
        event.preventDefault();
        publishAsButton();
      } else if (event.key === 'Escape' && (picked.size > 0 || selected !== null)) {
        event.preventDefault();
        setPicked(new Set());
        setSelected(null);
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && !withMod(event)) {
        event.preventDefault();
        removeSelection();
      } else if (event.key === '?') {
        event.preventDefault();
        setShowKeys(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /** Shift / ⌘ / Ctrl on a step: add it to the pick (or take it out); a plain click opens it. */
  const onStepClickCapture = (id: string) => (event: MouseEvent<HTMLDivElement>) => {
    if (!(event.shiftKey || withMod(event))) return;
    if ((event.target as Element).closest('[data-testid^="add-"]')) return;
    event.preventDefault();
    event.stopPropagation();
    setPicked((now) => {
      const next = new Set(now.size === 0 && selected ? [selected] : now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onCanvasMenu = (event: MouseEvent<HTMLDivElement>) => {
    const slot = (event.target as Element).closest<HTMLElement>('[data-node-id]');
    const id = slot?.dataset.nodeId ?? null;
    setMenuFor(id ?? 'canvas');
    if (id) {
      setSelected(id);
      setPanel('inspector');
      if (!picked.has(id)) setPicked(new Set([id]));
    }
  };

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
          <UnavailableAction
            label={t('builder.test')}
            tag={t('notYet')}
            why={t('builder.testWhy')}
            testid="builder-test"
          />
          <Menu>
            <MenuTrigger asChild>
              <button
                type="button"
                className={styles.secondary}
                aria-label={t('builder.more')}
                data-testid="builder-more"
              >
                <MoreHorizontal size={14} aria-hidden="true" />
              </button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem
                tone="danger"
                onSelect={() => setDeleting(true)}
                data-testid="builder-delete"
              >
                {t('delete.item')}
              </MenuItem>
            </MenuContent>
          </Menu>
          <button
            type="button"
            className={styles.primary}
            onClick={() => (automation.status === 'live' ? publish() : setConfirming(true))}
            disabled={
              isPublishing || name.trim() === '' || (!dirty && automation.status === 'live')
            }
            title={
              !dirty && automation.status === 'live' ? t('builder.nothingToPublish') : undefined
            }
            data-testid="builder-publish"
          >
            {isPublishing
              ? t('builder.publishing')
              : automation.status === 'live'
                ? t('builder.publish')
                : t('builder.publishOn')}
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
                {targetNode
                  ? t('builder.addsAfter', { step: stepName(targetNode) })
                  : t('builder.nowhereFree')}
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
                        const can = item.available && target !== null;
                        const Icon = nodeIcon(item.type);
                        if (!item.available) {
                          // Not here yet: a status with its tag, not a step to press.
                          return (
                            <li key={item.type}>
                              <span
                                className={styles.libItem}
                                data-unavailable=""
                                aria-disabled="true"
                                title={t(`reasons.${item.reason ?? 'coming_later'}`)}
                                data-testid={`library-${item.type}`}
                              >
                                <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
                                {t(`nodes.${nodeKey(item.type)}` as 'nodes.wait')}
                                {item.reason === 'coming_later' ||
                                item.reason === 'no_event_source' ? (
                                  <UnavailableTag label={t('comingSoon')} />
                                ) : null}
                              </span>
                              {/*
                                ★ AU6: why, in words - not only in a title
                                nobody hovers. "Coming later" is the tag's.
                              */}
                              {item.reason && item.reason !== 'coming_later' ? (
                                <span
                                  className={styles.libWhy}
                                  data-testid={`library-${item.type}-why`}
                                >
                                  {t(`reasons.${item.reason}`)}
                                </span>
                              ) : null}
                            </li>
                          );
                        }
                        return (
                          <li key={item.type}>
                            <button
                              type="button"
                              className={styles.libItem}
                              disabled={!can}
                              title={can ? undefined : t('builder.nowhereFree')}
                              onClick={() => target && add(target.id, target.handle, item)}
                              draggable={can}
                              onDragStart={(e) => {
                                e.dataTransfer.setData('text/plain', item.type);
                                e.dataTransfer.effectAllowed = 'copy';
                                setDragging(item);
                              }}
                              onDragEnd={() => setDragging(null)}
                              data-testid={`library-${item.type}`}
                            >
                              <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
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
          <ContextMenu onOpenChange={(open) => (open ? null : setMenuFor(null))}>
            <ContextMenuTrigger asChild>
              <div
                className={styles.canvasScroll}
                onContextMenu={onCanvasMenu}
                {...dropOn((item) => target && add(target.id, target.handle, item))}
                data-dragging={dragging ? '' : undefined}
                data-testid="builder-canvas-area"
              >
                {insertRefused ? (
                  <p
                    className={styles.insertRefused}
                    role="alert"
                    data-testid="builder-insert-refused"
                  >
                    {t(`builder.insertRefused.${insertRefused}`)}
                  </p>
                ) : null}
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
                    ref={stageRef}
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
                        // From the card's own bottom edge (AU5), to the next card's top.
                        const y1 = from.y + 20 + bottomOf(edge.source);
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
                    {/* AU9: a "+" on each line, at its middle - a step between the two. */}
                    {graph.edges.map((edge, i) => {
                      const from = at.get(edge.source);
                      const to = at.get(edge.target);
                      if (!from || !to) return null;
                      const y1 = from.y + 20 + bottomOf(edge.source);
                      const y2 = to.y + 20;
                      return (
                        <button
                          key={`between-${edge.id ?? i}`}
                          type="button"
                          className={styles.between}
                          style={{
                            insetInlineStart: (from.x + to.x) / 2 + NODE_W,
                            insetBlockStart: (y1 + y2) / 2,
                          }}
                          aria-label={t('builder.addBetween', {
                            from: stepName(graph.nodes.find((n) => n.id === edge.source)!),
                            to: stepName(graph.nodes.find((n) => n.id === edge.target)!),
                          })}
                          onClick={() => openSheet(edge.source, edge.sourceHandle ?? 'next', edge)}
                          {...dropOn((item) => addBetween(edge, item))}
                          data-testid={`between-${edge.source}-${edge.target}`}
                        >
                          <Plus size={11} aria-hidden="true" />
                        </button>
                      );
                    })}
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
                          data-node-id={node.id}
                          onClickCapture={onStepClickCapture(node.id)}
                          style={{
                            insetInlineStart: place.x + NODE_W / 2,
                            insetBlockStart: place.y + 20,
                          }}
                        >
                          <NodeCard
                            node={node}
                            trigger={trigger}
                            selected={node.id === selected || picked.has(node.id)}
                            marked={marked.has(node.id) || checked.has(node.id)}
                            issue={checked.has(node.id) ? issueText(checked.get(node.id)!) : null}
                            onSelect={() => {
                              setSelected(node.id);
                              setPicked(new Set([node.id]));
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
                                  {...dropOn((item) => add(node.id, handle, item))}
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
            </ContextMenuTrigger>
            <ContextMenuContent aria-label={t('builder.keys.menu')} data-testid="builder-menu">
              {menuFor === 'canvas' ? (
                <>
                  <ContextMenuItem onSelect={addHere} data-testid="menu-add-here">
                    {t('builder.keys.addHere')}
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => setPicked(new Set(steps.map((n) => n.id)))}
                    data-testid="menu-select-all"
                  >
                    {t('builder.keys.selectAll')}
                  </ContextMenuItem>
                </>
              ) : menuFor ? (
                <>
                  <ContextMenuItem
                    onSelect={() => {
                      setSelected(menuFor);
                      setPanel('inspector');
                    }}
                    data-testid="menu-edit"
                  >
                    {t('builder.keys.edit')}
                  </ContextMenuItem>
                  {duplicateStep(graph, menuFor, () => 'probe') ? (
                    <ContextMenuItem
                      onSelect={() => duplicate(menuFor)}
                      data-testid="menu-duplicate"
                    >
                      {t('builder.keys.duplicate')}
                    </ContextMenuItem>
                  ) : null}
                  {graph.nodes.find((n) => n.id === menuFor)?.type === TRIGGER_NODE ? null : (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        tone="danger"
                        onSelect={removeSelection}
                        data-testid="menu-remove"
                      >
                        {picked.size > 1
                          ? t('builder.keys.removeMany', { count: picked.size })
                          : t('inspector.remove')}
                      </ContextMenuItem>
                    </>
                  )}
                </>
              ) : null}
            </ContextMenuContent>
          </ContextMenu>
          <button
            type="button"
            className={styles.keysHint}
            onClick={() => setShowKeys(true)}
            data-testid="builder-keys"
          >
            {t('builder.keys.hint')}
          </button>
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
              types={
                catalog?.groups
                  .filter((group) => group.key !== 'trigger')
                  .flatMap((group) => group.items)
                  .filter((item) => item.available)
                  .map((item) => item.type) ?? []
              }
              onNode={(next: AutomationNode) =>
                setGraph({ ...graph, nodes: graph.nodes.map((n) => (n.id === next.id ? next : n)) })
              }
              onGraph={(next: Graph) => {
                commit(next);
                if (!next.nodes.some((n) => n.id === chosen.id)) setSelected(null);
              }}
              onTrigger={setTrigger}
            />
          ) : (
            <p className={styles.quiet}>{t('builder.pick')}</p>
          )}
        </aside>
      </div>

      {deleting ? (
        <DeleteAutomation
          targets={[{ id: automation.id, name: automation.name }]}
          onClose={() => setDeleting(false)}
          onDeleted={() => router.push('/studio/automations?deleted=1')}
        />
      ) : null}

      {confirming ? (
        <Dialog open onOpenChange={(open) => (open ? null : setConfirming(false))}>
          <DialogContent
            title={t('builder.turnOn.title')}
            description={t('builder.turnOn.what', {
              when: t(`when.${trigger.type ?? 'unknown'}` as 'when.webhook'),
            })}
            data-testid="builder-turn-on"
          >
            <span className={styles.confirmActions}>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => setConfirming(false)}
              >
                {t('builder.turnOn.cancel')}
              </button>
              <button
                type="button"
                className={styles.primary}
                onClick={() => {
                  setConfirming(false);
                  publish();
                }}
                data-testid="builder-turn-on-yes"
              >
                {t('builder.publishOn')}
              </button>
            </span>
          </DialogContent>
        </Dialog>
      ) : null}

      {removing ? (
        <Dialog open onOpenChange={(open) => (open ? null : setRemoving(null))}>
          <DialogContent
            title={t('builder.keys.removeTitle', { count: removing.count })}
            description={t('builder.keys.removeWhat')}
            data-testid="builder-remove-many"
          >
            <span className={styles.confirmActions}>
              <button type="button" className={styles.secondary} onClick={() => setRemoving(null)}>
                {t('inspector.keep')}
              </button>
              <button
                type="button"
                className={styles.danger}
                onClick={() => {
                  applyRemoval(removing.next);
                  setRemoving(null);
                }}
                data-testid="builder-remove-many-yes"
              >
                {t('builder.keys.removeYes', { count: removing.count })}
              </button>
            </span>
          </DialogContent>
        </Dialog>
      ) : null}

      {showKeys ? (
        <Dialog open onOpenChange={(open) => (open ? null : setShowKeys(false))}>
          <DialogContent title={t('builder.keys.title')} data-testid="builder-keys-list">
            <dl className={styles.keysList}>
              {(
                [
                  ['click', t('builder.keys.click')],
                  [`Shift / ${modLabel()}`, t('builder.keys.add')],
                  [`${modLabel()} A`, t('builder.keys.selectAll')],
                  ['Delete', t('builder.keys.remove')],
                  ['Esc', t('builder.keys.clear')],
                  [`${modLabel()} Z`, t('builder.keys.undo')],
                  [`${modLabel()} S`, t('builder.keys.publish')],
                  ['?', t('builder.keys.title')],
                ] as const
              ).map(([keys, what]) => (
                <div key={keys}>
                  <dt>
                    <kbd>{keys === 'click' ? t('builder.keys.clickKey') : keys}</kbd>
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
            <p className={styles.quiet}>{t('builder.keys.notInFields')}</p>
          </DialogContent>
        </Dialog>
      ) : null}

      {sheet ? (
        sheet.catalog === 'reading' ? null : (
          <StepSheet
            catalog={sheet.catalog}
            context={sheetContext(sheet.after, graph, trigger, t)}
            onClose={() => setSheet(null)}
            onPick={(item) =>
              sheet.edge ? addBetween(sheet.edge, item) : add(sheet.after, sheet.handle, item)
            }
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
