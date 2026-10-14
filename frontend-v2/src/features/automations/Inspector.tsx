'use client';

import { Trash2, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState, useSyncExternalStore, useTransition, type ReactNode } from 'react';

import type {
  AutomationNode,
  NodeStats,
  Trigger,
  WebhookTrigger,
} from '@/api/contracts/automations';

import { UnavailableItem } from '@/design-system/primitives/unavailable/Unavailable';

import { provisionWebhook } from './automation-actions';
import {
  cartFirstSend,
  changeRefusal,
  changeType,
  fileNameOf,
  TRIGGER_NODE,
  UNREACHABLE_HANDLE,
  VIA_TYPES,
  onlyThrough,
  removeStep,
  viaOf,
  type ChangeRefusal,
  type Graph,
} from './graph';
import styles from './Builder.module.css';

/** The route's limits (`LIMITS`): enforced here, where they are typed. */
const LIMITS = { buttons: 3, buttonTitle: 20, listOptions: 10, listTitle: 24 } as const;
const TRIGGER_CHANNELS = ['WHATSAPP', 'INSTAGRAM', 'MESSENGER', 'EMAIL', 'WEBCHAT'] as const;
/** Each trigger's channels, as the route accepts them (`normalizeTrigger`). */
const CHANNELS_OF: Readonly<Record<string, readonly string[]>> = {
  message_received: TRIGGER_CHANNELS,
  new_customer: TRIGGER_CHANNELS,
  message_from_ad: ['WHATSAPP', 'MESSENGER', 'INSTAGRAM'],
  button_tapped: ['WHATSAPP', 'MESSENGER', 'INSTAGRAM'],
  comment_received: ['INSTAGRAM', 'MESSENGER'],
  // AU4: a cart reminder has none - its first message names the channel.
  order_event: ['WHATSAPP', 'EMAIL'],
};
/** The order events the route knows (`ORDER_STATUSES`); none chosen: all. */
const ORDER_STATUSES = ['created', 'paid', 'fulfilled', 'cancelled'] as const;
/** The cart's delay, as the route bounds it. */
const CART_DELAY = { min: 15, max: 2880 } as const;
const LANGUAGES = ['he', 'en', 'ar', 'ru', 'fr', 'es'] as const;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const UNITS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;
/** Steps whose settings are "the existing shape" in the contract: not editable here yet. */
const NOT_HERE = new Set(['condition_group', 'update_customer', 'http_request']);

