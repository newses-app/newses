import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EnqueueOptions, JobMap, JobQueue } from '../core/ports.ts';
import { injectTraceContext } from '../telemetry/index.ts';

/** SQS caps message delays at 15 minutes. */
const MAX_DELAY_SECONDS = 900;

/**
 * JobQueue on SQS standard queues, one per job name. Lambda event source mappings consume them,
 * so `work` is unsupported. Keys are not deduplicated; callers' database leases keep duplicate
 * jobs harmless.
 */
export class SqsJobQueue<J extends JobMap> implements JobQueue<J> {
  readonly #queueUrls: Record<keyof J & string, string>;
  readonly #client: Pick<SQSClient, 'send'>;

  constructor(queueUrls: Record<keyof J & string, string>, client: Pick<SQSClient, 'send'>) {
    this.#queueUrls = queueUrls;
    this.#client = client;
  }

  async enqueue<N extends keyof J & string>(
    name: N,
    data: J[N],
    options: EnqueueOptions = {},
  ): Promise<boolean> {
    // The consumer continues the trace that queued the job, when one is being recorded.
    const { traceparent } = injectTraceContext();
    await this.#client.send(
      new SendMessageCommand({
        QueueUrl: this.#queueUrls[name],
        MessageBody: JSON.stringify(data),
        ...(traceparent && {
          MessageAttributes: { traceparent: { DataType: 'String', StringValue: traceparent } },
        }),
        ...(options.delaySeconds !== undefined && {
          DelaySeconds: Math.min(MAX_DELAY_SECONDS, Math.ceil(options.delaySeconds)),
        }),
      }),
    );
    return true;
  }

  work(): Promise<void> {
    return Promise.reject(new Error('SQS jobs are consumed by Lambda event source mappings'));
  }
}
