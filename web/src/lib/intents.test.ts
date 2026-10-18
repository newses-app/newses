import { describe, expect, it } from 'vitest';
import {
  bookmarklets,
  MAX_BOOKMARKLET_TEXT,
  publishDraftFrom,
  sharedLinkFrom,
  subscribeUrlFrom,
} from './intents.ts';

/** Runs a bookmarklet on a page, returning what it opened. */
function run(code: string, page: { href: string; title: string; selection: string }) {
  const opened: unknown[][] = [];
  const body = code.replace(/^javascript:/, '');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const bookmarklet = new Function('open', 'location', 'document', 'getSelection', body) as (
    ...args: unknown[]
  ) => void;
  bookmarklet(
    (...args: unknown[]) => opened.push(args),
    { href: page.href },
    { title: page.title },
    () => page.selection,
  );
  return opened;
}

describe('intent addresses', () => {
  it('fill in the publish dialog from the first value of each parameter', () => {
    expect(
      publishDraftFrom({ url: [' https://a.example/x ', 'other'], title: 'T', text: '' }),
    ).toEqual({ url: 'https://a.example/x', title: 'T', text: null });
    expect(publishDraftFrom({ title: 'No address' })).toBeNull();
    expect(
      publishDraftFrom({ url: 'https://a.example/', text: 'x'.repeat(200_000) })?.text,
    ).toHaveLength(100_000);
  });

  it('fill in the subscribe dialog', () => {
    expect(subscribeUrlFrom({ url: 'https://a.example/' })).toBe('https://a.example/');
    expect(subscribeUrlFrom({})).toBeNull();
  });

  it('take a shared page from a share target, whose address is often in the text', () => {
    expect(sharedLinkFrom({ title: 'Story', text: 'https://a.example/s' })).toEqual({
      url: 'https://a.example/s',
      title: 'Story',
    });
    expect(sharedLinkFrom({ url: 'https://a.example/s', text: 'Look at this' })).toEqual({
      url: 'https://a.example/s',
      title: 'Look at this',
    });
    expect(sharedLinkFrom({ text: 'no address' })).toBeNull();
  });
});

describe('bookmarklets', () => {
  const marks = bookmarklets("https://reader.example/it's");
  const page = { href: 'https://blog.example/post?a=1&b=2', title: 'A post & more', selection: '' };

  it('open the publish dialog for the page, with its title and selected text', () => {
    expect(marks.publish.startsWith('javascript:')).toBe(true);
    const [[url, name, features] = []] = run(marks.publish, page);
    expect(url).toBe(
      "https://reader.example/it's/publish?url=https%3A%2F%2Fblog.example%2Fpost%3Fa%3D1%26b%3D2&title=A%20post%20%26%20more",
    );
    expect([name, features]).toEqual(['newses', 'popup,width=600,height=720']);
    const [[selected] = []] = run(marks.publish, { ...page, selection: 'y'.repeat(5000) });
    const text = new URL(String(selected)).searchParams.get('text');
    expect(text).toHaveLength(MAX_BOOKMARKLET_TEXT);
  });

  it('open the subscribe dialog for the page', () => {
    expect(run(marks.subscribe, page)).toEqual([
      [
        "https://reader.example/it's/subscribe?url=https%3A%2F%2Fblog.example%2Fpost%3Fa%3D1%26b%3D2",
        'newses',
        'popup,width=600,height=720',
      ],
    ]);
  });
});
