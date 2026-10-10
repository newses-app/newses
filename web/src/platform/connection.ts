import { reactive } from 'vue';
import type { PlatformBridge } from './bridge.ts';

/** The apps' server and bearer token, mirrored from the bridge so requests can read them at once. */
export function createConnection(bridge: PlatformBridge) {
  const state = reactive({ serverUrl: null as string | null, token: null as string | null });

  async function signedOut(): Promise<void> {
    state.token = null;
    await bridge.clearToken();
  }

  return {
    state,

    async load(): Promise<void> {
      [state.serverUrl, state.token] = await Promise.all([
        bridge.getServerUrl(),
        bridge.getToken(),
      ]);
    },

    /** Switching servers first ends the session with the old one (`revoke`, best effort). */
    async setServer(url: string, revoke: () => Promise<void>): Promise<void> {
      if (url === state.serverUrl) return;
      if (state.token) await revoke().catch(() => undefined);
      await signedOut();
      await bridge.setServerUrl(url);
      state.serverUrl = url;
    },

    async signedIn(token: string): Promise<void> {
      state.token = token;
      await bridge.setToken(token);
    },

    signedOut,
  };
}

export type Connection = ReturnType<typeof createConnection>;
