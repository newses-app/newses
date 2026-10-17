import type { CurrentSession, LoggedInResponse } from '@newses/shared';
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/vue-query';
import { watch } from 'vue';
import type { Router } from 'vue-router';
import { useRouter } from 'vue-router';
import { api, isUnauthenticated, retryable } from '../api.ts';
import { connectivity } from '../offline/connectivity.ts';
import { seedQueries, writeQuery } from '../offline/snapshot.ts';
import { currentStore, storeSignedIn, storeSignedOut } from '../offline/store.ts';
import { connection, NATIVE } from '../platform/index.ts';

export const SESSION_KEY = ['session'] as const;

const fetchSession = () => api.auth.session();

/** Set while the app runs on the stored session; the server checks it once it answers. */
let startedOffline = false;
/** Set once this launch's session from the server is in the store. */
let sessionKept = false;

/** Fills the caches from the store, when it holds a snapshot of the signed-in account. */
async function startOffline(queryClient: QueryClient): Promise<CurrentSession | null> {
  const db = currentStore();
  if (!db || !(await seedQueries(queryClient, db).catch(() => false))) return null;
  startedOffline = true;
  return queryClient.getQueryData<CurrentSession>(SESSION_KEY) ?? null;
}

async function currentSession(queryClient: QueryClient): Promise<CurrentSession> {
  // Without a network, asking the server first would only delay the start.
  if (connectivity.value === 'offline' && !queryClient.getQueryData(SESSION_KEY)) {
    const stored = await startOffline(queryClient);
    if (stored) return stored;
  }
  try {
    return await queryClient.query({
      queryKey: SESSION_KEY,
      queryFn: fetchSession,
      staleTime: Infinity,
      // Tried even while the server seems unreachable, so the app can say so instead of waiting.
      networkMode: 'always',
      // A waking server may fail at first.
      retry: (count, error) => retryable(error) && count < 3,
    });
  } catch (error) {
    if (!isUnauthenticated(error) && connectivity.value !== 'online') {
      const stored = await startOffline(queryClient);
      if (stored) return stored;
    }
    throw error;
  }
}

/**
 * Redirects to the login page when the session is missing or expired, and to the password change
 * when the server requires one before anything else. The apps start at the connect screen until a
 * server is chosen. When the server cannot be reached, the app starts from the offline store's
 * snapshot if there is one.
 */
export function installAuthGuard(router: Router, queryClient: QueryClient): void {
  // A session the app started offline with may have ended meanwhile; this also gets a CSRF token.
  watch(connectivity, async (state) => {
    if (state !== 'online' || !startedOffline) return;
    startedOffline = false;
    try {
      await queryClient.query({ queryKey: SESSION_KEY, queryFn: fetchSession, staleTime: 0 });
    } catch (error) {
      if (!isUnauthenticated(error)) {
        startedOffline = true;
        return;
      }
      await connection.signedOut();
      queryClient.clear();
      await router.push({ name: 'login', query: { redirect: router.currentRoute.value.fullPath } });
    }
  });
  router.beforeEach(async (to) => {
    if (to.name === 'connect') return NATIVE || '/all';
    if (NATIVE && !connection.state.serverUrl) return { name: 'connect' };
    if (to.meta.public) return true;
    if (NATIVE && !connection.state.token) {
      return { name: 'login', query: { redirect: to.fullPath } };
    }
    try {
      const session = await currentSession(queryClient);
      await storeSignedIn({ userId: session.user.id, serverUrl: connection.state.serverUrl });
      // The account is known only now, so the snapshot of its session is written here, once.
      const db = sessionKept || startedOffline ? null : currentStore();
      if (db) {
        sessionKept = true;
        void writeQuery(db, 'session', session).catch(() => undefined);
      }
      const mustChange = session.user.passwordChangeRequired;
      if (mustChange && to.name !== 'change-password') return { name: 'change-password' };
      if (!mustChange && to.name === 'change-password') return '/all';
      return true;
    } catch (error) {
      if (isUnauthenticated(error)) {
        await connection.signedOut();
        return { name: 'login', query: { redirect: to.fullPath } };
      }
      throw error;
    }
  });
}

export function useSession() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const query = useQuery({ queryKey: SESSION_KEY, queryFn: fetchSession, staleTime: Infinity });

  async function signedIn(result: LoggedInResponse): Promise<void> {
    if (result.token) await connection.signedIn(result.token);
    queryClient.setQueryData<CurrentSession>(SESSION_KEY, {
      user: result.user,
      csrfToken: result.csrfToken ?? null,
      iconsPath: result.iconsPath,
    });
  }

  /** Signs in, or returns the challenge to pass to `completeLogin` with a 2FA code. */
  async function login(login: string, password: string): Promise<string | null> {
    // The apps' token is kept in secure storage; the browser's session is its cookie.
    const result = await api.auth.login({
      login,
      password,
      tokenType: NATIVE ? 'bearer' : 'cookie',
    });
    if ('challenge' in result) return result.challenge;
    await signedIn(result);
    return null;
  }

  async function completeLogin(challenge: string, code: string): Promise<void> {
    await signedIn(await api.auth.loginTwoFactor({ challenge, code }));
  }

  /** Revokes the session on the server, then forgets it here, even when the server is unreachable. */
  async function logout(): Promise<void> {
    try {
      await api.auth.logout();
    } finally {
      await connection.signedOut();
      await storeSignedOut();
      queryClient.clear();
      await router.push({ name: 'login' });
    }
  }

  return { session: query.data, login, completeLogin, logout };
}
