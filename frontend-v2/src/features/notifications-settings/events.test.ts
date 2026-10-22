import { describe, expect, it } from 'vitest';

import { EVENT_FAMILIES, NOTIFIABLE_EVENTS, UNFIRING_EVENTS, eventsInFamily } from './events';

/**
 * The vocabulary is a deliberate snapshot of a platform that declares its
 * event types in three separate, drifted unions. These tests pin the
 * decisions that made it 22 rather than 28, so a later edit that quietly
 * reintroduces a dead type fails here rather than on someone's screen.
 */
describe('notifiable events', () => {
  it('offers exactly the 22 that are both templated and emitted', () => {
    expect(NOTIFIABLE_EVENTS).toHaveLength(22);
  });

  it('never offers an event nothing emits', () => {
    // A rule written against one of these can never fire, and the admin who
    // wrote it would believe they had configured something. `system.error.
    // critical` is the sharpest case: the notification for the one thing an
    // operator most wants to be woken up about cannot happen.
    const offered = new Set(NOTIFIABLE_EVENTS.map((e) => e.type));
    for (const dead of UNFIRING_EVENTS) {
      expect(offered.has(dead), `${dead} is offered but nothing emits it`).toBe(false);
    }
  });

  it('has no duplicates', () => {
    const types = NOTIFIABLE_EVENTS.map((e) => e.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it('places every event in a family, and every family has events', () => {
    // 22 ungrouped rows is a wall; the grouping is what makes it readable.
    for (const event of NOTIFIABLE_EVENTS) {
      expect(EVENT_FAMILIES).toContain(event.family);
    }
    for (const family of EVENT_FAMILIES) {
      expect(eventsInFamily(family).length).toBeGreaterThan(0);
    }
  });

  it('keeps the three events whose meaning the source qualifies', () => {
    // Their emitters carry comments explaining what they do NOT mean, and
    // those comments are the copy - the design's wording for at least one of
    // them promises monitoring that does not exist.
    const caveated = NOTIFIABLE_EVENTS.filter((e) => e.hasSourceCaveat).map((e) => e.type);
    expect(caveated).toEqual([
      'conversation.assigned',
      'integration.check_failed',
      'broadcast.completed',
    ]);
  });
});
