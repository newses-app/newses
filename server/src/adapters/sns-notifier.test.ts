import type { PublishCommand } from '@aws-sdk/client-sns';
import { describe, expect, it } from 'vitest';
import { SnsNotifier } from './sns-notifier.ts';

describe('SnsNotifier', () => {
  it('publishes one message describing the alert changes', async () => {
    const sent: PublishCommand[] = [];
    const notifier = new SnsNotifier({
      topicArn: 'arn:aws:sns:us-east-2:123456789012:newses-dev-alerts',
      publicUrl: null,
      client: {
        send: (command: PublishCommand) => {
          sent.push(command);
          return Promise.resolve({} as never);
        },
      } as never,
    });
    await notifier.notify([
      {
        change: 'opened',
        rule: 'host.rate_limited',
        subject: 'a.example',
        severity: 'warning',
        summary: 'a.example asked us to slow down',
      },
    ]);
    expect(sent.map((command) => command.input)).toEqual([
      {
        TopicArn: 'arn:aws:sns:us-east-2:123456789012:newses-dev-alerts',
        Subject: '[Newses] alerts 1 opened',
        Message:
          'Opened:\n- [warning] host.rate_limited (a.example): a.example asked us to slow down\n',
      },
    ]);
  });
});
