import { ApiError, kindFromStatus } from './api-error';

/**
 * Reads a `text/event-stream` response from a POST.
 *
 * `EventSource` cannot be used: it only issues GET requests, and the agent
 * endpoint is a POST carrying a message body. So the stream is read from
 * `fetch` and the wire format is parsed here.
 *
 * The format is line-oriented and frames are separated by a blank line:
 *
 *     event: token
 *     data: {"type":"token","text":"Check"}
 *     ⏎
 *
 * Comment lines beginning `:` are heartbeats - the backend sends `: ping`
 * every 25 seconds precisely because the proxy in front of it closes an idle
 * stream at 60. They are dropped here, but their arrival is what keeps the
 * connection open, so no timeout below about two minutes is safe.
 */

export interface SseFrame {
  /** The `event:` line, when present. */
  readonly event?: string;
  /** The `id:` line, when present - what a resume sends back as `Last-Event-ID`. */
  readonly id?: string;
  /** The accumulated `data:` lines, newline-joined. */
  readonly data: string;
}

export interface StreamOptions {
  readonly url: string;
  /** POST by default; GET to resume a stream (no body). */
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Yields one frame per event until the server closes the stream.
 *
 * An async generator rather than a callback so the caller can `break` - and
 * because `for await` makes cancellation on unmount fall out naturally.
 */
export async function* streamServerSentEvents({
  url,
  method = 'POST',
  body,
  signal,
  headers,
}: StreamOptions): AsyncGenerator<SseFrame> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      signal,
      credentials: 'same-origin',
      headers: {
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        accept: 'text/event-stream',
        ...headers,
      },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    if (signal?.aborted) throw new ApiError({ kind: 'cancelled', cause });
    throw new ApiError({ kind: 'network', cause });
  }

  if (!response.ok) {
    // An error arrives as ordinary JSON, not as a stream - with its `code`
    // (RUN_IN_PROGRESS, RATE_LIMITED...) and, for a rate limit, when to retry.
    let developerMessage: string | undefined;
    let code: string | undefined;
    let retryAfterSeconds: number | undefined;
    try {
      const parsed: unknown = await response.json();
      if (parsed && typeof parsed === 'object') {
        const fields = parsed as { error?: unknown; code?: unknown; retryAfterSeconds?: unknown };
        if (fields.error !== undefined) developerMessage = String(fields.error);
        if (typeof fields.code === 'string') code = fields.code;
        if (typeof fields.retryAfterSeconds === 'number')
          retryAfterSeconds = fields.retryAfterSeconds;
      }
    } catch {
      // Body was not JSON. The status is enough.
    }
    const header = Number(response.headers.get('retry-after'));
    throw new ApiError({
      kind: kindFromStatus(response.status),
      status: response.status,
      developerMessage,
      code,
      retryAfterSeconds:
        retryAfterSeconds ?? (Number.isFinite(header) && header > 0 ? header : undefined),
    });
  }

  if (!response.body) {
    throw new ApiError({
      kind: 'contract',
      status: response.status,
      developerMessage: 'Expected an event stream but the response had no body.',
    });
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += value;

      // Frames end at a blank line. Anything after the last one is a partial
      // frame and stays in the buffer until the rest of it arrives.
      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const frame = parseFrame(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 2);
        if (frame) yield frame;
        separator = buffer.indexOf('\n\n');
      }
    }
  } finally {
    // Releases the connection whether the caller finished or broke out early.
    await reader.cancel().catch(() => {});
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event: string | undefined;
  let id: string | undefined;
  const data: string[] = [];

  for (const line of raw.split('\n')) {
    // Heartbeat or comment.
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('id:')) {
      id = line.slice(3).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  }

  if (data.length === 0 && event === undefined) return null;
  return { event, ...(id !== undefined ? { id } : {}), data: data.join('\n') };
}
