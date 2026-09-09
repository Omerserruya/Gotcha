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
 * Comment lines beginning `:` are heartbeats — the backend sends `: ping`
 * every 25 seconds precisely because the proxy in front of it closes an idle
 * stream at 60. They are dropped here, but their arrival is what keeps the
 * connection open, so no timeout below about two minutes is safe.
 */

export interface SseFrame {
  /** The `event:` line, when present. */
  readonly event?: string;
  /** The accumulated `data:` lines, newline-joined. */
  readonly data: string;
}

export interface StreamOptions {
  readonly url: string;
  readonly body: unknown;
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Yields one frame per event until the server closes the stream.
 *
 * An async generator rather than a callback so the caller can `break` — and
 * because `for await` makes cancellation on unmount fall out naturally.
 */
export async function* streamServerSentEvents({
  url,
  body,
  signal,
  headers,
}: StreamOptions): AsyncGenerator<SseFrame> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      signal,
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    if (signal?.aborted) throw new ApiError({ kind: 'cancelled', cause });
    throw new ApiError({ kind: 'network', cause });
  }

  if (!response.ok) {
    // An error arrives as ordinary JSON, not as a stream.
    let developerMessage: string | undefined;
    try {
      const parsed: unknown = await response.json();
      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        developerMessage = String((parsed as { error: unknown }).error);
      }
    } catch {
      // Body was not JSON. The status is enough.
    }
    throw new ApiError({
      kind: kindFromStatus(response.status),
      status: response.status,
      developerMessage,
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
  const data: string[] = [];

  for (const line of raw.split('\n')) {
    // Heartbeat or comment.
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  }

  if (data.length === 0 && event === undefined) return null;
  return { event, data: data.join('\n') };
}
