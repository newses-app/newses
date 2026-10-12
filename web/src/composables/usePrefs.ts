import type { Prefs, UpdatePrefsRequest } from '@newses/shared';
import { DEFAULT_PREFS } from '@newses/shared/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed } from 'vue';
import { api } from '../api.ts';
import { COUNTERS_KEY } from './useCounters.ts';
import { ENTRIES_KEY } from './useEntries.ts';

const PREFS_KEY = ['prefs'] as const;

/** The user's preferences, defaults until loaded; `update` applies changes optimistically. */
export function usePrefs() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: PREFS_KEY,
    queryFn: () => api.prefs.get(),
    staleTime: Infinity,
  });
  const mutation = useMutation({
    mutationFn: (changes: UpdatePrefsRequest) => api.prefs.update(changes),
    onMutate: (changes) => {
      const previous = queryClient.getQueryData<Prefs>(PREFS_KEY);
      queryClient.setQueryData<Prefs>(PREFS_KEY, {
        ...(previous ?? DEFAULT_PREFS),
        ...changes,
      } as Prefs);
      return previous;
    },
    onSuccess: async (prefs, changes) => {
      queryClient.setQueryData(PREFS_KEY, prefs);
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
    },
    onError: (_error, _changes, previous) => queryClient.setQueryData(PREFS_KEY, previous),
  });
  return {
    prefs: computed<Prefs>(() => query.data.value ?? DEFAULT_PREFS),
    loaded: computed(() => query.isSuccess.value),
    update: (changes: UpdatePrefsRequest) => {
      mutation.mutate(changes);
    },
  };
}
