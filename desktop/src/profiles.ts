import type { ProfileStorage } from '@newses/shared/profiles';
import type { SettingsStore } from './settings.ts';
import type { TokenStore } from './token.ts';

/** Profiles in `settings.json`, with their tokens encrypted beside them. */
export function settingsProfileStorage(
  settings: SettingsStore,
  tokens: TokenStore,
): ProfileStorage {
  return {
    load() {
      const { profiles, activeProfile } = settings.get();
      return Promise.resolve(profiles ? { profiles, active: activeProfile ?? null } : null);
    },
    save: ({ profiles, active }) => settings.update({ profiles, activeProfile: active }),
    getToken: (id) => Promise.resolve(tokens.get(id)),
    setToken: (id, token) => tokens.set(id, token),
    removeToken: (id) => tokens.clear(id),
    loadLegacy() {
      const { serverUrl, token } = settings.get();
      if (serverUrl === undefined && token === undefined) return Promise.resolve(null);
      return Promise.resolve({ serverUrl: serverUrl ?? null, token: tokens.legacy() });
    },
    removeLegacy: () => settings.update({ serverUrl: undefined, token: undefined }),
  };
}
