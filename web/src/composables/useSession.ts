import type { CurrentSession, LoggedInResponse } from '@rss-reader/shared';
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/vue-query';
import type { Router } from 'vue-router';
import { useRouter } from 'vue-router';
import { api, isUnauthenticated } from '../api.ts';

export const SESSION_KEY = ['session'] as const;

const fetchSession = () => api.auth.session();

/** Redirects to the login page when the session is missing or expired. */
export function installAuthGuard(router: Router, queryClient: QueryClient): void {
  router.beforeEach(async (to) => {
    if (to.meta.public) return true;
    try {
      await queryClient.query({
        queryKey: SESSION_KEY,
        queryFn: fetchSession,
        staleTime: Infinity,
      });
      return true;
    } catch (error) {
      if (isUnauthenticated(error)) return { name: 'login', query: { redirect: to.fullPath } };
      throw error;
    }
  });
}

export function useSession() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const query = useQuery({ queryKey: SESSION_KEY, queryFn: fetchSession, staleTime: Infinity });

  function signedIn(result: LoggedInResponse): void {
    queryClient.setQueryData<CurrentSession>(SESSION_KEY, {
      user: result.user,
      csrfToken: result.csrfToken ?? null,
    });
  }

  /** Signs in, or returns the challenge to pass to `completeLogin` with a 2FA code. */
  async function login(login: string, password: string): Promise<string | null> {
    const result = await api.auth.login({ login, password });
    if ('challenge' in result) return result.challenge;
    signedIn(result);
    return null;
  }

  async function completeLogin(challenge: string, code: string): Promise<void> {
    signedIn(await api.auth.loginTwoFactor({ challenge, code }));
  }

  async function logout(): Promise<void> {
    try {
      await api.auth.logout();
    } finally {
      queryClient.clear();
      await router.push({ name: 'login' });
    }
  }

  return { session: query.data, login, completeLogin, logout };
}
