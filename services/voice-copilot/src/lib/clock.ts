export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): { cancel(): void };
  setInterval(fn: () => void, ms: number): { cancel(): void };
}

export const systemClock: Clock = {
  now(): number {
    return Date.now();
  },
  setTimeout(fn: () => void, ms: number): { cancel(): void } {
    const handle = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(handle) };
  },
  setInterval(fn: () => void, ms: number): { cancel(): void } {
    const handle = setInterval(fn, ms);
    return { cancel: () => clearInterval(handle) };
  },
};

export interface FakeClock extends Clock {
  advance(ms: number): void;
}

export function createFakeClock(): FakeClock {
  let _now = 0;
  type ScheduledItem = { at: number; fn: () => void; interval?: number; cancelled: boolean };
  const items: ScheduledItem[] = [];

  function tick() {
    const ready = items.filter((i) => !i.cancelled && i.at <= _now);
    for (const item of ready) {
      if (!item.cancelled) {
        item.fn();
        if (item.interval !== undefined) {
          item.at = _now + item.interval;
        } else {
          item.cancelled = true;
        }
      }
    }
  }

  return {
    now(): number {
      return _now;
    },
    setTimeout(fn: () => void, ms: number): { cancel(): void } {
      const item: ScheduledItem = { at: _now + ms, fn, cancelled: false };
      items.push(item);
      return { cancel: () => { item.cancelled = true; } };
    },
    setInterval(fn: () => void, ms: number): { cancel(): void } {
      const item: ScheduledItem = { at: _now + ms, fn, interval: ms, cancelled: false };
      items.push(item);
      return { cancel: () => { item.cancelled = true; } };
    },
    advance(ms: number): void {
      const target = _now + ms;
      // Step through in 1ms increments to fire intervals correctly
      while (_now < target) {
        _now = Math.min(_now + 1, target);
        tick();
      }
    },
  };
}