type Named = { readonly id: string; readonly name: string };
export interface Choices {
  /** Approved WhatsApp templates, with their variables. `null`: unread. */
  readonly templates?:
    | readonly {
        readonly id: string;
        readonly name: string;
        readonly variables: readonly string[];
      }[]
    | null;
  readonly employees: readonly Named[] | null;
  readonly teams: readonly Named[] | null;
  readonly members: readonly Named[] | null;
  readonly skills: readonly Named[] | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const noSubscription = () => () => {};

/**
 * 09d's right pane: the chosen step's settings, written into the canvas's
 * graph (published with it). Only what the contract stores is a field; a
 * step whose settings are "the existing shape" (conditions, HTTP, update a
 * field, templates) says it cannot be edited here yet.
 */
export function Inspector({
  node,
  graph,
  trigger,
  automationId,
  webhook,
  stats,
  statsRead,
  variables,
  choices,
  types = [],
  reach = null,
  automationName = '',
  onNode,
  onGraph,
  onTrigger,
}: {
  /** AU4: which channels can reach a customer (the catalogue's context); `null`: unknown. */
  readonly reach?: { readonly whatsapp: boolean; readonly email: boolean } | null;
  /** AU4: an email's subject starts as the automation's name. */
  readonly automationName?: string;
  readonly node: AutomationNode;
  readonly graph: Graph;
  readonly trigger: Trigger;
  readonly automationId: string;
  readonly webhook: WebhookTrigger | null;
  readonly stats: NodeStats[string] | null;
  readonly statsRead: boolean;
  readonly variables: readonly string[];
  readonly choices: Choices;
  /** AU8: the step types this step may become - the catalogue's, available, no trigger. */
  readonly types?: readonly string[];
  readonly onNode: (node: AutomationNode) => void;
  readonly onGraph: (graph: Graph) => void;
  readonly onTrigger: (trigger: Trigger) => void;
}) {
  const t = useTranslations('automations');
  const [removing, setRemoving] = useState(false);
  const [refused, setRefused] = useState<Exclude<ChangeRefusal, null> | null>(null);
  const d = node.data;
  const set = (patch: Record<string, unknown>) => onNode({ ...node, data: { ...d, ...patch } });
  const name =
    node.type === TRIGGER_NODE
      ? t(`nodes.trigger.${trigger.type ?? 'unknown'}` as 'nodes.trigger.webhook')
      : t(`nodes.${node.type}` as 'nodes.wait');
  const after = onlyThrough(graph, node.id).length - 1;

  return (
    <div className={styles.inspector} data-testid="inspector">
      <h2 className={styles.inspectorTitle}>{name}</h2>
      <Field label={t('inspector.label')}>
        <input
          value={str(d.label)}
          maxLength={60}
          placeholder={name}
          onChange={(e) => set({ label: e.target.value })}
          dir="auto"
          data-testid="inspector-label"
        />
      </Field>

      {/*
        ★★ AU8 (Omer, 2026-10-14): change what this step is - a message to a
        file, and so on - in its place: its id and its lines stay
        (graph.ts changeType). One it may not become says why, and nothing
        changes.
      */}
      {node.type !== TRIGGER_NODE && types.length > 1 ? (
        <Field label={t('inspector.type')}>
          <select
            value={node.type}
            data-testid="inspector-type"
            onChange={(e) => {
              const type = e.target.value;
              const why = changeRefusal(graph, node.id, type);
              if (why === 'same') return;
              const next = why === null ? changeType(graph, node.id, type) : null;
              if (next) {
                setRefused(null);
                onGraph(next);
              } else setRefused(why === null ? 'trigger' : why);
            }}
          >
            {[...new Set([node.type, ...types])].map((type) => (
              <option key={type} value={type}>
                {t(`nodes.${type}` as 'nodes.wait')}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {refused ? (
        <p className={styles.why} role="alert" data-testid="inspector-type-refused">
          {t(`inspector.typeRefused.${refused}`)}
        </p>
      ) : null}

      {node.type === TRIGGER_NODE ? (
        <TriggerFields
          trigger={trigger}
          automationId={automationId}
          webhook={webhook}
          onTrigger={onTrigger}
        />
      ) : NOT_HERE.has(node.type) ? (
        <p className={styles.why} data-testid="inspector-not-here">
          {t('inspector.notHere')}
        </p>
      ) : (
        <>
          <CartVia
            node={node}
            graph={graph}
            reach={reach}
            automationName={automationName}
            set={set}
          />
          <StepFields node={node} set={set} variables={variables} choices={choices} />
        </>
      )}

      <p className={styles.quiet} data-testid="inspector-stats">
        {!statsRead
          ? t('inspector.statsUnread')
          : stats && stats.reached > 0
            ? stats.failed > 0
              ? t('inspector.statsFailed', { reached: stats.reached, failed: stats.failed })
              : t('inspector.stats', { reached: stats.reached })
            : t('noRuns')}
      </p>

      {node.type === TRIGGER_NODE ? null : removing ? (
        <div className={styles.confirm} role="alert">
          <p>
            {after > 0
              ? t('inspector.removeWithAfter', { count: after })
              : t('inspector.removeOne')}
          </p>
          <span className={styles.confirmActions}>
            <button type="button" className={styles.secondary} onClick={() => setRemoving(false)}>
              {t('inspector.keep')}
            </button>
            <button
              type="button"
              className={styles.danger}
              onClick={() => onGraph(removeStep(graph, node.id))}
              data-testid="inspector-remove-yes"
            >
              {t('inspector.remove')}
            </button>
          </span>
        </div>
      ) : (
        <button
          type="button"
          className={styles.textButton}
          onClick={() => setRemoving(true)}
          data-testid="inspector-remove"
        >
          <Trash2 size={12} aria-hidden="true" />
          {t('inspector.remove')}
        </button>
      )}
    </div>
  );
}

/**
 * ★★ AU4 (Backend 0c410009): in a cart reminder the FIRST message decides how
 * the customer is reached - a template is WhatsApp; a message, file or
 * buttons step names WhatsApp or email (an email with its subject, starting
 * as the automation's name). Its "if they can't be reached" step is tried on
 * the other channel and names its own. A channel that cannot reach anyone
 * (not connected) is offered with why, never chosen silently.
 */
function CartVia({
  node,
  graph,
  reach,
  automationName,
  set,
}: {
  readonly node: AutomationNode;
  readonly graph: Graph;
  readonly reach: { readonly whatsapp: boolean; readonly email: boolean } | null;
  readonly automationName: string;
  readonly set: (patch: Record<string, unknown>) => void;
}) {
  const t = useTranslations('automations');
  if (!graph.cart) return null;
  const first = cartFirstSend(graph);
  const fallbackId = first
    ? (graph.edges.find((e) => e.source === first.id && e.sourceHandle === UNREACHABLE_HANDLE)
        ?.target ?? null)
    : null;
  const isFirst = first?.id === node.id;
  const isFallback = fallbackId === node.id;
  if (!isFirst && !isFallback) return null;
  const note = isFallback ? (
    <p className={styles.quiet} data-testid="inspector-fallback-note">
      {t('inspector.fallbackNote')}
    </p>
  ) : null;
  if (node.type === 'send_message_template') {
    return (
      <>
        {note}
        <p className={styles.quiet} data-testid="inspector-template-whatsapp">
          {t('inspector.templateWhatsapp')}
        </p>
      </>
    );
  }
  if (!VIA_TYPES.has(node.type)) return note;
  const via = viaOf(node);
  return (
    <>
      {note}
      <div className={styles.checks} role="radiogroup" aria-label={t('inspector.via')}>
        <span className={styles.fieldLabel}>{t('inspector.via')}</span>
        {(['whatsapp', 'email'] as const).map((v) => {
          const off = reach !== null && reach[v] === false;
          return (
            <label key={v} className={styles.check}>
              <input
                type="radio"
                name={`via-${node.id}`}
                checked={via === v}
                disabled={off && via !== v}
                onChange={() =>
                  set(
                    v === 'email'
                      ? {
                          via: 'email',
                          subject: str(node.data.subject) || automationName.slice(0, 200),
                        }
                      : { via: 'whatsapp', subject: undefined },
                  )
                }
                data-testid={`inspector-via-${v}`}
              />
              {off ? t('inspector.viaNotConnected', { channel: t(`via.${v}`) }) : t(`via.${v}`)}
            </label>
          );
        })}
        {via === null ? <span className={styles.why}>{t('inspector.viaChoose')}</span> : null}
      </div>
      {via === 'email' ? (
        <Field label={t('inspector.subject')}>
          <input
            value={str(node.data.subject)}
            maxLength={200}
            onChange={(e) => set({ subject: e.target.value })}
            dir="auto"
            data-testid="inspector-subject"
          />
        </Field>
      ) : null}
    </>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
    </label>
  );
}

function Pick({
  label,
  value,
  options,
  onChange,
  testid,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly Named[] | null;
  readonly onChange: (id: string) => void;
  readonly testid: string;
}) {
  const t = useTranslations('automations');
  return (
    <Field label={label}>
      {options === null ? (
        <span className={styles.quiet}>{t('inspector.unread')}</span>
      ) : (
        <select value={value} onChange={(e) => onChange(e.target.value)} data-testid={testid}>
          <option value="">{t('inspector.choose')}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/** A duration in a unit people use; stored in ms. */
function Duration({
  label,
  ms,
  onChange,
  testid,
}: {
  readonly label: string;
  readonly ms: unknown;
  readonly onChange: (ms: number) => void;
  readonly testid: string;
}) {
  const t = useTranslations('automations');
  const value = typeof ms === 'number' && ms > 0 ? ms : 0;
  const unit =
    (['days', 'hours', 'minutes'] as const).find((u) => value > 0 && value % UNITS[u] === 0) ??
    'minutes';
  return (
    <Field label={label}>
      <span className={styles.duration}>
        <input
          type="number"
          min={1}
          value={value === 0 ? '' : value / UNITS[unit]}
          onChange={(e) => onChange(Math.max(0, Number(e.target.value)) * UNITS[unit])}
          data-testid={testid}
        />
        <select
          value={unit}
          onChange={(e) =>
            onChange((value / UNITS[unit] || 1) * UNITS[e.target.value as keyof typeof UNITS])
          }
          aria-label={t('inspector.unit')}
        >
          {(['minutes', 'hours', 'days'] as const).map((u) => (
            <option key={u} value={u}>
              {t(`inspector.units.${u}`)}
            </option>
          ))}
        </select>
      </span>
    </Field>
  );
}

/** Message text; variables go in as chips' words, at the cursor. */
function Message({
  value,
  onChange,
  variables,
}: {
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly variables: readonly string[];
}) {
  const t = useTranslations('automations');
  const box = useRef<HTMLTextAreaElement>(null);
  const insert = (name: string) => {
    const el = box.current;
    const token = `{{${name}}}`;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + token + value.slice(end));
  };
  return (
    <Field label={t('inspector.message')}>
      <textarea
        ref={box}
        value={value}
        rows={4}
        maxLength={4096}
        onChange={(e) => onChange(e.target.value)}
        dir="auto"
        data-testid="inspector-text"
      />
      {variables.length > 0 ? (
        <span className={styles.variables}>
          {variables
            .filter((v) => !v.includes('<'))
            .map((v) => (
              <button key={v} type="button" className={styles.variable} onClick={() => insert(v)}>
                {t(`variables.${v}` as 'variables.first_name')}
              </button>
            ))}
        </span>
      ) : null}
    </Field>
  );
}

function StepFields({
  node,
  set,
  variables,
  choices,
}: {
  readonly node: AutomationNode;
  readonly set: (patch: Record<string, unknown>) => void;
  readonly variables: readonly string[];
  readonly choices: Choices;
}) {
  const t = useTranslations('automations');
  const locale = useLocale();
  const d = node.data;
  switch (node.type) {
    case 'send_message_text':
      return (
        <Message value={str(d.text)} onChange={(text) => set({ text })} variables={variables} />
      );
    case 'send_buttons':
    case 'send_list': {
      const isList = node.type === 'send_list';
      const key = isList ? 'options' : 'buttons';
      const rows = Array.isArray(d[key])
        ? (d[key] as { id: string; title?: string; description?: string }[])
        : [];
      const max = isList ? LIMITS.listOptions : LIMITS.buttons;
      const titleMax = isList ? LIMITS.listTitle : LIMITS.buttonTitle;
      return (
        <>
          <Message value={str(d.text)} onChange={(text) => set({ text })} variables={variables} />
          {isList ? (
            <Field label={t('inspector.listButton')}>
              <input
                value={str(d.buttonText)}
                maxLength={20}
                onChange={(e) => set({ buttonText: e.target.value })}
                dir="auto"
              />
            </Field>
          ) : null}
          <span className={styles.fieldLabel}>
            {t(isList ? 'inspector.options' : 'inspector.buttons', { max })}
          </span>
          {rows.map((row, i) => (
            <span key={row.id} className={styles.option}>
              <input
                value={row.title ?? ''}
                maxLength={titleMax}
                aria-label={t('inspector.optionTitle', { n: i + 1 })}
                onChange={(e) =>
                  set({
                    [key]: rows.map((r) => (r.id === row.id ? { ...r, title: e.target.value } : r)),
                  })
                }
                dir="auto"
                data-testid={`inspector-option-${i}`}
              />
              <span className={styles.quiet}>{t('inspector.newBranch')}</span>
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => set({ [key]: rows.filter((r) => r.id !== row.id) })}
                aria-label={t('inspector.removeOption', { n: i + 1 })}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
          <button
            type="button"
            className={styles.textButton}
            disabled={rows.length >= max}
            title={rows.length >= max ? t('inspector.atMost', { max }) : undefined}
            onClick={() => set({ [key]: [...rows, { id: crypto.randomUUID(), title: '' }] })}
            data-testid="inspector-add-option"
          >
            {t(isList ? 'inspector.addOption' : 'inspector.addButton')}
          </button>
          {isList ? null : (
            <>
              <Off label={t('inspector.smsFallback')} />
              <Off label={t('inspector.headerImage')} />
            </>
          )}
        </>
      );
    }
    case 'send_message_file':
      return (
        <>
          <Field label={t('inspector.fileUrl')}>
            <input
              value={str(d.url)}
              onChange={(e) => set({ url: e.target.value })}
              placeholder="https://"
              dir="ltr"
            />
          </Field>
          <Field label={t('inspector.fileName')}>
            <input
              value={fileNameOf(d)}
              // The executor's key; an old draft's `fileName` is dropped as it is rewritten.
              onChange={(e) => set({ filename: e.target.value, fileName: undefined })}
              dir="auto"
              data-testid="inspector-file-name"
            />
          </Field>
          <Field label={t('inspector.caption')}>
            <input
              value={str(d.caption)}
              onChange={(e) => set({ caption: e.target.value })}
              dir="auto"
            />
          </Field>
        </>
      );
    case 'wait':
      return (
        <Duration
          label={t('inspector.waitFor')}
          ms={d.durationMs}
          onChange={(durationMs) => set({ durationMs })}
          testid="inspector-duration"
        />
      );
    case 'wait_for_reply':
      return (
        <Duration
          label={t('inspector.timeout')}
          ms={d.timeoutMs}
          onChange={(timeoutMs) => set({ timeoutMs })}
          testid="inspector-duration"
        />
      );
    case 'ab_split':
      return (
        <Field label={t('inspector.percentA')}>
          <input
            type="number"
            min={1}
            max={99}
            value={typeof d.percentA === 'number' ? d.percentA : ''}
            onChange={(e) => set({ percentA: Math.min(99, Math.max(1, Number(e.target.value))) })}
          />
        </Field>
      );
    case 'language': {
      const on = strs(d.languages);
      return (
        <div className={styles.checks} role="group" aria-label={t('inspector.languages')}>
          <span className={styles.fieldLabel}>{t('inspector.languages')}</span>
          {LANGUAGES.map((lang) => (
            <label key={lang} className={styles.check}>
              <input
                type="checkbox"
                checked={on.includes(lang)}
                onChange={(e) =>
                  set({
                    languages: e.target.checked ? [...on, lang] : on.filter((l) => l !== lang),
                  })
                }
              />
              {new Intl.DisplayNames([locale], { type: 'language' }).of(lang)}
            </label>
          ))}
        </div>
      );
    }
    case 'opening_hours':
    case 'segment':
    case 'split_channel':
      return <p className={styles.quiet}>{t(`inspector.about.${node.type}`)}</p>;
    case 'assign':
      return (
        <>
          <div className={styles.checks} role="radiogroup" aria-label={t('inspector.assignTo')}>
            {(['team', 'person'] as const).map((to) => (
              <label key={to} className={styles.check}>
                <input type="radio" checked={d.to === to} onChange={() => set({ to })} />
                {t(`inspector.to.${to}`)}
              </label>
            ))}
          </div>
          {d.to === 'person' ? (
            <Pick
              label={t('inspector.person')}
              value={str(d.userId)}
              options={choices.members}
              onChange={(userId) => set({ userId })}
              testid="inspector-person"
            />
          ) : (
            <Pick
              label={t('inspector.team')}
              value={str(d.departmentId)}
              options={choices.teams}
              onChange={(departmentId) => set({ departmentId })}
              testid="inspector-team"
            />
          )}
        </>
      );
    case 'hand_to_ai':
      return (
        <Pick
          label={t('inspector.employee')}
          value={str(d.aiAgentId)}
          options={choices.employees}
          onChange={(aiAgentId) => set({ aiAgentId })}
          testid="inspector-employee"
        />
      );
    case 'run_skill':
      return (
        <>
          <Pick
            label={t('inspector.skill')}
            value={str(d.skillId)}
            options={choices.skills}
            onChange={(skillId) => set({ skillId })}
            testid="inspector-skill"
          />
          <Pick
            label={t('inspector.employee')}
            value={str(d.aiAgentId)}
            options={choices.employees}
            onChange={(aiAgentId) => set({ aiAgentId })}
            testid="inspector-employee"
          />
        </>
      );
    case 'ai_generate':
      return (
        <>
          <Field label={t('inspector.prompt')}>
            <textarea
              value={str(d.prompt)}
              rows={4}
              onChange={(e) => set({ prompt: e.target.value })}
              placeholder={t('inspector.promptHint')}
              dir="auto"
              data-testid="inspector-prompt"
            />
          </Field>
          <Pick
            label={t('inspector.writer')}
            value={str(d.aiAgentId)}
            options={choices.employees}
            onChange={(aiAgentId) => set({ aiAgentId })}
            testid="inspector-writer"
          />
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={d.send !== false}
              onChange={(e) => set({ send: e.target.checked })}
              data-testid="inspector-send"
            />
            {t('inspector.sendIt')}
          </label>
          {d.send === false ? (
            <Field label={t('inspector.keepAs')}>
              <input
                value={str(d.responseVariable)}
                onChange={(e) => set({ responseVariable: e.target.value })}
                dir="ltr"
              />
            </Field>
          ) : null}
        </>
      );
    case 'send_message_template': {
      const template = choices.templates?.find((x) => x.id === str(d.templateId)) ?? null;
      const values =
        d.variables && typeof d.variables === 'object'
          ? (d.variables as Record<string, string>)
          : {};
      return (
        <>
          <Pick
            label={t('inspector.template')}
            value={str(d.templateId)}
            options={choices.templates ?? null}
            onChange={(templateId) => set({ templateId, variables: {} })}
            testid="inspector-template"
          />
          {choices.templates && choices.templates.length === 0 ? (
            <p className={styles.quiet}>{t('inspector.noTemplates')}</p>
          ) : null}
          {template?.variables.map((key) => (
            <Field key={key} label={t('inspector.templateVar', { key })}>
              <input
                value={values[key] ?? ''}
                onChange={(e) => set({ variables: { ...values, [key]: e.target.value } })}
                dir="auto"
                data-testid={`inspector-template-var-${key}`}
              />
            </Field>
          ))}
          {template && variables.length > 0 ? (
            <p className={styles.quiet}>
              {t('inspector.templateVarsHint', {
                list: variables.map((v) => `{{${v}}}`).join(' '),
              })}
            </p>
          ) : null}
        </>
      );
    }
    case 'send_comment_reply':
      return (
        <>
          <div className={styles.checks} role="radiogroup" aria-label={t('inspector.replyAs')}>
            {(['text', 'ai'] as const).map((mode) => (
              <label key={mode} className={styles.check}>
                <input
                  type="radio"
                  checked={(str(d.mode) || 'text') === mode}
                  onChange={() => set({ mode })}
                />
                {t(`inspector.replyMode.${mode}`)}
              </label>
            ))}
          </div>
          {d.mode === 'ai' ? (
            <Pick
              label={t('inspector.writer')}
              value={str(d.agentId)}
              options={choices.employees}
              onChange={(agentId) => set({ agentId })}
              testid="inspector-reply-writer"
            />
          ) : (
            <Field label={t('inspector.reply')}>
              <input
                value={str(d.text)}
                onChange={(e) => set({ text: e.target.value })}
                dir="auto"
              />
            </Field>
          )}
        </>
      );
    case 'add_tag':
      return (
        <Field label={t('inspector.tag')}>
          <input
            value={str(d.tag)}
            maxLength={60}
            onChange={(e) => set({ tag: e.target.value })}
            dir="auto"
            data-testid="inspector-tag"
          />
        </Field>
      );
    case 'create_task':
      return (
        <>
          <Field label={t('inspector.taskTitle')}>
            <input
              value={str(d.title)}
              onChange={(e) => set({ title: e.target.value })}
              dir="auto"
              data-testid="inspector-task"
            />
          </Field>
          <Field label={t('inspector.taskBody')}>
            <textarea
              value={str(d.body)}
              rows={3}
              onChange={(e) => set({ body: e.target.value })}
              dir="auto"
            />
          </Field>
          <Duration
            label={t('inspector.due')}
            ms={typeof d.dueInMinutes === 'number' ? d.dueInMinutes * 60_000 : undefined}
            onChange={(ms) => set({ dueInMinutes: Math.round(ms / 60_000) })}
            testid="inspector-due"
          />
          <p className={styles.quiet}>{t('inspector.taskWhere')}</p>
        </>
      );
    case 'notify_team':
      return (
        <>
          <Field label={t('inspector.notification')}>
            <textarea
              value={str(d.message)}
              rows={3}
              onChange={(e) => set({ message: e.target.value })}
              dir="auto"
              data-testid="inspector-notify"
            />
          </Field>
          <Pick
            label={t('inspector.team')}
            value={str(d.departmentId)}
            options={choices.teams}
            onChange={(departmentId) => set({ departmentId: departmentId || undefined })}
            testid="inspector-notify-team"
          />
        </>
      );
    case 'close_conversation':
      return (
        <Field label={t('inspector.closingMessage')}>
          <textarea
            value={str(d.message)}
            rows={3}
            onChange={(e) => set({ message: e.target.value })}
            dir="auto"
          />
        </Field>
      );
    default:
      return <p className={styles.why}>{t('inspector.notHere')}</p>;
  }
}

/** A setting the design draws and the route does not store: off, saying so. */
function Off({ label }: { readonly label: string }) {
  const t = useTranslations('automations');
  return <UnavailableItem title={label} tag={t('notYet')} why={t('inspector.notStored')} />;
}

function TriggerFields({
  trigger,
  automationId,
  webhook: initialWebhook,
  onTrigger,
}: {
  readonly trigger: Trigger;
  readonly automationId: string;
  readonly webhook: WebhookTrigger | null;
  readonly onTrigger: (trigger: Trigger) => void;
}) {
  const t = useTranslations('automations');
  const c = trigger.config;
  const set = (patch: Record<string, unknown>) =>
    onTrigger({ ...trigger, config: { ...c, ...patch } });
  const channels = strs(c.channels);
  const [lists, setLists] = useState<Record<string, string>>({});
  const [tags, setTags] = useState(strs(c.tags).join(', '));
  const [webhook, setWebhook] = useState(initialWebhook);
  const [failed, setFailed] = useState(false);
  const [isMaking, start] = useTransition();
  const origin = useSyncExternalStore(
    noSubscription,
    () => window.location.origin,
    () => '',
  );
  const split = (v: string) =>
    v
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

  const channelList = trigger.type ? CHANNELS_OF[trigger.type] : undefined;
  const channelPicker = channelList ? (
    <div className={styles.checks} role="group" aria-label={t('inspector.channels')}>
      <span className={styles.fieldLabel}>{t('inspector.channels')}</span>
      {channelList.map((ch) => (
        <label key={ch} className={styles.check}>
          <input
            type="checkbox"
            checked={channels.includes(ch)}
            onChange={(e) =>
              set({
                channels: e.target.checked ? [...channels, ch] : channels.filter((x) => x !== ch),
              })
            }
            data-testid={`inspector-channel-${ch}`}
          />
          {t(`channels.${ch}` as 'channels.WHATSAPP')}
        </label>
      ))}
      <span className={styles.quiet}>{t('inspector.anyChannel')}</span>
    </div>
  ) : null;
  /** A list typed with commas, kept as written while typing and saved as its items. */
  const listField = (key: string, label: string, hint: string, testid: string) => (
    <Field label={label}>
      <input
        value={lists[key] ?? strs(c[key]).join(', ')}
        onChange={(e) => {
          setLists({ ...lists, [key]: e.target.value });
          set({ [key]: split(e.target.value) });
        }}
        placeholder={hint}
        dir="auto"
        data-testid={testid}
      />
    </Field>
  );
  const matchField =
    strs(c.keywords).length > 0 ? (
      <Field label={t('inspector.match')}>
        <select value={str(c.match) || 'contains'} onChange={(e) => set({ match: e.target.value })}>
          {(['contains', 'exact', 'any_word'] as const).map((m) => (
            <option key={m} value={m}>
              {t(`inspector.matches.${m}`)}
            </option>
          ))}
        </select>
      </Field>
    ) : null;

  switch (trigger.type) {
    case 'message_received':
      return (
        <>
          {channelPicker}
          {listField(
            'keywords',
            t('inspector.keywords'),
            t('inspector.keywordsHint'),
            'inspector-keywords',
          )}
          {matchField}
        </>
      );
    case 'new_customer':
      return channelPicker;
    case 'message_from_ad':
      return (
        <>
          {channelPicker}
          {listField('adIds', t('inspector.adIds'), t('inspector.adIdsHint'), 'inspector-ad-ids')}
        </>
      );
    case 'button_tapped':
      return (
        <>
          {channelPicker}
          {listField(
            'payloads',
            t('inspector.payloads'),
            t('inspector.payloadsHint'),
            'inspector-payloads',
          )}
        </>
      );
    case 'comment_received':
      return (
        <>
          {channelPicker}
          {listField(
            'postIds',
            t('inspector.postIds'),
            t('inspector.postIdsHint'),
            'inspector-post-ids',
          )}
          {listField(
            'keywords',
            t('inspector.keywords'),
            t('inspector.keywordsHint'),
            'inspector-keywords',
          )}
          {matchField}
        </>
      );
    case 'cart_abandoned': {
      const minutes = typeof c.delayMinutes === 'number' ? c.delayMinutes : 120;
      return (
        <>
          <p className={styles.quiet} data-testid="inspector-cart-channel">
            {t('inspector.cartChannel')}
          </p>
          <Duration
            label={t('inspector.cartDelay')}
            ms={minutes * 60_000}
            onChange={(ms) =>
              set({
                delayMinutes: Math.min(
                  CART_DELAY.max,
                  Math.max(CART_DELAY.min, Math.round(ms / 60_000)),
                ),
              })
            }
            testid="inspector-cart-delay"
          />
          <p className={styles.quiet}>{t('inspector.cartDelayRange')}</p>
          {/* The route's own rule, said where the trigger is set. */}
          <p className={styles.why} data-testid="inspector-cart-consent">
            {t('inspector.cartConsent')}
          </p>
        </>
      );
    }
    case 'order_event': {
      const statuses = strs(c.statuses);
      return (
        <>
          {channelPicker}
          <div className={styles.checks} role="group" aria-label={t('inspector.orderStatuses')}>
            <span className={styles.fieldLabel}>{t('inspector.orderStatuses')}</span>
            {ORDER_STATUSES.map((status) => (
              <label key={status} className={styles.check}>
                <input
                  type="checkbox"
                  checked={statuses.includes(status)}
                  onChange={(e) =>
                    set({
                      statuses: e.target.checked
                        ? [...statuses, status]
                        : statuses.filter((x) => x !== status),
                    })
                  }
                  data-testid={`inspector-order-${status}`}
                />
                {t(`inspector.orderStatus.${status}`)}
              </label>
            ))}
            <span className={styles.quiet}>{t('inspector.anyOrderStatus')}</span>
          </div>
          {/* The route's own rule, said where the trigger is set. */}
          <p className={styles.why} data-testid="inspector-order-template-only">
            {t('inspector.orderTemplateOnly')}
          </p>
        </>
      );
    }
    case 'story_mention':
      return (
        <p className={styles.quiet} data-testid="inspector-story-mention">
          {t('inspector.storyMention')}
        </p>
      );
    case 'tag_added':
      return (
        <Field label={t('new.tags')}>
          <input
            value={tags}
            onChange={(e) => {
              setTags(e.target.value);
              set({ tags: split(e.target.value) });
            }}
            dir="auto"
          />
        </Field>
      );
    case 'schedule': {
      const days = strs(c.days);
      return (
        <>
          <Field label={t('new.at')}>
            <input type="time" value={str(c.at)} onChange={(e) => set({ at: e.target.value })} />
          </Field>
          <div className={styles.checks} role="group" aria-label={t('new.days')}>
            <span className={styles.fieldLabel}>{t('new.days')}</span>
            {DAYS.map((day) => (
              <label key={day} className={styles.check}>
                <input
                  type="checkbox"
                  checked={days.includes(day)}
                  onChange={(e) =>
                    set({ days: e.target.checked ? [...days, day] : days.filter((x) => x !== day) })
                  }
                />
                {t(`days.${day}`)}
              </label>
            ))}
            <span className={styles.quiet}>{t('new.everyDay')}</span>
          </div>
        </>
      );
    }
    case 'webhook':
      return webhook ? (
        <>
          <Field label={t('inspector.webhookUrl')}>
            <input
              readOnly
              value={origin ? `${origin}${webhook.path}` : webhook.path}
              dir="ltr"
              data-testid="inspector-webhook-url"
            />
          </Field>
          <Field label={t('inspector.webhookSecret')}>
            <input readOnly value={webhook.secret} dir="ltr" type="password" />
          </Field>
          <p className={styles.quiet}>{t('inspector.webhookHow')}</p>
        </>
      ) : (
        <>
          <p className={styles.quiet}>{t('inspector.webhookNone')}</p>
          <button
            type="button"
            className={styles.secondary}
            disabled={isMaking}
            onClick={() =>
              start(async () => {
                const made = await provisionWebhook(automationId);
                setFailed(made === null);
                if (made) setWebhook(made);
              })
            }
            data-testid="inspector-webhook-make"
          >
            {t('inspector.webhookMake')}
          </button>
          {failed ? <p className={styles.problem}>{t('inspector.webhookFailed')}</p> : null}
        </>
      );
    default:
      return <p className={styles.quiet}>{t('inspector.triggerAsIs')}</p>;
  }
}
