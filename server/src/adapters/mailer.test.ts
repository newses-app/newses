import { describe, expect, it } from 'vitest';
import { NodemailerMailer, smtpTransport, type MailTransport } from './mailer.ts';

function recording(): MailTransport & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    sendMail: (message: unknown) => {
      sent.push(message);
      return Promise.resolve({} as never);
    },
  };
}

describe('NodemailerMailer', () => {
  it('sends from the instance with the reply address and both parts', async () => {
    const transport = recording();
    const mailer = new NodemailerMailer({
      from: 'Newses <newses@reader.example>',
      createTransport: () => Promise.resolve(transport),
    });
    await mailer.send({
      to: ['friend@example.com'],
      replyTo: 'reader@example.com',
      subject: 'An article',
      html: '<p>Hello</p>',
      text: 'Hello',
    });
    expect(transport.sent).toEqual([
      {
        from: 'Newses <newses@reader.example>',
        to: ['friend@example.com'],
        replyTo: 'reader@example.com',
        subject: 'An article',
        html: '<p>Hello</p>',
        text: 'Hello',
      },
    ]);
  });

  it('adds one-click unsubscribe headers and transport fields', async () => {
    const transport = recording();
    const mailer = new NodemailerMailer({
      from: 'Newses <newses@reader.example>',
      createTransport: () => Promise.resolve(transport),
      extra: { ses: { ConfigurationSetName: 'set' } },
    });
    await mailer.send({
      to: ['reader@example.com'],
      subject: 'Digest',
      html: '<p>3 unread</p>',
      text: '3 unread',
      unsubscribeUrl: 'https://reader.example/public/unsubscribe/token',
    });
    expect(transport.sent[0]).toMatchObject({
      ses: { ConfigurationSetName: 'set' },
      list: { unsubscribe: 'https://reader.example/public/unsubscribe/token' },
      headers: { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    });
    expect(transport.sent[0]).not.toHaveProperty('replyTo');
  });

  it('creates the transport once, and again after a failure', async () => {
    const transport = recording();
    let calls = 0;
    const mailer = new NodemailerMailer({
      from: 'n@example.com',
      createTransport: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('down')) : Promise.resolve(transport);
      },
    });
    const message = { to: ['a@example.com'], subject: 's', html: 'h', text: 't' };
    await expect(mailer.send(message)).rejects.toThrow('down');
    await mailer.send(message);
    await mailer.send(message);
    expect(calls).toBe(2);
    expect(transport.sent).toHaveLength(2);
  });

  it('builds a complete MIME message over SMTP', async () => {
    // nodemailer's stream transport builds the message without a server.
    const nodemailer = (await import('nodemailer')).default;
    const stream = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const raw: string[] = [];
    const mailer = new NodemailerMailer({
      from: 'Newses <newses@reader.example>',
      createTransport: () =>
        Promise.resolve({
          sendMail: async (options) => {
            const info = await stream.sendMail(options);
            raw.push(Buffer.isBuffer(info.message) ? info.message.toString('utf8') : '');
            return info;
          },
        }),
    });
    await mailer.send({
      to: ['reader@example.com'],
      subject: 'Digest',
      html: '<p>3 unread</p>',
      text: '3 unread',
      unsubscribeUrl: 'https://reader.example/public/unsubscribe/token',
    });
    expect(raw[0]).toContain('List-Unsubscribe: <https://reader.example/public/unsubscribe/token>');
    expect(raw[0]).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    expect(raw[0]).toContain('multipart/alternative');
    expect(typeof smtpTransport('smtp://mail:25')).toBe('function');
  });
});
