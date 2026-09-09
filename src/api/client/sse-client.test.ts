import { describe, expect, it, vi, afterEach } from 'vitest';

import { streamServerSentEvents } from './sse-client';

function streamOf(...chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collect(): Promise<{ event?: string; data: string }[]> {
  const frames = [];
  for await (const frame of streamServerSentEvents({ url: '/x', body: {} })) frames.push(frame);
  return frames;
}

afterEach(() => vi.unstubAllGlobals());

describe('streamServerSentEvents', () => {
  it('yields one frame per event', async () => {
    vi.stubGlobal('fetch', async () =>
      streamOf('event: ready\ndata: {"type":"ready"}\n\nevent: done\ndata: {"type":"done"}\n\n'),
    );
    const frames = await collect();
    expect(frames.map((f) => f.event)).toEqual(['ready', 'done']);
    expect(frames[0]!.data).toBe('{"type":"ready"}');
  });

  it('reassembles a frame split across network chunks', async () => {
    // The realistic case: TCP does not respect frame boundaries.
    vi.stubGlobal('fetch', async () => streamOf('event: tok', 'en\ndata: {"text":', '"hi"}\n\n'));
    const frames = await collect();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toBe('token');
    expect(frames[0]!.data).toBe('{"text":"hi"}');
  });

  it('drops heartbeat comments without emitting a frame', async () => {
    // The backend sends `: ping` every 25s because the proxy kills idle
    // streams at 60. They keep the connection alive and carry nothing.
    vi.stubGlobal('fetch', async () =>
      streamOf(': ping\n\nevent: token\ndata: {"text":"a"}\n\n: ping\n\n'),
    );
    const frames = await collect();
    expect(frames).toHaveLength(1);
  });

  it('does not emit a trailing partial frame', async () => {
    vi.stubGlobal('fetch', async () => streamOf('event: token\ndata: {"text":"a"}\n\nevent: half'));
    expect(await collect()).toHaveLength(1);
  });

  it('joins multiple data lines in one frame', async () => {
    vi.stubGlobal('fetch', async () => streamOf('data: one\ndata: two\n\n'));
    const frames = await collect();
    expect(frames[0]!.data).toBe('one\ntwo');
  });

  it('raises a typed error for a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ error: 'nope' }), { status: 403 }),
    );
    await expect(collect()).rejects.toMatchObject({ kind: 'authorization', status: 403 });
  });

  it('reports a network failure as network, not as a stream error', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    await expect(collect()).rejects.toMatchObject({ kind: 'network' });
  });
});
