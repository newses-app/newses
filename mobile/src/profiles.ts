import type { ProfileStorage, SavedProfiles } from '@newses/shared/profiles';

/** Strings by key: Preferences, or secure storage (Android Keystore). */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const PROFILES_KEY = 'profiles';
const tokenKey = (id: string) => `token.${id}`;
/** Before profiles: the server in Preferences and the token in secure storage. */
const LEGACY_SERVER_KEY = 'serverUrl';
const LEGACY_TOKEN_KEY = 'token';

/** Profiles in Preferences, their tokens in secure storage. */
export function capacitorProfileStorage(
  preferences: KeyValueStore,
  secure: KeyValueStore,
): ProfileStorage {
  return {
    async load() {
      const value = await preferences.get(PROFILES_KEY);
      return value === null ? null : (JSON.parse(value) as SavedProfiles);
    },
    save: (saved) => preferences.set(PROFILES_KEY, JSON.stringify(saved)),
    getToken: (id) => secure.get(tokenKey(id)),
    setToken: (id, token) => secure.set(tokenKey(id), token),
    removeToken: (id) => secure.remove(tokenKey(id)),
    async loadLegacy() {
      const [serverUrl, token] = await Promise.all([
        preferences.get(LEGACY_SERVER_KEY),
        secure.get(LEGACY_TOKEN_KEY),
      ]);
      return serverUrl === null && token === null ? null : { serverUrl, token };
    },
    async removeLegacy() {
      await preferences.remove(LEGACY_SERVER_KEY);
      await secure.remove(LEGACY_TOKEN_KEY);
    },
  };
}
