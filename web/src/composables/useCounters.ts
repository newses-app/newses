import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../api.ts';
import { readEventStream } from '../lib/event-stream.ts';
import { connection, NATIVE } from '../platform/index.ts';

export const COUNTERS_KEY = ['counters'] as const;
/** Polling interval while the event stream is unavailable. */
export const POLL_MS = 60_000;
/** A closed stream (e.g. a proxy without SSE) is retried this often. */
const RECONNECT_MS = 5 * 60_000;
/** An open stream that ended (the server ends them every 30 minutes) is reopened after this, as the server's `retry` asks of EventSource. */
const STREAM_RETRY_MS = 5000;

/** True while the event stream is connected; actions then leave counter refreshes to it. */
export const live = ref(false);

export function useCounters() {
  return useQuery({ queryKey: COUNTERS_KEY, queryFn: () => api.counters(), staleTime: 10_000 });
}

/**
 * Keeps counters current: refetches on `counters` events, polls while the stream is down, and
 * pauses polling while the page is hidden. Mount once, in the signed-in layout.
 */
export function useLiveCounters(): void {
  const queryClient = useQueryClient();
  let source: EventSource | null = null;
  let closeStream: (() => void) | null = null;
  let poll: ReturnType<typeof setInterval> | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => queryClient.invalidateQueries({ queryKey: COUNTERS_KEY });

  const startPolling = () => {
    if (poll !== undefined || document.hidden) return;
    poll = setInterval(() => void refresh(), POLL_MS);
  };
  const stopPolling = () => {
    clearInterval(poll);
    poll = undefined;
  };

  const opened = () => {
    live.value = true;
    stopPolling();
    // Events may have been missed while disconnected.
    void refresh();
  };

  const connect = () => {
    // The apps need their bearer token on the request, which EventSource cannot send.
    if (NATIVE) {
      closeStream = readEventStream(
        api.eventsUrl,
        { authorization: `Bearer ${connection.state.token ?? ''}` },
        {
          onOpen: opened,
          onEvent: (type) => {
            if (type === 'counters') void refresh();
          },
          onClose: (reason) => {
            live.value = false;
            startPolling();
            reconnect = setTimeout(connect, reason === 'ended' ? STREAM_RETRY_MS : RECONNECT_MS);
          },
        },
      );
      return;
    }
    if (typeof EventSource === 'undefined') {
      startPolling();
      return;
    }
    const stream = new EventSource(api.eventsUrl, { withCredentials: true });
    source = stream;
    stream.addEventListener('open', opened);
    stream.addEventListener('counters', () => void refresh());
    stream.addEventListener('error', () => {
      live.value = false;
      startPolling();
      if (stream.readyState === EventSource.CLOSED) {
        reconnect = setTimeout(connect, RECONNECT_MS);
      }
    });
  };

  const onVisibility = () => {
    if (document.hidden) stopPolling();
    else if (!live.value) {
      void refresh();
      startPolling();
    }
  };

  onMounted(() => {
    connect();
    document.addEventListener('visibilitychange', onVisibility);
  });
  onBeforeUnmount(() => {
    source?.close();
    closeStream?.();
    live.value = false;
    stopPolling();
    clearTimeout(reconnect);
    document.removeEventListener('visibilitychange', onVisibility);
  });
}
