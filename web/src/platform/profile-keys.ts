import { connection } from './index.ts';

/**
 * The `localStorage` key of a profile's copy of `base`: the active profile's unless one is given,
 * and `base` itself in the browser or before a server is chosen. An app updated from before
 * profiles had one server, so the active profile takes over a value kept under `base`.
 */
export function profileKey(base: string, profileId = connection.state.active): string {
  if (!profileId) return base;
  const key = `${base}.${profileId}`;
  if (profileId !== connection.state.active) return key;
  try {
    const old = localStorage.getItem(base);
    if (old !== null && localStorage.getItem(key) === null) localStorage.setItem(key, old);
    if (old !== null) localStorage.removeItem(base);
  } catch {
    // Storage blocked: nothing was kept to move.
  }
  return key;
}

/** Removes everything kept for a profile in `localStorage`, when the profile is removed. */
export function forgetProfileKeys(profileId: string): void {
  try {
    const suffix = `.${profileId}`;
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    for (const key of keys) if (key?.endsWith(suffix)) localStorage.removeItem(key);
  } catch {
    // Storage blocked: nothing was kept.
  }
}
