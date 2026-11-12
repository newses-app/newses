import { eq, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { feedSources } from '../../db/schema.ts';
import { CryptoError, open, seal } from '../crypto.ts';
import { DomainError } from '../errors.ts';

/** HTTP Basic credentials for a feed; the login holds no colon. */
export interface FeedCredentials {
  login: string;
  password: string;
}

/**
 * Feed sources (`fs`) any subscriber may share. A source with credentials is its one
 * subscription's own: never found by URL, backfilled into other subscriptions, or archived.
 */
export const SHARED_SOURCE = sql`fs.auth_login IS NULL`;

/** `ON CONFLICT` target for raw upserts of a shared source by URL (the partial unique index). */
export const SHARED_URL_CONFLICT = sql`(url) WHERE auth_login IS NULL`;

export const feedCredentialContext = (feedSourceId: number) =>
  `feed-source:${String(feedSourceId)}:password`;

/** Where a source's credentials are sent: the origin of its URL, never another. */
export const credentialOrigin = (url: string) => new URL(url).origin;

/** Seals and opens feed passwords with the `feed-credentials` key. */
export class FeedCredentialSealer {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    this.#key = key;
  }

  seal(feedSourceId: number, password: string): string {
    return seal(this.#key, password, feedCredentialContext(feedSourceId));
  }

  /**
   * The source's credentials, or null when it has none. Throws CryptoError when the password was
   * sealed under another APP_SECRET.
   */
  open(source: {
    id: number;
    authLogin: string | null;
    authPassword: string | null;
  }): FeedCredentials | null {
    if (source.authLogin === null) return null;
    return {
      login: source.authLogin,
      password: open(this.#key, source.authPassword ?? '', feedCredentialContext(source.id)),
    };
  }

  /**
   * Re-seals every feed password sealed under `previousKey` (another instance's) with this key,
   * all or none; returns how many. Passwords this key opens already are left, so a run cut short
   * can be repeated. Throws when one opens under neither.
   */
  async reseal(db: Db, previousKey: Buffer): Promise<number> {
    if (previousKey.equals(this.#key)) return 0;
    return db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: feedSources.id, authPassword: feedSources.authPassword })
        .from(feedSources)
        .where(isNotNull(feedSources.authPassword))
        .for('update');
      let count = 0;
      for (const { id, authPassword } of rows) {
        const context = feedCredentialContext(id);
        if (opens(this.#key, authPassword ?? '', context)) continue;
        let password: string;
        try {
          password = open(previousKey, authPassword ?? '', context);
        } catch (err) {
          if (!(err instanceof CryptoError)) throw err;
          throw new DomainError(
            'invalid_input',
            `Feed ${String(id)}'s password does not open with the previous secret`,
          );
        }
        await tx
          .update(feedSources)
          .set({ authPassword: seal(this.#key, password, context) })
          .where(eq(feedSources.id, id));
        count++;
      }
      return count;
    });
  }
}

function opens(key: Buffer, sealed: string, context: string): boolean {
  try {
    open(key, sealed, context);
    return true;
  } catch (err) {
    if (!(err instanceof CryptoError)) throw err;
    return false;
  }
}
