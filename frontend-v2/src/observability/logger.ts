import { redact } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel | 'silent', number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/**
 * A log sink. Sentry registers one at startup; tests register a recording one.
 */
export interface LogSink {
  (level: LogLevel, event: string, context: Record<string, unknown>): void;
}

const sinks: LogSink[] = [];

export function registerLogSink(sink: LogSink): () => void {
  sinks.push(sink);
  return () => {
    const index = sinks.indexOf(sink);
    if (index >= 0) sinks.splice(index, 1);
  };
}

function configuredLevel(): number {
  const raw =
    (typeof process !== 'undefined' ? process.env.LOG_LEVEL : undefined) ??
    (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
  return LEVEL_ORDER[raw as LogLevel] ?? LEVEL_ORDER.debug;
}

/**
 * The application's only logging entry point.
 *
 * `console.*` is banned by lint. Everything goes through here so that every
 * line is redacted on the way out, is structured rather than interpolated, and
 * reaches every registered sink - which is what makes it possible to add
 * Sentry breadcrumbs or ship logs somewhere without editing call sites.
 *
 * Events are named `domain.action`, e.g. `auth.login.start`, so they group.
 */
function emit(level: LogLevel, event: string, context: Record<string, unknown> = {}): void {
  if (LEVEL_ORDER[level] < configuredLevel()) return;

  const safeContext = redact(context) as Record<string, unknown>;

  for (const sink of sinks) {
    try {
      sink(level, event, safeContext);
    } catch {
      // A broken sink must never break the request it was observing.
    }
  }

  if (process.env.NODE_ENV !== 'production') {
    // Readable during development; structured JSON in production, below.
    // eslint-disable-next-line no-console
    console[level === 'debug' ? 'log' : level](`[${level}] ${event}`, safeContext);
    return;
  }

  // eslint-disable-next-line no-console
  console[level === 'debug' ? 'log' : level](
    JSON.stringify({ level, event, time: new Date().toISOString(), ...safeContext }),
  );
}

/**
 * A sink for exceptions, as distinct from log lines.
 *
 * Separate from `LogSink` because an exception is not a log line: it carries a
 * stack, it should be grouped and alerted on, and it needs its own tags.
 */
export interface ErrorSink {
  (error: unknown, context: Record<string, unknown>): void;
}

const errorSinks: ErrorSink[] = [];

export function registerErrorSink(sink: ErrorSink): () => void {
  errorSinks.push(sink);
  return () => {
    const index = errorSinks.indexOf(sink);
    if (index >= 0) errorSinks.splice(index, 1);
  };
}

/**
 * Reports an exception to whatever is listening.
 *
 * Components call this rather than importing Sentry. Three reasons: it keeps
 * the reporting backend replaceable, it keeps the design system free of a
 * dependency it has no business knowing about, and it makes error paths
 * testable - a unit test registers a recording sink instead of needing the
 * whole Sentry SDK to load under jsdom.
 *
 * Context is redacted on the way out, like everything else.
 */
export function reportError(error: unknown, context: Record<string, unknown> = {}): void {
  const safeContext = redact(context) as Record<string, unknown>;

  for (const sink of errorSinks) {
    try {
      sink(error, safeContext);
    } catch {
      // A broken sink must never break the failure it was reporting.
    }
  }

  emit('error', 'error.reported', context);
}

export const logger = {
  debug: (event: string, context?: Record<string, unknown>) => emit('debug', event, context),
  info: (event: string, context?: Record<string, unknown>) => emit('info', event, context),
  warn: (event: string, context?: Record<string, unknown>) => emit('warn', event, context),
  error: (event: string, context?: Record<string, unknown>) => emit('error', event, context),
};
