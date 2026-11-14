import type { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { describe, expect, it } from 'vitest';
import { NodemailerMailer } from './mailer.ts';
import { sesOptions, sesTransport } from './ses-mail-transport.ts';

describe('sesTransport', () => {
  it('sends raw MIME through the configuration set', async () => {
    const commands: SendEmailCommand[] = [];
    const client = {
      config: { region: () => Promise.resolve('us-east-2') },
      send: (command: SendEmailCommand) => {
        commands.push(command);
        return Promise.resolve({ MessageId: 'id' });
      },
    };
    const mailer = new NodemailerMailer({
      from: 'Newses <newses@reader.example>',
      createTransport: sesTransport(client),
      extra: sesOptions('newses-dev-mail'),
    });
    await mailer.send({
      to: ['reader@example.com'],
      subject: 'Digest',
      html: '<p>3 unread</p>',
      text: '3 unread',
      unsubscribeUrl: 'https://reader.example/public/unsubscribe/token',
    });
    const [command] = commands;
    expect(commands).toHaveLength(1);
    const input = command?.input;
    expect(input?.ConfigurationSetName).toBe('newses-dev-mail');
    const raw = new TextDecoder().decode(input?.Content?.Raw?.Data);
    expect(raw).toContain('From: Newses <newses@reader.example>');
    expect(raw).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  });
});
