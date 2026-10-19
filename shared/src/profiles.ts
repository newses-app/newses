// The apps' server profiles, kept by the desktop and Android shells (and in memory outside one).
import type { Profile, ProfileChanges, ProfileList } from './platform-bridge.ts';

/** A profile as stored: whether it is signed in follows from its token. */
export type SavedProfile = Omit<Profile, 'signedIn'>;

export interface SavedProfiles {
  profiles: SavedProfile[];
  active: string | null;
}

/** The server and token of an app from before profiles. */
export interface LegacyConnection {
  serverUrl: string | null;
  token: string | null;
}

/** Where a shell keeps its profiles, and their tokens in OS secure storage. */
export interface ProfileStorage {
  /** Null before the first profile, or the first start after an update from a single server. */
  load(): Promise<SavedProfiles | null>;
  save(saved: SavedProfiles): Promise<void>;
  getToken(id: string): Promise<string | null>;
  setToken(id: string, token: string): Promise<void>;
  removeToken(id: string): Promise<void>;
  /** The single server and token kept before profiles; null when there was none. */
  loadLegacy(): Promise<LegacyConnection | null>;
  /** Deletes them, once they are a profile. */
  removeLegacy(): Promise<void>;
}

/** The longest login, server name, or label a profile keeps. */
export const MAX_PROFILE_LABEL_LENGTH = 256;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An HTTPS origin, as the connect screen chooses; else null. */
export function httpsOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * How a profile is named in menus: the reader's label, else `user @ server`, the server by its own
 * name or else its host, so several users of one server tell apart.
 */
export function profileLabel(
  profile: Pick<Profile, 'serverUrl' | 'login' | 'serverName' | 'label'>,
): string {
  if (profile.label) return profile.label;
  const server = profile.serverName ?? new URL(profile.serverUrl).host;
  return profile.login ? `${profile.login} @ ${server}` : server;
}

/** A profile id as the shells give them; else null. */
export const profileId = (value: unknown): string | null =>
  typeof value === 'string' && UUID.test(value) ? value : null;

const text = (value: unknown) =>
  value === null || (typeof value === 'string' && value.length <= MAX_PROFILE_LABEL_LENGTH);

/** Changes the web app may make to a profile, checked field by field; null when any is invalid. */
export function profileChanges(value: unknown): ProfileChanges | null {
  if (typeof value !== 'object' || value === null) return null;
  const changes: ProfileChanges = {};
  for (const [key, field] of Object.entries(value)) {
    if (key === 'userId') {
      if (field !== null && !(Number.isSafeInteger(field) && (field as number) > 0)) return null;
      changes.userId = field as number | null;
    } else if (key === 'login' || key === 'serverName' || key === 'label') {
      if (!text(field)) return null;
      changes[key] = field as string | null;
    } else {
      return null;
    }
  }
  return changes;
}

const newProfile = (id: string, serverUrl: string): SavedProfile => ({
  id,
  serverUrl,
  userId: null,
  login: null,
  serverName: null,
  label: null,
});

/** Profiles saved by an earlier version lack fields added since. */
const withDefaults = ({ profiles, active }: SavedProfiles): SavedProfiles => ({
  profiles: profiles.map((p) => ({
    ...p,
    serverName: (p as Partial<SavedProfile>).serverName ?? null,
  })),
  active,
});

/**
 * The bridge's profile methods over a shell's storage. Calls run one at a time, so concurrent
 * changes never overwrite each other. The first call moves a single server and token from before
 * profiles into an active profile.
 */
