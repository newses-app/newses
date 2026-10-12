import type { SNSClient } from '@aws-sdk/client-sns';
import { describeNotices } from '../core/ops/check.ts';
import type { AlertNotice, Notifier } from '../core/ports.ts';

type Client = Pick<SNSClient, 'send'>;

/** SNS caps subjects at 100 characters. */
const MAX_SUBJECT = 100;

/** Publishes alert changes to an SNS topic, whose subscribers receive them by email. */
export class SnsNotifier implements Notifier {
  readonly #topicArn: string;
  readonly #publicUrl: string | null;
  #client: Client | null;

  constructor(options: { topicArn: string; publicUrl: string | null; client?: Client }) {
    this.#topicArn = options.topicArn;
    this.#publicUrl = options.publicUrl;
    this.#client = options.client ?? null;
  }

  async notify(notices: AlertNotice[]): Promise<void> {
    const { subject, text } = describeNotices(notices, this.#publicUrl);
    // Loaded on first use, so invocations that open or resolve no alert do not load it.
    const { PublishCommand, SNSClient } = await import('@aws-sdk/client-sns');
    this.#client ??= new SNSClient({});
    await this.#client.send(
      new PublishCommand({
        TopicArn: this.#topicArn,
        Subject: subject.slice(0, MAX_SUBJECT),
        Message: text,
      }),
    );
  }
}
