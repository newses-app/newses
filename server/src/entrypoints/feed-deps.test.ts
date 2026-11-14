import { describe, expect, it } from 'vitest';
import { loadConfig } from '../adapters/env-config.ts';
import { NodemailerMailer } from '../adapters/mailer.ts';
import { TEST_APP_SECRET } from '../test/fakes.ts';
import { createMailer } from './feed-deps.ts';

const base = { DATABASE_URL: 'postgres://db/app', APP_SECRET: TEST_APP_SECRET };

describe('createMailer', () => {
  it('mails over SMTP when SMTP_URL is set, and not at all without it', () => {
    expect(createMailer(loadConfig(base))).toBeNull();
    expect(createMailer(loadConfig({ ...base, SMTP_URL: 'smtp://mail:25' }))).toBeInstanceOf(
      NodemailerMailer,
    );
  });

  it('refuses SES, which the image cannot load', () => {
    const config = loadConfig({ ...base, MAIL_SES_CONFIGURATION_SET: 'set' });
    expect(() => createMailer(config)).toThrow(/only the AWS functions/);
  });
});
