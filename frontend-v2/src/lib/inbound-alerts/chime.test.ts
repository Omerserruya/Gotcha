import { describe, expect, it, vi } from 'vitest';

import { CHIME_PEAK, Chime } from './chime';

/** An AudioContext that records what it was asked to make. */
function fakeAudio(initial: AudioContextState, resumes = true) {
  const oscillators: { type: string; frequency: number; start: number; stop: number }[] = [];
  const peaks: number[] = [];
  class FakeContext {
    state: AudioContextState = initial;
    currentTime = 0;
    destination = {};
    resume = vi.fn(async () => {
      if (resumes) this.state = 'running';
    });
    createOscillator() {
      const o = { type: '', frequency: 0, start: 0, stop: 0 };
      oscillators.push(o);
      return {
        set type(value: string) {
          o.type = value;
        },
        frequency: { setValueAtTime: (v: number) => (o.frequency = v) },
        connect: () => {},
        start: (t: number) => (o.start = t),
        stop: (t: number) => (o.stop = t),
      };
    }
    createGain() {
      return {
        gain: {
          setValueAtTime: () => {},
          exponentialRampToValueAtTime: (v: number) => peaks.push(v),
        },
        connect: () => {},
      };
    }
  }
  const made: FakeContext[] = [];
  const Ctor = vi.fn(function (this: unknown) {
    const context = new FakeContext();
    made.push(context);
    return context;
  }) as unknown as new () => AudioContext;
  return { Ctor, made, oscillators, peaks };
}

const env = (Ctor: (new () => AudioContext) | undefined) => ({
  // An element stands in for the window: jsdom's bare EventTarget cannot take a touch listener.
  window: document.createElement('div') as unknown as Window,
  AudioContext: Ctor,
});

describe('★ the chime', () => {
  it('★ before any gesture: plays nothing, makes no context, throws nothing', () => {
    const audio = fakeAudio('running');
    const chime = new Chime(env(audio.Ctor));
    chime.prime();
    expect(chime.play()).toBe(false);
    expect(audio.Ctor).not.toHaveBeenCalled();
  });

  it('★ the first gesture makes the context; then it plays two soft sine notes, ~250ms', () => {
    const audio = fakeAudio('running');
    const e = env(audio.Ctor);
    const chime = new Chime(e);
    chime.prime();
    e.window.dispatchEvent(new Event('pointerdown'));
    expect(chime.play()).toBe(true);
    expect(audio.oscillators).toHaveLength(2);
    expect(audio.oscillators.every((o) => o.type === 'sine')).toBe(true);
    expect(audio.oscillators[1]!.frequency).toBeGreaterThan(audio.oscillators[0]!.frequency);
    const length = Math.max(...audio.oscillators.map((o) => o.stop)) - audio.oscillators[0]!.start;
    expect(length).toBeGreaterThan(0.2);
    expect(length).toBeLessThan(0.32);
    expect(Math.max(...audio.peaks)).toBe(CHIME_PEAK);
    expect(CHIME_PEAK).toBeLessThanOrEqual(0.1);
  });

  it('★ blocked (the context stays suspended): nothing now, a resume asked, no error', () => {
    // The browser keeps it suspended: resume() never takes.
    const audio = fakeAudio('suspended', false);
    const e = env(audio.Ctor);
    const chime = new Chime(e);
    chime.prime();
    e.window.dispatchEvent(new Event('keydown'));
    expect(chime.play()).toBe(false);
    expect(audio.oscillators).toHaveLength(0);
    expect(audio.made[0]!.resume).toHaveBeenCalled();
  });

  it('a browser with no Web Audio: nothing, and no error', () => {
    const e = env(undefined);
    const chime = new Chime(e);
    chime.prime();
    e.window.dispatchEvent(new Event('pointerdown'));
    expect(chime.play()).toBe(false);
  });

  it('from the settings switch: plays once the context runs', async () => {
    const audio = fakeAudio('suspended');
    const chime = new Chime(env(audio.Ctor));
    chime.playFromGesture();
    await Promise.resolve();
    await Promise.resolve();
    expect(audio.oscillators).toHaveLength(2);
  });
});
