import { describe, expect, it } from 'vitest';
import { enclosureKind } from './enclosures.ts';

const kind = (url: string, mimeType: string | null = null) => enclosureKind({ url, mimeType });

describe('enclosureKind', () => {
  it('goes by the MIME type', () => {
    expect(kind('https://cdn.example/e1', 'audio/mpeg')).toBe('audio');
    expect(kind('https://cdn.example/e1', 'Video/MP4; codecs="avc1"')).toBe('video');
    expect(kind('https://cdn.example/e1.mp3', 'image/jpeg')).toBe('image');
    expect(kind('https://cdn.example/e1.mp3', 'application/pdf')).toBe('other');
    expect(kind('https://cdn.example/v.swf', 'application/x-shockwave-flash')).toBe('other');
  });

  it('leaves streaming playlists as links', () => {
    expect(kind('https://cdn.example/live.m3u8', 'application/vnd.apple.mpegurl')).toBe('other');
    expect(kind('https://cdn.example/live.m3u8', 'audio/mpegurl')).toBe('other');
    expect(kind('https://cdn.example/live.mpd', 'application/dash+xml')).toBe('other');
  });

  it('goes by the file extension without a type, or with a generic one', () => {
    expect(kind('https://cdn.example/show/42.MP3?token=x')).toBe('audio');
    expect(kind('https://cdn.example/clip.webm', 'application/octet-stream')).toBe('video');
    expect(kind('https://cdn.example/photo.jpeg#large', '')).toBe('image');
    expect(kind('https://cdn.example/notes.pdf')).toBe('other');
    expect(kind('https://cdn.example/download')).toBe('other');
    expect(kind('not a url')).toBe('other');
  });
});
