import { describe, expect, it, vi } from 'vitest';
import { readEventStream, type StreamClose } from './event-stream.ts';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function read(response: Response | Error) {
  const events: string[] = [];
  const calls: RequestInit[] = [];
  const opened = vi.fn();
  return new Promise<{
    events: string[];
    reason: StreamClose;
    opened: number;
    init: RequestInit | undefined;
  }>((resolve) => {
    readEventStream(
      'https://rr.example.com/api/v1/events',
      { authorization: 'Bearer t0k' },
      {
        onOpen: opened,
        onEvent: (type) => events.push(type),
        onClose: (reason) => {
          resolve({ events, reason, opened: opened.mock.calls.length, init: calls[0] });
        },
      },
      (_url, init) => {
        calls.push(init ?? {});
        return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
      },
    );
  });
}

describe('readEventStream', () => {
  it('reports events split across chunks, skipping comments and retry lines', async () => {
    const body = streamOf([
      'retry: 5000\n\n:\n\nevent: coun',
      'ters\ndata: {}\n\n',
      ':\r\n\r\nevent: counters\r\ndata: {}\r\n\r\n',
    ]);
    const result = await read(new Response(body, { status: 200 }));
    expect(result.opened).toBe(1);
    expect(result.events).toEqual(['counters', 'counters']);
    expect(result.reason).toBe('ended');
    expect(result.init?.headers).toMatchObject({ authorization: 'Bearer t0k' });
    expect(result.init?.credentials).toBe('omit');
  });

  it('treats 204 and errors as refused, so the app polls', async () => {
    expect((await read(new Response(null, { status: 204 }))).reason).toBe('refused');
    expect((await read(new Response('no', { status: 401 }))).reason).toBe('refused');
    const failed = await read(new TypeError('Failed to fetch'));
    expect(failed).toMatchObject({ reason: 'refused', opened: 0 });
  });

  it('closes without reporting when the app closes it', async () => {
    const onClose = vi.fn();
    const close = readEventStream(
      'https://rr.example.com/api/v1/events',
      {},
      { onOpen: vi.fn(), onEvent: vi.fn(), onClose },
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onClose).not.toHaveBeenCalled();
  });
});
