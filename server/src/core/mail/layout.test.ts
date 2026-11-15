import { describe, expect, it } from 'vitest';
import { renderMail } from './layout.ts';

describe('renderMail', () => {
  const mail = renderMail({
    locale: 'de',
    subject: 'Fish & <Chips>',
    paragraphs: ['First <b>bold</b>', 'Second'],
    action: { label: 'Open "it"', url: 'https://reader.example/x?a=1&b=2' },
  });

  it('escapes everything in the HTML part', () => {
    expect(mail.html).toContain('<title>Fish &amp; &lt;Chips&gt;</title>');
    expect(mail.html).toContain('<p>First &lt;b&gt;bold&lt;/b&gt;</p>');
    expect(mail.html).toContain('href="https://reader.example/x?a=1&amp;b=2"');
    expect(mail.html).toContain('>Open &quot;it&quot;</a>');
    expect(mail.html).toContain('<html lang="de" dir="ltr">');
    expect(mail.html).not.toMatch(/<img|<link|https?:\/\/(?!reader\.example)/);
  });

  it('puts the action after the first paragraph, its link spelled out in the text', () => {
    expect(mail.text).toBe(
      'First <b>bold</b>\n\nOpen "it": https://reader.example/x?a=1&b=2\n\nSecond\n',
    );
    expect(mail.subject).toBe('Fish & <Chips>');
  });
});