export function createProfiles(
  storage: ProfileStorage,
  newId: () => string = () => crypto.randomUUID(),
) {
  let queue: Promise<unknown> = Promise.resolve();
  let saved: SavedProfiles | null = null;

  async function migrate(): Promise<SavedProfiles> {
    const stored = await storage.load();
    if (stored) return stored;
    const legacy = await storage.loadLegacy();
    const serverUrl = httpsOrigin(legacy?.serverUrl);
    if (!serverUrl) {
      if (legacy) await storage.removeLegacy();
      return { profiles: [], active: null };
    }
    const profile = newProfile(newId(), serverUrl);
    // Written before the old keys go, so a crash in between migrates again rather than losing them.
    if (legacy?.token) await storage.setToken(profile.id, legacy.token);
    const migrated = { profiles: [profile], active: profile.id };
    await storage.save(migrated);
    await storage.removeLegacy();
    return migrated;
  }

  /** Runs after every earlier call, with the profiles loaded. */
  function run<T>(task: (current: SavedProfiles) => Promise<T>): Promise<T> {
    const result = queue.then(async () => {
      saved ??= withDefaults(await migrate());
      return task(saved);
    });
    queue = result.catch(() => undefined);
    return result;
  }

  async function save(next: SavedProfiles): Promise<void> {
    await storage.save(next);
    saved = next;
  }

  function find(current: SavedProfiles, id: string): SavedProfile {
    const profile = current.profiles.find((p) => p.id === id);
    if (!profile) throw new Error('No such profile');
    return profile;
  }

  return {
    list: () =>
      run(async ({ profiles, active }): Promise<ProfileList> => ({
        profiles: await Promise.all(
          profiles.map(async (p) => ({ ...p, signedIn: (await storage.getToken(p.id)) !== null })),
        ),
        active,
      })),

    add: (serverUrl: string) =>
      run(async (current): Promise<Profile> => {
        const origin = httpsOrigin(serverUrl);
        if (!origin) throw new Error('Not an HTTPS origin');
        const profile = newProfile(newId(), origin);
        await save({ ...current, profiles: [...current.profiles, profile] });
        return { ...profile, signedIn: false };
      }),

    update: (id: string, changes: ProfileChanges) =>
      run(async (current) => {
        const checked = profileChanges(changes);
        if (!checked) throw new Error('Invalid profile changes');
        const profile = { ...find(current, id), ...checked };
        await save({
          ...current,
          profiles: current.profiles.map((p) => (p.id === id ? profile : p)),
        });
      }),

    setActive: (id: string) =>
      run(async (current) => {
        find(current, id);
        if (current.active !== id) await save({ ...current, active: id });
      }),

    remove: (id: string) =>
      run(async (current) => {
        find(current, id);
        // The token goes first: a crash in between leaves a signed-out profile, not a lost secret.
        const token = await storage.getToken(id);
        await storage.removeToken(id);
        await save({
          profiles: current.profiles.filter((p) => p.id !== id),
          active: current.active === id ? null : current.active,
        });
        return token;
      }),

    getToken: () => run(async ({ active }) => (active ? storage.getToken(active) : null)),

    setToken: (token: string) =>
      run(async ({ active }) => {
        if (!active) throw new Error('No active profile');
        await storage.setToken(active, token);
      }),

    clearToken: () =>
      run(async ({ active }) => {
        if (active) await storage.removeToken(active);
      }),
  };
}

export type Profiles = ReturnType<typeof createProfiles>;

/** Profiles and tokens in memory: the native build outside a shell, and tests. */
export function memoryProfileStorage(legacy: LegacyConnection | null = null): ProfileStorage {
  let saved: SavedProfiles | null = null;
  let old = legacy;
  const tokens = new Map<string, string>();
  return {
    load: () => Promise.resolve(saved),
    save: (next) => {
      saved = structuredClone(next);
      return Promise.resolve();
    },
    getToken: (id) => Promise.resolve(tokens.get(id) ?? null),
    setToken: (id, token) => {
      tokens.set(id, token);
      return Promise.resolve();
    },
    removeToken: (id) => {
      tokens.delete(id);
      return Promise.resolve();
    },
    loadLegacy: () => Promise.resolve(old),
    removeLegacy: () => {
      old = null;
      return Promise.resolve();
    },
  };
}
