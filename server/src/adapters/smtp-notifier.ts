import type { Transporter } from 'nodemailer';
import { describeNotices } from '../core/ops/check.ts';
import type { AlertNotice, Notifier } from '../core/ports.ts';

type Transport = Pick<Transporter, 'sendMail'>;

/** Emails alert changes through an SMTP server (`smtp://user:pass@host:587`). */
export class SmtpNotifier implements Notifier {
  readonly #smtpUrl: string;
  #transport: Transport | null;
  readonly #to: string;
  readonly #from: string;
  readonly #publicUrl: string | null;

  constructor(options: {
    smtpUrl: string;
    to: string;
    from: string;
    publicUrl: string | null;
    transport?: Transport;
  }) {
    this.#smtpUrl = options.smtpUrl;
    this.#transport = options.transport ?? null;
    this.#to = options.to;
    this.#from = options.from;
    this.#publicUrl = options.publicUrl;
  }

  async notify(notices: AlertNotice[]): Promise<void> {
    const { subject, text } = describeNotices(notices, this.#publicUrl);
    // Loaded on first use, so processes that never send mail do not load it.
    this.#transport ??= (await import('nodemailer')).default.createTransport(this.#smtpUrl);
    await this.#transport.sendMail({ from: this.#from, to: this.#to, subject, text });
  }
}
