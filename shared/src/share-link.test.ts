import { describe, expect, it } from 'vitest';
import { mailtoUrl } from './share-link.ts';

describe('mailtoUrl', () => {
  it('opens a mail with the title as its subject and the text, then the link, as its body', () => {
    const url = mailtoUrl({
      title: 'Cats & dogs?',
      text: 'Shared copy:\nhttps://reader.example/public/share/x',
      url: 'https://news.example/a?b=1&c=2',
    });
    expect(url.startsWith('mailto:?subject=')).toBe(true);
    const params = new URLSearchParams(url.slice('mailto:?'.length));
    expect(params.get('subject')).toBe('Cats & dogs?');
    expect(params.get('body')).toBe(
      'Shared copy:\r\nhttps://reader.example/public/share/x\r\n\r\nhttps://news.example/a?b=1&c=2',
    );
    expect(params.has('to')).toBe(false);
  });

  it('leaves out empty text', () => {
    const url = mailtoUrl({ title: 'A', text: '', url: 'https://news.example/a' });
    expect(url).toBe('mailto:?subject=A&body=https%3A%2F%2Fnews.example%2Fa');
  });
});
