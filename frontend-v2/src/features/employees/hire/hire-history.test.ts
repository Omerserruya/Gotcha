import { describe, expect, it } from 'vitest';

import { backIsHistory, hireDoor, hireStepOf, isHireDoor, openDoor } from './hire-history';

describe('★ H-back - the hire’s history entries', () => {
  it('the step an address shows; not the hire at all is null', () => {
    expect(hireStepOf('?hire=1&step=3')).toBe(3);
    expect(hireStepOf('?hire=1')).toBe(1);
    expect(hireStepOf('?hire=1&step=9')).toBe(1);
    expect(hireStepOf('')).toBeNull();
    expect(hireStepOf('?employee=a&step=2')).toBeNull();
  });

  it('Back is a history back only from an entry pushed from the step before', () => {
    expect(backIsHistory({ hireStep: 3, hireFrom: 2 }, 3)).toBe(true);
    // A jump from the summary, a reload, an entry it did not push: no.
    expect(backIsHistory({ hireStep: 2, hireFrom: 4 }, 2)).toBe(false);
    expect(backIsHistory({ hireStep: 3, hireFrom: 3 }, 3)).toBe(false);
    expect(backIsHistory(null, 3)).toBe(false);
    expect(backIsHistory({ hireStep: 2, hireFrom: 1 }, 3)).toBe(false);
  });

  it('the door: made once, on an entry that is neither a step nor a door', () => {
    expect(openDoor(null)).toBe(true);
    expect(openDoor({ __NA: true })).toBe(true);
    expect(openDoor({ hireStep: 1, hireFrom: 1 })).toBe(false);
    expect(openDoor(hireDoor())).toBe(false);
    expect(isHireDoor({ __NA: true, hireDoor: true })).toBe(true);
    expect(isHireDoor({ hireStep: 1 })).toBe(false);
    // A new object each time: the router writes into the one it is given.
    expect(hireDoor()).not.toBe(hireDoor());
  });
});
