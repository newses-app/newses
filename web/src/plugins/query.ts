import { QueryCache, QueryClient } from '@tanstack/vue-query';
import { isUnauthenticated } from '../api.ts';
import { connection } from '../platform/index.ts';
import { router } from '../router.ts';

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    // The route guard handles a missing session; any other 401 means it expired.
    onError: (error, query) => {
      const current = router.currentRoute.value;
      if (isUnauthenticated(error) && query.queryKey[0] !== 'session' && current.name !== 'login') {
        queryClient.clear();
        void connection.signedOut();
        void router.push({ name: 'login', query: { redirect: current.fullPath } });
      }
    },
  }),
  defaultOptions: {
    queries: {
      // Server data changes through this app or realtime events, not by focus or reconnect.
      refetchOnWindowFocus: false,
      retry: (count, error) => !isUnauthenticated(error) && count < 2,
      staleTime: 30_000,
    },
  },
});
