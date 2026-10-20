// The Windows portable exe (electron-builder's `portable` target): its stub unpacks the app to a
// new temporary folder on each launch and sets PORTABLE_EXECUTABLE_DIR to the exe's own folder.
import { win32 } from 'node:path';

/** The folder beside the portable exe that holds its data; null for any other install. */
export function portableDataDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const dir = env.PORTABLE_EXECUTABLE_DIR;
  return platform === 'win32' && dir ? win32.join(dir, 'Newses Data') : null;
}
