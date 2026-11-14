import type { SESv2Client } from '@aws-sdk/client-sesv2';
import type { SendMailOptions } from 'nodemailer';
import type { MailTransport } from './mailer.ts';

type Client = Pick<SESv2Client, 'send'>;

/**
 * Sends through the SES v2 API with the function's IAM role, as raw MIME (so `List-*` headers are
 * kept); the SDK and nodemailer load on first send.
 */
export function sesTransport(client?: Client): () => Promise<MailTransport> {
  return async () => {
    const [{ SESv2Client, SendEmailCommand }, nodemailer] = await Promise.all([
      import('@aws-sdk/client-sesv2'),
      import('nodemailer'),
    ]);
    return nodemailer.default.createTransport({
      SES: { sesClient: client ?? new SESv2Client({}), SendEmailCommand },
    });
  };
}

/** Message fields that send every message through the stage's configuration set. */
export function sesOptions(configurationSet: string): Partial<SendMailOptions> {
  return { ses: { ConfigurationSetName: configurationSet } };
}
