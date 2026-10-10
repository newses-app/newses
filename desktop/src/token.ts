import type { SettingsStore } from './settings.ts';

/** The part of Electron's `safeStorage` the token store uses. */
export interface Encryption {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
}

/**
 * Whether the token may be kept on disk: only encrypted with an OS key store. On Linux without a
 * keyring (`basic_text`), Electron would encrypt with a fixed key, so the token is not kept.
 */
export const canKeepToken = (encryption: Encryption, platform: NodeJS.Platform) =>
  encryption.isEncryptionAvailable() &&
  !(platform === 'linux' && encryption.getSelectedStorageBackend() === 'basic_text');

/** The session token: encrypted in settings when it can be kept, else in memory until quit. */
export function createTokenStore(
  settings: SettingsStore,
  encryption: Encryption,
  platform: NodeJS.Platform,
) {
  const keep = canKeepToken(encryption, platform);
  let memory: string | null = null;
  return {
    get(): string | null {
      if (!keep) return memory;
      const stored = settings.get().token;
      if (!stored) return null;
      try {
        return encryption.decryptString(Buffer.from(stored, 'base64'));
      } catch {
        // Encrypted by another user or key: sign in again.
        return null;
      }
    },
    async set(token: string): Promise<void> {
      memory = token;
      if (keep)
        await settings.update({ token: encryption.encryptString(token).toString('base64') });
    },
    async clear(): Promise<void> {
      memory = null;
      if (settings.get().token !== undefined) await settings.update({ token: undefined });
    },
  };
}
