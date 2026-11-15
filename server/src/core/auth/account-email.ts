import { and, eq, gt } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { users } from '../../db/schema.ts';
import { translate, userLocale } from '../../i18n.ts';
import { DomainError } from '../errors.ts';
import { renderMail } from '../mail/layout.ts';
import type { Logger, Mailer } from '../ports.ts';
import type { PrefsService } from '../prefs.ts';
import type { UserRateLimiter } from '../rate-limit.ts';
import type { UserRow } from './sessions.ts';
import { hashToken, newToken } from './tokens.ts';

/** Hours a confirmation link works for. */
export const EMAIL_TOKEN_HOURS = 24;

export interface AccountEmailDeps {
  db: Db;
  /** Null when the server has no mail configured, which refuses addresses. */
  mailer: Mailer | null;
  limits: UserRateLimiter;
  prefs: PrefsService;
  logger: Logger;
  now?: () => Date;
}

export interface EmailRequestContext {
  /** Origin of the web app the link opens, without a trailing slash. */
  appUrl: string;
  /** The requesting device's languages, for a user who has not chosen one. */
  acceptLanguage?: string | undefined;
}

const sameAddress = (a: string | null, b: string) => a?.toLowerCase() === b.toLowerCase();

/**
 * The address each user's mail goes to. A new one waits, unconfirmed, until its owner follows the
 * link mailed to it, so mail only ever goes to an inbox that asked for it; the confirmed address
 * stays until then.
 */
export class AccountEmailService {
  readonly #db: Db;
  readonly #mailer: Mailer | null;
  readonly #limits: UserRateLimiter;
  readonly #prefs: PrefsService;
  readonly #logger: Logger;
  readonly #now: () => Date;

  constructor({ db, mailer, limits, prefs, logger, now = () => new Date() }: AccountEmailDeps) {
    this.#db = db;
    this.#mailer = mailer;
    this.#limits = limits;
    this.#prefs = prefs;
    this.#logger = logger;
    this.#now = now;
  }

  /** Whether users can add an address: the server has mail configured. */
  get enabled(): boolean {
    return this.#mailer !== null;
  }

  /**
   * Mails a confirmation link to `address`, which waits as the pending address; asking again,
   * for it or another, replaces the link. The confirmed address itself needs no link, and only
   * clears a pending one.
   */
  async request(user: UserRow, address: string, context: EmailRequestContext): Promise<UserRow> {
    const mailer = this.#mailer;
    if (!mailer) {
      throw new DomainError('mail_unavailable', 'This server has no mail configured');
    }
    if (sameAddress(user.email, address)) return this.#setPending(user.id, null, null);
    await this.#limits.take(user.id, 'emailConfirm');
    const token = newToken();
    const updated = await this.#setPending(user.id, address, token);
    const { language } = await this.#prefs.get(user.id);
    const locale = userLocale(language, context.acceptLanguage);
    const message = (key: Parameters<typeof translate>[1]) =>
      translate(locale, key, { login: user.login });
    try {
      await mailer.send({
        to: [address],
        ...renderMail({
          locale,
          subject: message('confirmEmailSubject'),
          paragraphs: [
            message('confirmEmailIntro'),
            message('confirmEmailExpiry'),
            message('confirmEmailIgnore'),
          ],
          action: {
            label: message('confirmEmailAction'),
            url: `${context.appUrl}/confirm-email#${token}`,
          },
        }),
      });
    } catch (err) {
      // The relay's answer is for the operator; it can name hosts the user should not see.
      this.#logger.warn({ err, userId: user.id }, 'confirmation email failed');
      throw new DomainError('mail_failed', 'The confirmation email could not be sent');
    }
    return updated;
  }

  /** Makes the pending address of the link's token the user's; refused once it has expired. */
  async confirm(token: string): Promise<UserRow> {
    const [user] = await this.#db
      .select()
      .from(users)
      .where(
        and(eq(users.emailTokenHash, hashToken(token)), gt(users.emailTokenExpiresAt, this.#now())),
      );
    if (!user?.pendingEmail || user.disabledAt) {
      throw new DomainError('invalid_input', 'This link has expired or was replaced', {
        reason: 'email_link_invalid',
      });
    }
    const [confirmed] = await this.#db
      .update(users)
      .set({
        email: user.pendingEmail,
        emailConfirmedAt: this.#now(),
        pendingEmail: null,
        emailTokenHash: null,
        emailTokenExpiresAt: null,
      })
      .where(and(eq(users.id, user.id), eq(users.emailTokenHash, hashToken(token))))
      .returning();
    if (!confirmed) {
      throw new DomainError('invalid_input', 'This link has expired or was replaced', {
        reason: 'email_link_invalid',
      });
    }
    return confirmed;
  }

  /** Forgets the user's address and any pending one; no mail goes to them after. */
  async remove(userId: number): Promise<UserRow> {
    const [user] = await this.#db
      .update(users)
      .set({
        email: null,
        emailConfirmedAt: null,
        pendingEmail: null,
        emailTokenHash: null,
        emailTokenExpiresAt: null,
      })
      .where(eq(users.id, userId))
      .returning();
    if (!user) throw new DomainError('not_found', 'User not found');
    return user;
  }

  async #setPending(userId: number, address: string | null, token: string | null) {
    const expires = new Date(this.#now().getTime() + EMAIL_TOKEN_HOURS * 60 * 60 * 1000);
    const [user] = await this.#db
      .update(users)
      .set({
        pendingEmail: address,
        emailTokenHash: token && hashToken(token),
        emailTokenExpiresAt: token ? expires : null,
      })
      .where(eq(users.id, userId))
      .returning();
    if (!user) throw new DomainError('not_found', 'User not found');
    return user;
  }
}
