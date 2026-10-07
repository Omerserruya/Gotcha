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
  'cart',
  'fromAd',
  'missedCall',
  'review',
  'comment',
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
  /** From an ad: the opening, with {{first_name}}, and its two buttons. */
  readonly adText: string;
  readonly prices: string;
  readonly talk: string;
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
  {
    // Cart left behind (Backend 972ae66d): after 2 hours a template - outside
    // the 24-hour window only an approved template may go - then a day later
    // a second one. Both templates are the author's to choose.
    key: 'cart',
    trigger: 'cart_abandoned',
    build: (_words, id) => {
      const first = id();
      const wait = id();
      const second = id();
      return {
        config: { delayMinutes: 120 },
        nodes: [
          node('trigger', TRIGGER_NODE),
          node(first, 'send_message_template', { templateId: '', variables: {} }),
          node(wait, 'wait', { durationMs: 24 * 60 * 60 * 1000 }),
          node(second, 'send_message_template', { templateId: '', variables: {} }),
        ],
        edges: [edge(id(), 'trigger', first), edge(id(), first, wait), edge(id(), wait, second)],
      };
    },
  },
  {
    // From an ad → reply: thanks by name, two buttons; "Talk to us" goes to an
    // employee (the author chooses who); "Prices" is theirs to fill.
    key: 'fromAd',
    trigger: 'message_from_ad',
    build: (words, id) => {
      const ask = id();
      const wait = id();
      const hand = id();
      return {
        config: {},
        nodes: [
          node('trigger', TRIGGER_NODE),
          node(ask, 'send_buttons', {
            text: words.adText,
            buttons: [
              { id: 'prices', title: words.prices },
              { id: 'talk', title: words.talk },
            ],
          }),
          node(wait, 'wait_for_reply', { timeoutMs: 30 * 60 * 1000 }),
          node(hand, 'hand_to_ai', { aiAgentId: '' }),
        ],
        edges: [
          edge(id(), 'trigger', ask),
          edge(id(), ask, wait),
          edge(id(), wait, hand, 'btn:talk'),
        ],
      };
    },
  },
  // No event source yet (call_missed is not wired to voice events; order and
  // comment events are being built).
  { key: 'missedCall', trigger: 'call_missed', build: null },
  { key: 'review', trigger: 'order_event', build: null },
  { key: 'comment', trigger: 'comment_received', build: null },
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
    case 'ai_generate':
      return empty(d.aiAgentId);
    case 'send_message_template':
      return empty(d.templateId);
    case 'send_comment_reply':
      return d.mode === 'ai' ? empty(d.agentId) : empty(d.text);
    default:
      return false;
  }
}
