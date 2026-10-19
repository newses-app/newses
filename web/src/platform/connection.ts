import type { Profile, User } from '@newses/shared';
import { reactive } from 'vue';
import type { PlatformBridge } from './bridge.ts';

/**
 * The apps' profiles and the active one's bearer token, mirrored from the bridge so requests can
 * read them at once. The app runs on one profile until it reloads on another.
 */
export function createConnection(bridge: PlatformBridge) {
  const state = reactive({
    profiles: [] as Profile[],
    /** The active profile's id; null until a server is chosen. */
    active: null as string | null,
    token: null as string | null,
    /** The active profile's server. */
    get serverUrl(): string | null {
      return this.profiles.find((p) => p.id === this.active)?.serverUrl ?? null;
    },
  });

  const activeProfile = () => state.profiles.find((p) => p.id === state.active) ?? null;

  async function refresh(): Promise<void> {
    const { profiles, active } = await bridge.getProfiles();
    state.profiles = profiles;
    state.active = active;
  }

  async function signedOut(): Promise<void> {
    state.token = null;
    await bridge.clearToken();
  }

  return {
    state,
    activeProfile,
    refresh,

    async load(): Promise<void> {
      await refresh();
      state.token = state.active ? await bridge.getToken() : null;
    },

    /**
     * Keeps a sign-in's token on the profile of the user it is for: the active one when that is
     * new or the user's; else the user's other profile on this server, made when there is none. A
     * new profile that turns out to be another one's user is merged into it. Returns whether the
     * active profile changed, after which the app reloads on it.
     */
    async signedIn(token: string, user: Pick<User, 'id' | 'login'>): Promise<boolean> {
      const current = activeProfile();
      if (!current) throw new Error('No active profile');
      const other = state.profiles.find(
        (p) => p.id !== current.id && p.serverUrl === current.serverUrl && p.userId === user.id,
      );
      let target = current;
      if (current.userId === null && other) {
        target = other;
        await bridge.removeProfile(current.id);
      } else if (current.userId !== null && current.userId !== user.id) {
        target = other ?? (await bridge.addProfile(current.serverUrl));
      }
      if (target.id !== current.id) await bridge.setActiveProfile(target.id);
      await bridge.setToken(token);
      await bridge.updateProfile(target.id, { userId: user.id, login: user.login });
      await refresh();
      state.token = token;
      return target.id !== current.id;
    },

    /** Notes the active profile's user, as the server reports it, when it changed. */
    async remember(user: Pick<User, 'id' | 'login'>): Promise<void> {
      const current = activeProfile();
      if (!current || (current.userId === user.id && current.login === user.login)) return;
      await bridge.updateProfile(current.id, { userId: user.id, login: user.login });
      await refresh();
    },

    signedOut,
  };
}

export type Connection = ReturnType<typeof createConnection>;
