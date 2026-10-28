import type { Enclosure } from '@newses/shared';
import { describe, expect, it } from 'vitest';
import { contentMediaUrls, type EnclosureViewOptions, enclosureViews } from './enclosures.ts';

const b64 = (url: string) => Buffer.from(url).toString('base64url');
const enclosure = (url: string, mimeType: string | null, proxy?: string): Enclosure => ({
  url,
  mimeType,
  length: null,
  width: null,
  height: null,
  durationSeconds: null,
  ...(proxy && { proxy }),
});
const options = (overrides: Partial<EnclosureViewOptions> = {}): EnclosureViewOptions => ({
  content: null,
  stored: new Map(),
  online: true,
  server: null,
  canPlay: () => true,
  ...overrides,
});

describe('contentMediaUrls', () => {
  it('collects images, proxied ones by their original URL, and audio and video sources', () => {
    const html =
      `<img src="https://img.example/a.png"><img src="/api/v1/images/sig/${b64('https://img.example/b.png')}">` +
      '<audio src="https://cdn.example/a.mp3"></audio><video><source src="https://cdn.example/v.mp4"></video>';
    expect([...contentMediaUrls(html)]).toEqual([
      'https://img.example/a.png',
      'https://img.example/b.png',
      'https://cdn.example/a.mp3',
      'https://cdn.example/v.mp4',
    ]);
    expect(contentMediaUrls(null).size).toBe(0);
  });
});

describe('enclosureViews', () => {
  it('plays audio and video, shows images, and links the rest', () => {
    const views = enclosureViews(
      [
        enclosure('https://cdn.example/ep%2042.mp3', 'audio/mpeg'),
        enclosure('https://cdn.example/clip.webm', null),
        enclosure('https://img.example/photo.jpg', 'image/jpeg'),
        enclosure('https://cdn.example/notes.pdf', 'application/pdf'),
        enclosure('javascript:alert(1)', 'audio/mpeg'),
      ],
      options(),
    );
    expect(views.map((v) => [v.kind, v.name, v.player, v.imageSrc])).toEqual([
      ['audio', 'ep 42.mp3', true, null],
      ['video', 'clip.webm', true, null],
      ['image', 'photo.jpg', false, 'https://img.example/photo.jpg'],
      ['other', 'notes.pdf', false, null],
    ]);
  });

  it('links media the browser cannot play', () => {
    const [view] = enclosureViews(
      [enclosure('https://cdn.example/a.flac', 'audio/flac')],
      options({ canPlay: (type) => type !== 'audio/flac' }),
    );
    expect(view?.player).toBe(false);
  });

  it('leaves out of the players and gallery what the content already shows', () => {
    const views = enclosureViews(
      [
        enclosure('https://img.example/photo.jpg', 'image/jpeg'),
        enclosure('https://cdn.example/a.mp3', 'audio/mpeg'),
      ],
      options({
        content: `<img src="/api/v1/images/sig/${b64('https://img.example/photo.jpg')}"><audio src="https://cdn.example/a.mp3"></audio>`,
      }),
    );
    expect(views.map((v) => [v.player, v.imageSrc])).toEqual([
      [false, null],
      [false, null],
    ]);
  });

  it('loads images from the device first, then through the proxy, on the server in the apps', () => {
    const proxied = enclosure('https://img.example/a.jpg', 'image/jpeg', '/api/v1/images/s/x');
    const stored = enclosure('https://img.example/b.jpg', 'image/jpeg', '/api/v1/images/s/y');
    const views = enclosureViews(
      [proxied, stored],
      options({
        server: 'https://reader.example',
        stored: new Map([['https://img.example/b.jpg', 'blob:b']]),
      }),
    );
    expect(views.map((v) => v.imageSrc)).toEqual([
      'https://reader.example/api/v1/images/s/x',
      'blob:b',
    ]);
  });

  it('without a connection, shows only stored images and plays nothing', () => {
    const views = enclosureViews(
      [
        enclosure('https://img.example/a.jpg', 'image/jpeg'),
        enclosure('https://img.example/b.jpg', 'image/jpeg'),
        enclosure('https://cdn.example/a.mp3', 'audio/mpeg'),
      ],
      options({ online: false, stored: new Map([['https://img.example/b.jpg', 'blob:b']]) }),
    );
    expect(views.map((v) => [v.player, v.imageSrc])).toEqual([
      [false, null],
      [false, 'blob:b'],
      [false, null],
    ]);
  });
});
