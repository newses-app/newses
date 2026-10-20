import { describe, expect, it } from 'vitest';
import { portableDataDir } from './portable.ts';

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
