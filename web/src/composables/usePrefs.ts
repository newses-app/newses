import type { Prefs, UpdatePrefsRequest } from '@newses/shared';
import { DEFAULT_PREFS } from '@newses/shared/client';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed } from 'vue';
import { api } from '../api.ts';
import { storedQuery } from '../offline/local.ts';
import { COUNTERS_KEY } from './useCounters.ts';
import { ENTRIES_KEY } from './useEntries.ts';
import { useResourceEdits } from './useResourceEdits.ts';

const PREFS_KEY = ['prefs'] as const;

/** The user's preferences, defaults until loaded; `update` applies changes optimistically. */
export function usePrefs() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: PREFS_KEY,
    ...storedQuery('prefs', () => api.prefs.get()),
    staleTime: Infinity,
  });
  const { edit } = useResourceEdits();

  /** Shown at once; kept for later without a connection, undone if the server refuses it. */
  async function update(changes: UpdatePrefsRequest): Promise<void> {
    const previous = queryClient.getQueryData<Prefs>(PREFS_KEY);
    queryClient.setQueryData<Prefs>(PREFS_KEY, {
      ...(previous ?? DEFAULT_PREFS),
      ...changes,
    } as Prefs);
    try {
      const saved = await edit({ kind: 'prefs', changes }, () => api.prefs.update(changes));
      if (saved.sent) queryClient.setQueryData(PREFS_KEY, saved.value);
    } catch {
      queryClient.setQueryData(PREFS_KEY, previous);
      return;
    }
    // Loaded content keeps its image URLs until refetched.
    if (changes.proxyImages !== undefined) {
      await queryClient.invalidateQueries({ queryKey: [ENTRIES_KEY] });
      await queryClient.invalidateQueries({ queryKey: ['entry'] });
    }
    // Lists and counters leave out entries scored below the threshold.
    if (changes.scoreHideBelow !== undefined) {
      await queryClient.invalidateQueries({ queryKey: [ENTRIES_KEY] });
      await queryClient.invalidateQueries({ queryKey: COUNTERS_KEY });
    }
  }

  return {
    prefs: computed<Prefs>(() => query.data.value ?? DEFAULT_PREFS),
    loaded: computed(() => query.isSuccess.value),
    update: (changes: UpdatePrefsRequest) => {
      void update(changes);
    },
  };
}
