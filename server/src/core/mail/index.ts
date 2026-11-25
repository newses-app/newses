import type { Db } from '../../db/client.ts';
import { userLocale } from '../../i18n.ts';
import { AccountEmailService } from '../auth/account-email.ts';
import type { UserRow } from '../auth/sessions.ts';
import type { EntryService } from '../entries/entries.ts';
import { DomainError } from '../errors.ts';
import type { ImageProxy } from '../feeds/images.ts';
import type { Logger, Mailer } from '../ports.ts';
import type { PrefsService } from '../prefs.ts';
import type { UserRateLimiter } from '../rate-limit.ts';
import { type ArticleMailInclude, articleMail, isHttp } from './article-mail.ts';
import { DigestService } from './digest-service.ts';

export interface MailDeps {
  db: Db;
  /** Null when the server has no mail configured, which refuses mail to users. */
  mailer: Mailer | null;
  limits: UserRateLimiter;
  prefs: PrefsService;
  entries: EntryService;
  images: ImageProxy;
  logger: Logger;
  /** Origin of the web app that scheduled mail (digests) links to; null stops digests. */
  publicUrl: string | null;
  /** Signs digest unsubscribe links (the `digest-unsubscribe` key). */
  unsubscribeKey: Buffer;
  /** Wakes what sends test digests, where nothing polls for them (AWS). */
  wakeTests?: () => Promise<void>;
}

/** What a request that mails something knows of where it came from. */
export interface MailRequestContext {
  /** Origin of the web app and API, without a trailing slash, for links and proxied images. */
  appUrl: string;
  /** The requesting device's languages, for a user who has not chosen one. */
  acceptLanguage?: string | undefined;
}

export interface ArticleMailRequest {
  /** Distinct addresses, at most `MAX_EMAIL_RECIPIENTS`. */
  to: readonly string[];
  note?: string | undefined;
  include: ArticleMailInclude;
}

/** Mails articles users send to others, from the instance, with the sender as `Reply-To`. */
export class ArticleMailService {
  readonly #deps: MailDeps;

  constructor(deps: MailDeps) {
    this.#deps = deps;
  }

  /**
   * Sends the user's entry to `to`. Needs the sender's confirmed address, which replies go to; a
   * link needs an article with a web address.
   */
  async send(
    user: UserRow,
    entryId: number,
    { to, note, include }: ArticleMailRequest,
    context: MailRequestContext,
  ): Promise<void> {
    const { mailer, entries, prefs, images, limits, logger } = this.#deps;
    if (!mailer) throw new DomainError('mail_unavailable', 'This server has no mail configured');
    if (!user.email) {
      throw new DomainError('conflict', 'Confirm an email address first', {
        reason: 'email_unconfirmed',
      });
    }
    const entry = await entries.get(user.id, entryId);
    if (include === 'link' && !isHttp(entry.link)) {
      throw new DomainError('invalid_input', 'This article has no web address', {
        reason: 'article_no_address',
      });
    }
    await limits.take(user.id, 'emailArticle');
    const { language, proxyImages } = await prefs.get(user.id);
    const html = entry.fullContent ?? entry.content ?? null;
    // Signed proxy paths load without a session, so recipients' mail clients can show them.
    const content = html && proxyImages ? images.rewrite(html, context.appUrl) : html;
    const recipients = to.filter(
      (address, index) =>
        to.findIndex((other) => other.toLowerCase() === address.toLowerCase()) === index,
    );
    try {
      await mailer.send({
        to: recipients,
        replyTo: user.email,
        ...articleMail({
          entry,
          locale: userLocale(language, context.acceptLanguage),
          sender: user.login,
          note,
          include,
          content,
        }),
      });
    } catch (err) {
      logger.warn({ err, userId: user.id }, 'article email failed');
      throw new DomainError('mail_failed', 'The article could not be emailed');
    }
  }
}

/** Mail to users: the addresses they confirm, the articles they send, and their digests. */
export function createMailServices(deps: MailDeps) {
  return {
    account: new AccountEmailService(deps),
    articles: new ArticleMailService(deps),
    digest: new DigestService(deps),
  };
}

export type MailServices = ReturnType<typeof createMailServices>;
