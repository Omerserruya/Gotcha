import { describe, expect, it, vi } from 'vitest';

import { registerErrorSink, reportError } from './logger';

describe('reportError', () => {
  it('hands the exception to every registered sink', () => {
    const sink = vi.fn();
    const unregister = registerErrorSink(sink);
    const error = new Error('boom');

    reportError(error, { region: 'inbox.list' });

    expect(sink).toHaveBeenCalledWith(error, { region: 'inbox.list' });
    unregister();
  });

  it('redacts context before it leaves the application', () => {
    const sink = vi.fn();
    const unregister = registerErrorSink(sink);

    reportError(new Error('boom'), { region: 'inbox', message: 'hi there', accessToken: 'secret' });

    const [, context] = sink.mock.calls[0]!;
    expect(context.region).toBe('inbox');
    expect(context.message).toBe('[redacted]');
    expect(context.accessToken).toBe('[redacted]');
    unregister();
  });

  it('survives a sink that throws, so reporting cannot cause a second failure', () => {
    const broken = registerErrorSink(() => {
      throw new Error('sink is down');
    });
    const working = vi.fn();
    const unregister = registerErrorSink(working);

    expect(() => reportError(new Error('boom'))).not.toThrow();
    expect(working).toHaveBeenCalled();

    broken();
    unregister();
  });

  it('stops delivering once a sink is unregistered', () => {
    const sink = vi.fn();
    registerErrorSink(sink)();
    reportError(new Error('boom'));
    expect(sink).not.toHaveBeenCalled();
  });
});
