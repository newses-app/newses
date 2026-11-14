import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { portableDataDir, usableDataDir } from './portable.ts';

describe('portableDataDir', () => {
  it("keeps the portable exe's data in a folder beside it", () => {
    expect(portableDataDir({ PORTABLE_EXECUTABLE_DIR: 'E:\\Apps' }, 'win32')).toBe(
      'E:\\Apps\\Newses Data',
    );
  });

  it('is null for other installs', () => {
    expect(portableDataDir({}, 'win32')).toBeNull();
    expect(portableDataDir({ PORTABLE_EXECUTABLE_DIR: '' }, 'win32')).toBeNull();
    expect(portableDataDir({ PORTABLE_EXECUTABLE_DIR: '/opt/newses' }, 'linux')).toBeNull();
  });
});

describe('usableDataDir', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'newses-portable-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates the folder, leaving nothing behind from checking it', () => {
    const dir = join(root, 'Newses Data');
    expect(usableDataDir(dir)).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('is false where the folder cannot be made or written', () => {
    const file = join(root, 'not-a-folder');
    writeFileSync(file, '');
    expect(usableDataDir(join(file, 'Newses Data'))).toBe(false);
  });
});
