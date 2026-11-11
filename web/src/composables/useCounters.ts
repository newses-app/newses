import type { CurrentSession } from '@newses/shared';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api } from '../api.ts';
import { storedQuery } from '../offline/local.ts';
import { readEventStream } from '../lib/event-stream.ts';
import { bridge, connection, NATIVE } from '../platform/index.ts';
import { SESSION_KEY } from './useSession.ts';

export const COUNTERS_KEY = ['counters'] as const;
/** Polling interval (of counters, or of the change marker) while there is no event stream. */
export const POLL_MS = 60_000;
/**
 * Polling interval while the page is hidden and desktop notifications are on: the AWS dispatch
 * interval, so an app left running does not keep the database awake.
 */
export const BACKGROUND_POLL_MS = 30 * 60_000;
/** A closed stream (e.g. a proxy without SSE) is retried this often. */
const RECONNECT_MS = 5 * 60_000;
/** An open stream that ended (the server ends them every 30 minutes) is reopened after this, as the server's `retry` asks of EventSource. */
const STREAM_RETRY_MS = 5000;

/** True while the event stream is connected; actions then leave counter refreshes to it. */
export const live = ref(false);
/** Set while desktop notifications are on, so counters are still polled while hidden. */
export const pollInBackground = ref(false);

export function useCounters() {
  return useQuery({
    queryKey: COUNTERS_KEY,
    ...storedQuery('counters', () => api.counters()),
    staleTime: 10_000,
  });
}

/**
 * Keeps counters current: refetches on `counters` events and when the shell asks (resume, unlock,
 * tray), polls while the stream is down, and pauses polling while the page is hidden unless
 * `pollInBackground`. A server without event streams (AWS) gives a change marker instead, which is
 * polled from the edge, and counters are fetched only when it changed. Mount once, in the
 * signed-in layout.
 */
export function useLiveCounters(): void {
  const queryClient = useQueryClient();
  let source: EventSource | null = null;
  let closeStream: (() => void) | null = null;
  let poll: ReturnType<typeof setInterval> | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let stopRefresh: () => void = () => undefined;
  const refresh = () => queryClient.invalidateQueries({ queryKey: COUNTERS_KEY });

  /** The change marker's URL, when the server gives one. */
  const markerUrl = () => {
    const path = queryClient.getQueryData<CurrentSession>(SESSION_KEY)?.changesPath;
    if (!path) return null;
    return NATIVE ? `${connection.state.serverUrl ?? ''}${path}` : path;
  };
  /** The marker's text when last read; undefined until read once. */
  let marker: string | undefined;
  const checkMarker = async (url: string) => {
    let text: string;
    try {
      // Revalidated, so an unchanged marker costs a 304. None is written before the first event.
      const response = await fetch(url, { cache: 'no-cache', credentials: 'omit' });
      text = response.ok ? await response.text() : '';
    } catch {
      return;
    }
    if (marker !== undefined && text !== marker) void refresh();
    marker = text;
  };
  const pollOnce = () => {
    const url = markerUrl();
    return url ? checkMarker(url) : refresh();
  };

  const startPolling = () => {
    if (poll !== undefined) return;
    const interval = document.hidden ? (pollInBackground.value ? BACKGROUND_POLL_MS : 0) : POLL_MS;
    if (interval) poll = setInterval(() => void pollOnce(), interval);
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
    // No stream to open: the marker says when to refetch.
    const url = markerUrl();
    if (url) {
      void checkMarker(url);
      startPolling();
      return;
    }
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
    stopPolling();
    if (live.value) return;
    if (!document.hidden) void pollOnce();
    startPolling();
  };
  watch(pollInBackground, onVisibility);

  onMounted(() => {
    connect();
    document.addEventListener('visibilitychange', onVisibility);
    stopRefresh = bridge.onRefresh(() => void refresh());
  });
  onBeforeUnmount(() => {
    source?.close();
    closeStream?.();
    live.value = false;
    stopPolling();
    clearTimeout(reconnect);
    document.removeEventListener('visibilitychange', onVisibility);
    stopRefresh();
  });
}
