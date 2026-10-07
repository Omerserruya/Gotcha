import type { AutomationEdge, AutomationNode, TriggerType } from '@/api/contracts/automations';

import { TRIGGER_NODE } from './graph';

/**
 * 09c's templates (Omer, 2026-10-07): the ones that run today create a real
 * draft with its graph filled in - never turned on; the author fills what is
 * theirs (the file, the message) and publishes. The ones whose trigger has
 * no event source yet are drawn as unavailable, unmistakably, and do nothing.
 */
export const TEMPLATE_KEYS = [
  'fileOnKeyword',
  'afterHours',
  'welcome',
  'tagNotify',
  'missedCall',
  'review',
  'cart',
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export interface Template {
  readonly key: TemplateKey;
  readonly trigger: TriggerType;
  /** `null`: no event source yet - drawn, unavailable. */
  readonly build: ((words: TemplateWords, newId: () => string) => TemplateGraph) | null;
}

/** The template's words in the author's language - prefilled, theirs to change. */
export interface TemplateWords {
  /** The example keyword ("catalogue"). */
  readonly keyword: string;
  /** The welcome, with {{first_name}}. */
  readonly welcome: string;
}

export interface TemplateGraph {
  readonly config: Record<string, unknown>;
  readonly nodes: readonly AutomationNode[];
  readonly edges: readonly AutomationEdge[];
}

const node = (id: string, type: string, data: Record<string, unknown> = {}): AutomationNode => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data,
});
const edge = (id: string, source: string, target: string, sourceHandle: string | null = null) => ({
  id,
  source,
  target,
  sourceHandle,
});

export const TEMPLATES: readonly Template[] = [
  {
    // Someone writes "catalogue" → the file. The file is the author's to add.
    key: 'fileOnKeyword',
    trigger: 'message_received',
    build: (words, id) => {
      const send = id();
      return {
        config: { keywords: [words.keyword], match: 'contains' },
        nodes: [
          node('trigger', TRIGGER_NODE),
          node(send, 'send_message_file', { url: '', fileName: '', caption: '' }),
        ],
        edges: [edge(id(), 'trigger', send)],
      };
    },
  },
  {
    // A message after hours → the hours; while open, nothing (the employee answers).
    key: 'afterHours',
    trigger: 'message_received',
    build: (_words, id) => {
      const hours = id();
      const reply = id();
      return {
        config: {},
        nodes: [
          node('trigger', TRIGGER_NODE),
          node(hours, 'opening_hours'),
          node(reply, 'send_message_text', { text: '' }),
        ],
        edges: [edge(id(), 'trigger', hours), edge(id(), hours, reply, 'closed')],
      };
    },
  },
  {
    // The first message ever → a welcome by name.
    key: 'welcome',
    trigger: 'new_customer',
    build: (words, id) => {
      const hello = id();
      return {
        config: {},
        nodes: [
          node('trigger', TRIGGER_NODE),
          node(hello, 'send_message_text', { text: words.welcome }),
        ],
        edges: [edge(id(), 'trigger', hello)],
      };
    },
  },
  {
    // A tag added → the team told. The tags are asked when it is created (the route needs one).
    key: 'tagNotify',
    trigger: 'tag_added',
    build: (_words, id) => {
      const tell = id();
      return {
        config: {},
        nodes: [node('trigger', TRIGGER_NODE), node(tell, 'notify_team', { message: '' })],
        edges: [edge(id(), 'trigger', tell)],
      };
    },
  },
  // No event source yet (catalogue: no_event_source; call_missed is not wired to voice events).
  { key: 'missedCall', trigger: 'call_missed', build: null },
  { key: 'review', trigger: 'order_event', build: null },
  { key: 'cart', trigger: 'cart_abandoned', build: null },
];

export function templateOf(key: string | undefined): Template | null {
  return TEMPLATES.find((t) => t.key === key) ?? null;
}

/**
 * What the author still has to fill in, per step - drawn "to fill in" on the
 * canvas, not as an error. A message with no text, a file with no address,
 * a notification with nothing to say, a tag with no name, a task with no
 * title, a hand-over to nobody.
 */
export function needsFilling(node: AutomationNode): boolean {
  const d = node.data;
  const empty = (v: unknown) => typeof v !== 'string' || v.trim() === '';
  switch (node.type) {
    case 'send_message_text':
      return empty(d.text);
    case 'send_message_file':
      return empty(d.url);
    case 'send_buttons':
      return (
        empty(d.text) ||
        !Array.isArray(d.buttons) ||
        d.buttons.length === 0 ||
        (d.buttons as { title?: unknown }[]).some((b) => empty(b?.title))
      );
    case 'notify_team':
      return empty(d.message);
    case 'add_tag':
      return empty(d.tag);
    case 'create_task':
      return empty(d.title);
    case 'hand_to_ai':
      return empty(d.aiAgentId);
    case 'run_skill':
      return empty(d.skillId) || empty(d.aiAgentId);
    default:
      return false;
  }
}
