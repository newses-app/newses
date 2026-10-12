import { describe, expect, it } from 'vitest';
import type { ArchiveReader, ArchiveRow, ArchiveWriter } from '../core/ports.ts';

const A = 'https://a.example/feed';
const B = 'https://b.example/feed';

export const archiveRow = (overrides: Partial<ArchiveRow>): ArchiveRow => ({
  id: null,
  feedUrl: A,
  feedTitle: 'A',
  guid: 'g',
  link: null,
  title: null,
  author: null,
  content: null,
  text: null,
  lang: null,
  publishedAt: null,
  sourceUpdatedAt: null,
  fetchedAt: new Date('2024-05-01T00:00:00Z'),
  sortAt: new Date('2024-05-01T00:00:00Z'),
  archivedAt: new Date('2026-01-01T00:00:00Z'),
  enclosures: [],
  ...overrides,
});

const at = (iso: string) => new Date(iso);

/** Two feeds over three months; `a3` was archived twice, the second time with a new title. */
async function fill(writer: ArchiveWriter) {
  await writer.write([
    archiveRow({ guid: 'a1', title: 'First apple', sortAt: at('2024-04-10T00:00:00Z') }),
    archiveRow({
      guid: 'a2',
      title: 'Second',
      text: 'Apple pie',
      sortAt: at('2024-05-02T00:00:00Z'),
    }),
    archiveRow({ guid: 'a3', title: 'Old title', sortAt: at('2024-06-03T00:00:00Z') }),
    archiveRow({
      feedUrl: B,
      guid: 'b1',
      title: 'Banana apple',
      sortAt: at('2024-05-02T00:00:00Z'),
    }),
  ]);
  await writer.write([
    archiveRow({
      id: 42,
      guid: 'a3',
      title: 'New title',
      link: 'https://a.example/3',
      content: '<p>Hello</p>',
      text: 'Hello',
      publishedAt: at('2024-06-03T00:00:00Z'),
      sortAt: at('2024-06-03T00:00:00Z'),
      archivedAt: at('2026-02-01T00:00:00Z'),
      enclosures: [
        {
          url: 'https://a.example/3.mp3',
          mimeType: 'audio/mpeg',
          length: 123,
          width: null,
          height: null,
          durationSeconds: 61,
        },
      ],
    }),
    archiveRow({ guid: 'long', text: 'x'.repeat(1000), sortAt: at('2024-03-01T00:00:00Z') }),
  ]);
}

/** Reading behaviour every ArchiveReader shares; `setup` gives a reader over an empty archive. */
export function describeArchiveReader(
  name: string,
  setup: () => { reader: ArchiveReader; writer: ArchiveWriter },
) {
  describe(name, () => {
    const query = { feedUrls: [A, B], terms: [], after: null, limit: 10 };

    it('reads nothing from an empty archive', async () => {
      const { reader } = setup();
      expect(await reader.list(query)).toEqual([]);
      expect(await reader.get('2024-05', A, 'a2')).toBeNull();
    });

    it('lists the given feeds newest first, each article once as archived last', async () => {
      const { reader, writer } = setup();
      await fill(writer);
      const rows = await reader.list(query);
      expect(rows.map((r) => r.guid)).toEqual(['a3', 'b1', 'a2', 'a1', 'long']);
      expect(rows[0]).toMatchObject({ id: 42, title: 'New title', content: null, enclosures: [] });
      expect(rows[0]?.sortAt).toEqual(at('2024-06-03T00:00:00Z'));
      expect(rows.at(-1)?.text).toHaveLength(300);
      expect((await reader.list({ ...query, feedUrls: [B] })).map((r) => r.guid)).toEqual(['b1']);
      expect(await reader.list({ ...query, feedUrls: [] })).toEqual([]);
    });

    it('pages after a position', async () => {
      const { reader, writer } = setup();
      await fill(writer);
      const first = await reader.list({ ...query, limit: 2 });
      expect(first.map((r) => r.guid)).toEqual(['a3', 'b1']);
      const last = first.at(-1);
      if (!last) throw new Error('no rows');
      const next = await reader.list({ ...query, limit: 2, after: last });
      expect(next.map((r) => r.guid)).toEqual(['a2', 'a1']);
    });

    it('searches titles and text for every term, ignoring case', async () => {
      const { reader, writer } = setup();
      await fill(writer);
      const search = async (terms: string[]) =>
        (await reader.list({ ...query, terms })).map((r) => r.guid);
      expect(await search(['apple'])).toEqual(['b1', 'a2', 'a1']);
      expect(await search(['apple', 'banana'])).toEqual(['b1']);
      expect(await search(['o'])).toContain('a3');
    });

    it('gets one article with its content and enclosures, in its month', async () => {
      const { reader, writer } = setup();
      await fill(writer);
      expect(await reader.get('2024-06', A, 'a3')).toMatchObject({
        id: 42,
        title: 'New title',
        link: 'https://a.example/3',
        content: '<p>Hello</p>',
        text: 'Hello',
        publishedAt: at('2024-06-03T00:00:00Z'),
        archivedAt: at('2026-02-01T00:00:00Z'),
        enclosures: [
          {
            url: 'https://a.example/3.mp3',
            mimeType: 'audio/mpeg',
            length: 123,
            width: null,
            height: null,
            durationSeconds: 61,
          },
        ],
      });
      expect(await reader.get('2024-05', A, 'a3')).toBeNull();
    });
  });
}
