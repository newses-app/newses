import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../api.ts';

export const COUNTERS_KEY = ['counters'] as const;
/** Polling interval while the event stream is unavailable. */
export const POLL_MS = 60_000;
/** A closed stream (e.g. a proxy without SSE) is retried this often. */
const RECONNECT_MS = 5 * 60_000;

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

  const connect = () => {
    if (typeof EventSource === 'undefined') {
      startPolling();
      return;
    }
    const stream = new EventSource(api.eventsUrl, { withCredentials: true });
    source = stream;
    stream.addEventListener('open', () => {
      live.value = true;
      stopPolling();
      // Events may have been missed while disconnected.
      void refresh();
    });
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
    live.value = false;
    stopPolling();
    clearTimeout(reconnect);
    document.removeEventListener('visibilitychange', onVisibility);
  });
}
