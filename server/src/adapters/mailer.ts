import type { SendMailOptions, Transporter } from 'nodemailer';
import type { MailMessage, Mailer } from '../core/ports.ts';

export type MailTransport = Pick<Transporter, 'sendMail'>;

/**
 * Sends user mail through a nodemailer transport, created on first use: SMTP here, or SES on
 * AWS (`ses-mail-transport.ts`). Every message comes from the instance's address.
 */
export class NodemailerMailer implements Mailer {
  readonly #from: string;
  readonly #createTransport: () => Promise<MailTransport>;
  readonly #extra: Partial<SendMailOptions>;
  #transport: Promise<MailTransport> | null = null;

  constructor(options: {
    from: string;
    createTransport: () => Promise<MailTransport>;
    /** Transport-specific fields added to every message, such as `ses`. */
    extra?: Partial<SendMailOptions>;
  }) {
    this.#from = options.from;
    this.#createTransport = options.createTransport;
    this.#extra = options.extra ?? {};
  }

  async send(message: MailMessage): Promise<void> {
    this.#transport ??= this.#createTransport().catch((err: unknown) => {
      this.#transport = null;
      throw err;
    });
    const transport = await this.#transport;
    await transport.sendMail({ ...this.#extra, ...mailOptions(this.#from, message) });
  }
}

/** The nodemailer message for `message`, with RFC 8058 one-click unsubscribe headers. */
export function mailOptions(from: string, message: MailMessage): SendMailOptions {
  return {
    from,
    to: message.to,
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    subject: message.subject,
    text: message.text,
    html: message.html,
    ...(message.unsubscribeUrl
      ? {
          list: { unsubscribe: message.unsubscribeUrl },
          headers: { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        }
      : {}),
  };
}

/**
 * How long a send waits on the relay, in milliseconds: shorter than nodemailer's minutes, so a
 * wrong or unreachable host fails while the user waits for the answer. The URL's query
 * (`?connectionTimeout=…`) overrides them.
 */
export const SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
};

/** An SMTP transport for `smtp://` or `smtps://` URLs; nodemailer loads on first send. */
export function smtpTransport(url: string): () => Promise<MailTransport> {
  return async () =>
    (await import('nodemailer')).default.createTransport({ url, ...SMTP_TIMEOUTS });
}
