import { describe, expect, it } from 'vitest';
import { SmtpNotifier } from './smtp-notifier.ts';

describe('SmtpNotifier', () => {
  it('sends one email describing the alert changes', async () => {
    const sent: unknown[] = [];
    const notifier = new SmtpNotifier({
      smtpUrl: 'smtp://mail:25',
      to: 'ops@example.com',
      from: 'reader@example.com',
      publicUrl: null,
      transport: {
        sendMail: (message: unknown) => {
          sent.push(message);
          return Promise.resolve({} as never);
        },
      },
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
    expect(sent).toEqual([
      {
        from: 'reader@example.com',
        to: 'ops@example.com',
        subject: '[Newses] alerts 1 opened',
        text: 'Opened:\n- [warning] host.rate_limited (a.example): a.example asked us to slow down\n',
      },
    ]);
  });
});
