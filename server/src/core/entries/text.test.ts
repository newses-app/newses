import { describe, expect, it } from 'vitest';
import { plainTextToHtml, textOfHtml } from './text.ts';

describe('plainTextToHtml', () => {
  it('escapes text into paragraphs at blank lines, keeping line breaks', () => {
    expect(plainTextToHtml('One <b>&</b>\r\ntwo\n \nThree "quoted"')).toBe(
      '<p>One &lt;b&gt;&amp;&lt;/b&gt;<br>two</p><p>Three &quot;quoted&quot;</p>',
    );
    expect(plainTextToHtml(' \n\n ')).toBeNull();
  });
});

describe('textOfHtml', () => {
  it('strips tags and decodes entities, keeping paragraphs and line breaks', () => {
    expect(
      textOfHtml(
        '<p>First <i>line</i><br>second</p><script>x()</script><div>Fish &amp; chips</div>',
      ),
    ).toBe('First line\nsecond\n\nFish & chips');
    expect(textOfHtml('plain   text')).toBe('plain text');
    expect(textOfHtml('<p> </p>')).toBeNull();
  });
});
