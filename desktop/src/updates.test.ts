import { describe, expect, it } from 'vitest';
import { parseUpdateConfig, type UpdateConfig, updateMode } from './updates.ts';

describe('parseUpdateConfig', () => {
  it('reads the generic feed electron-builder writes', () => {
    expect(
      parseUpdateConfig(
        "provider: generic\nurl: https://reader-dev.example.com/downloads\nupdaterCacheDirName: '@newsesdesktop-updater'\n",
      ),
    ).toEqual({ url: 'https://reader-dev.example.com/downloads', publisherName: null });
  });

  it('reads the Windows publisher, inline or as a list', () => {
    const feed = 'provider: generic\nurl: https://reader.example.com/downloads/\n';
    expect(parseUpdateConfig(`${feed}publisherName:\n  - Example Publisher\n`)).toEqual({
      url: 'https://reader.example.com/downloads',
      publisherName: 'Example Publisher',
    });
    expect(parseUpdateConfig(`${feed}publisherName: 'Example Publisher'\n`)?.publisherName).toBe(
      'Example Publisher',
    );
  });

  it('ignores other providers and insecure feeds', () => {
    expect(parseUpdateConfig('provider: github\nurl: https://example.com\n')).toBeNull();
    expect(parseUpdateConfig('provider: generic\nurl: http://example.com\n')).toBeNull();
    expect(parseUpdateConfig('')).toBeNull();
  });
});

describe('updateMode', () => {
  const signed: UpdateConfig = { url: 'https://reader.example.com/downloads', publisherName: 'Me' };

  it('updates AppImages and signed NSIS installs in place', () => {
    expect(
      updateMode({
        platform: 'linux',
        appImage: '/home/me/newses.AppImage',
        hasUninstaller: false,
        portable: false,
        config: signed,
      }),
    ).toBe('auto');
    expect(
      updateMode({
        platform: 'win32',
        appImage: undefined,
        hasUninstaller: true,
        portable: false,
        config: signed,
      }),
    ).toBe('auto');
  });

  it('links a deb, a Windows zip, and an unsigned Windows build to the download', () => {
    expect(
      updateMode({
        platform: 'linux',
        appImage: undefined,
        hasUninstaller: false,
        portable: false,
        config: signed,
      }),
    ).toBe('manual');
    expect(
      updateMode({
        platform: 'win32',
        appImage: undefined,
        hasUninstaller: false,
        portable: false,
        config: signed,
      }),
    ).toBe('manual');
    expect(
      updateMode({
        platform: 'win32',
        appImage: undefined,
        hasUninstaller: true,
        portable: false,
        config: { ...signed, publisherName: null },
      }),
    ).toBe('manual');
  });

  it('links the Windows portable exe to the download', () => {
    expect(
      updateMode({
        platform: 'win32',
        appImage: undefined,
        hasUninstaller: false,
        portable: true,
        config: signed,
      }),
    ).toBe('manual');
  });
});
