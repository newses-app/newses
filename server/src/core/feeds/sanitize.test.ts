import { describe, expect, it } from 'vitest';
import { sanitizeContent, sanitizeTitle } from './sanitize.ts';

const BASE = 'https://blog.example/posts/1';

describe('sanitizeContent', () => {
  it('removes scripts, styles, event handlers, and unsafe URLs', () => {
    const html = `<p onclick="steal()">Hi<script>alert(1)</script><style>p{}</style></p>
      <a href="javascript:alert(1)">x</a><img src="x.png" onerror="steal()"><iframe src="https://evil.example/"></iframe>
      <form><input></form><object data="x"></object>`;
    const clean = sanitizeContent(html, BASE);
    expect(clean).not.toMatch(
      /script|onclick|onerror|javascript:|<style|evil\.example|<form|<input|<object/,
    );
    expect(clean).toContain('<p>Hi</p>');
  });

  it('resolves relative URLs, including srcset, and hardens links', () => {
    const clean = sanitizeContent(
      '<a href="../2">next</a><img src="/i.png" srcset="a.png 1x, /b.png 2x">',
      BASE,
    );
    expect(clean).toContain('href="https://blog.example/2"');
    expect(clean).toContain('target="_blank"');
    expect(clean).toContain('rel="noopener noreferrer nofollow"');
    expect(clean).toContain('src="https://blog.example/i.png"');
    expect(clean).toContain(
      'srcset="https://blog.example/posts/a.png 1x, https://blog.example/b.png 2x"',
    );
  });

  it('keeps media, tables, and allow-listed embeds', () => {
    const clean = sanitizeContent(
      '<video src="v.mp4"></video><table><tr><td colspan="2">x</td></tr></table><iframe src="https://www.youtube-nocookie.com/embed/abc"></iframe><img src="data:image/png;base64,AAAA">',
      BASE,
    );
    expect(clean).toContain('<video src="https://blog.example/posts/v.mp4" controls');
    expect(clean).toContain('<td colspan="2">');
    expect(clean).toContain('youtube-nocookie.com/embed/abc');
    expect(clean).toContain('src="data:image/png;base64,AAAA"');
  });

  it('strips control characters', () => {
    expect(sanitizeContent('<p>a\u0001b\u0007c</p>', null)).toBe('<p>abc</p>');
  });
});

describe('sanitizeTitle', () => {
  it('returns plain text', () => {
    expect(sanitizeTitle('  <b>Bold</b>   &amp; 5 < 6\n')).toBe('Bold & 5 < 6');
    expect(sanitizeTitle('<script>x</script>')).toBeNull();
    expect(sanitizeTitle(null)).toBeNull();
  });
});
