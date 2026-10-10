/** Why a stream closed: `ended` after it was open (reconnect soon); `refused` when it never opened. */
export type StreamClose = 'ended' | 'refused';

export interface EventStreamHandlers {
  onOpen: () => void;
  onEvent: (type: string) => void;
  onClose: (reason: StreamClose) => void;
}

/**
 * Reads server-sent events with `fetch`, for the apps: `EventSource` cannot send their bearer
 * token. Only event types are reported (the API's events carry no data). Returns a function that
 * closes the stream without calling `onClose`.
 */
export function readEventStream(
  url: string,
  headers: Record<string, string>,
  handlers: EventStreamHandlers,
  fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): () => void {
  const controller = new AbortController();
  void (async () => {
    let opened = false;
    try {
      const response = await fetch(url, {
        headers: { ...headers, accept: 'text/event-stream' },
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
      });
      // 204: the server cannot hold streams open (AWS), as for EventSource.
      if (response.status !== 200 || !response.body) {
        handlers.onClose('refused');
        return;
      }
      opened = true;
      handlers.onOpen();
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value.replace(/\r\n?/g, '\n');
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const type = /^event: ?(.*)$/m.exec(block)?.[1];
          if (type && /^data:/m.test(block)) handlers.onEvent(type);
        }
      }
    } catch {
      if (controller.signal.aborted) return;
    }
    if (!controller.signal.aborted) handlers.onClose(opened ? 'ended' : 'refused');
  })();
  return () => {
    controller.abort();
  };
}
