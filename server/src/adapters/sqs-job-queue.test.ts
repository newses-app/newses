import type { SendMessageCommand } from '@aws-sdk/client-sqs';
import { describe, expect, it } from 'vitest';
import type { Jobs } from '../core/jobs.ts';
import { SqsJobQueue } from './sqs-job-queue.ts';

describe('SqsJobQueue', () => {
  it("sends each job to its name's queue, capping delays at 15 minutes", async () => {
    const sent: SendMessageCommand['input'][] = [];
    const client = {
      send: (command: SendMessageCommand) => {
        sent.push(command.input);
        return Promise.resolve({});
      },
    };
    const queue = new SqsJobQueue<Jobs>(
      { 'feed.fetch': 'https://sqs/fetch', 'feed.favicon': 'https://sqs/favicon' },
      client as never,
    );
    expect(await queue.enqueue('feed.fetch', { feedSourceIds: [1, 2] }, { key: 'a.example' })).toBe(
      true,
    );
    await queue.enqueue('feed.favicon', { feedSourceId: 3 }, { key: '3', delaySeconds: 3600 });
    expect(sent).toEqual([
      { QueueUrl: 'https://sqs/fetch', MessageBody: '{"feedSourceIds":[1,2]}' },
      { QueueUrl: 'https://sqs/favicon', MessageBody: '{"feedSourceId":3}', DelaySeconds: 900 },
    ]);
    await expect(queue.work()).rejects.toThrow(/event source mappings/);
  });
});
