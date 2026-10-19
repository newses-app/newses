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

    /** The active profile's server and token. */
    async load(): Promise<void> {
      const { profiles, active } = await bridge.getProfiles();
      state.serverUrl = profiles.find((p) => p.id === active)?.serverUrl ?? null;
      state.token = state.serverUrl ? await bridge.getToken() : null;
    },

    /**
     * Switching servers first ends the session with the old one (`revoke`, best effort). The app
     * keeps one profile: the old one is removed and a new one made active.
     */
    async setServer(url: string, revoke: () => Promise<void>): Promise<void> {
      if (url === state.serverUrl) return;
      if (state.token) await revoke().catch(() => undefined);
      state.token = null;
      const { active } = await bridge.getProfiles();
      if (active) await bridge.removeProfile(active);
      const profile = await bridge.addProfile(url);
      await bridge.setActiveProfile(profile.id);
      state.serverUrl = profile.serverUrl;
    },

    async signedIn(token: string): Promise<void> {
      state.token = token;
      await bridge.setToken(token);
    },

    signedOut,
  };
}

export type Connection = ReturnType<typeof createConnection>;
