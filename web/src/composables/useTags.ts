import { useQuery } from '@tanstack/vue-query';
import { computed, type MaybeRefOrGetter, toValue } from 'vue';
import { api } from '../api.ts';
import { storedQuery } from '../offline/local.ts';

export const TAGS_KEY = ['tags'] as const;

/** The user's tags with entry counts, loaded only while `enabled` (the list can be long). */
export function useTags(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: TAGS_KEY,
    ...storedQuery('tags', () => api.tags()),
    enabled: computed(() => toValue(enabled)),
  });
}
