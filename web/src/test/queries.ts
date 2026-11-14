import type { QueryClient } from '@tanstack/vue-query';
import { vi } from 'vitest';

/** Spies on a client's invalidations; `keys()` lists the query keys invalidated, in order. */
export function spyInvalidations(queryClient: QueryClient) {
  const spy = vi.spyOn(queryClient, 'invalidateQueries');
  const keys = () =>
    spy.mock.calls.map(
      ([filters]) => (typeof filters === 'function' ? filters() : filters)?.queryKey,
    );
  return { spy, keys };
}
