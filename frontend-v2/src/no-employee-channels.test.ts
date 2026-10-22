import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { employeeSchema } from '@/api/contracts/employees';
import { emptyPlan } from '@/features/employees/hire/hire-plan';

/**
 * ★★ An employee has no channels of its own (Omer; Backend, 2026-10-07):
 * `AIAgent.channels` is read by nothing at runtime - where an employee answers
 * is the playbook's and the automations' (`route_target`, `hand_to_ai`). So
 * nothing in v2 reads it, draws it, or sends it: not the hire flow, not 07f,
 * not 07e, not 07's card, not 09b's head.
 *
 * ★ Granularity: the contract's shape, the hire plan's shape, and, by text,
 *   every employees file for a read of the field (`employee.channels`) or a
 *   `channels=` prop - a read under another name is not seen. When Backend's `/:id/reachability` arrives, this changes with it.
 */
const ROOTS = [
  join(process.cwd(), 'src/features/employees'),
  join(process.cwd(), 'src/app/[locale]/(app)/studio/employees'),
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("★★ nothing in v2 reads, draws or sends an employee's channels", () => {
  it('the contract has no channels (the route may still send it; it is dropped)', () => {
    const parsed = employeeSchema.parse({ id: 'a', name: 'A', channels: ['whatsapp'] });
    expect(parsed).not.toHaveProperty('channels');
  });

  it('the hire plan holds none, so the builder is never sent any', () => {
    expect(emptyPlan([])).not.toHaveProperty('channels');
  });

  it('no employees file reads `.channels`', () => {
    const all = ROOTS.flatMap(files);
    expect(all.length).toBeGreaterThan(10);
    // A read of the field (`employee.channels`, `plan.channels`) or a prop -
    // not the word: 09b's "Channels" tab is a link to Settings, and comments say why.
    const READ = /\b(employee|plan|editing|hired|selected|e|agent)\.channels\b|\bchannels=\{/;
    const reads = all.filter((path) => READ.test(readFileSync(path, 'utf8')));
    expect(reads.map((p) => p.slice(process.cwd().length + 1))).toEqual([]);
  });
});
