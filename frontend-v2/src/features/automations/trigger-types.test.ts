import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CATALOG_NAMES, TRIGGER_TYPES } from '@/api/contracts/automations';
import en from '@/i18n/messages/en/automations.json';
import he from '@/i18n/messages/he/automations.json';

import { NODE_ICON } from './node-icons';

/**
 * ★★ THE ROUTE'S LIST, NOT OURS. A trigger the route has and this screen
 *   lacks is read as `null`: mislabelled in the list, and picked in New
 *   automation it does nothing (conversation_started, 2026-11-02). Read from
 *   the route's source, so the next one added there fails here.
 */
describe('★★ every trigger the route knows, this screen knows', () => {
  const source = readFileSync(
    resolve(__dirname, '../../../../services/chatbot/src/lib/automation-catalog.ts'),
    'utf8',
  );
  const list = /export const TRIGGER_TYPES = \[([^\]]*)\]/.exec(source)?.[1];

  it("the route's TRIGGER_TYPES, all of them", () => {
    expect(list).toBeDefined();
    const route = [...list!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(route.length).toBeGreaterThan(10);
    expect([...TRIGGER_TYPES].sort()).toEqual([...route].sort());
  });

  it.each(TRIGGER_TYPES)(
    '%s: a name, a line and a "when" in both languages, and a mark',
    (type) => {
      for (const messages of [en, he]) {
        const nodes = messages.nodes.trigger as Record<string, string>;
        const lines = messages.lines.trigger as Record<string, string>;
        const when = messages.when as Record<string, string>;
        expect(nodes[type], `nodes.trigger.${type}`).toBeTruthy();
        expect(lines[type], `lines.trigger.${type}`).toBeTruthy();
        expect(when[type], `when.${type}`).toBeTruthy();
      }
      expect(CATALOG_NAMES[`trigger:${type}`]).toBeTruthy();
      expect(NODE_ICON[`trigger:${type}`]).toBeDefined();
    },
  );
});
