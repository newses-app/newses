import type { SettingsStore } from './settings.ts';

/** The part of Electron's `safeStorage` the token store uses. */
export interface Encryption {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
}

/**
 * Whether tokens may be kept on disk: only encrypted with an OS key store. On Linux without a
 * keyring (`basic_text`), Electron would encrypt with a fixed key, so tokens are not kept.
 */
export const canKeepToken = (encryption: Encryption, platform: NodeJS.Platform) =>
  encryption.isEncryptionAvailable() &&
  !(platform === 'linux' && encryption.getSelectedStorageBackend() === 'basic_text');

/** Each profile's session token: encrypted in settings when it can be kept, else in memory until quit. */
export function createTokenStore(
  settings: SettingsStore,
  encryption: Encryption,
  platform: NodeJS.Platform,
) {
  const keep = canKeepToken(encryption, platform);
  const memory = new Map<string, string>();

  function decrypt(stored: string | undefined): string | null {
    if (!stored) return null;
    try {
      return encryption.decryptString(Buffer.from(stored, 'base64'));
    } catch {
      // Encrypted by another user or key: sign in again.
      return null;
    }
  }

  return {
    get(id: string): string | null {
      return keep ? decrypt(settings.get().tokens?.[id]) : (memory.get(id) ?? null);
    },
    async set(id: string, token: string): Promise<void> {
      memory.set(id, token);
      if (!keep) return;
      const encrypted = encryption.encryptString(token).toString('base64');
      await settings.update({ tokens: { ...settings.get().tokens, [id]: encrypted } });
    },
    async clear(id: string): Promise<void> {
      memory.delete(id);
      const tokens = settings.get().tokens;
      if (tokens?.[id] === undefined) return;
      const { [id]: _removed, ...rest } = tokens;
      await settings.update({ tokens: rest });
    },
    /** The token kept before profiles, when it can be read. */
    legacy(): string | null {
      return keep ? decrypt(settings.get().token) : null;
    },
  };
}

export type TokenStore = ReturnType<typeof createTokenStore>;
