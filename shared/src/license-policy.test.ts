import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkLicenses, licenseAllowed } from './third-party-licenses.ts';

describe('licence policy', () => {
  it('allows AGPL-compatible licences and expressions', () => {
    for (const expression of ['MIT', 'Apache-2.0', '(MIT OR CC0-1.0)', 'MIT AND ISC', 'OFL-1.1'])
      expect(licenseAllowed(expression), expression).toBe(true);
    for (const expression of [
      'GPL-2.0-only',
      'UNKNOWN',
      'MIT AND GPL-2.0-only',
      '(MIT OR GPL-2.0-only) AND WTFPL',
    ])
      expect(licenseAllowed(expression), expression).toBe(false);
    expect(licenseAllowed('GPL-2.0-only OR MIT')).toBe(true);
  });

  it('fails a build naming what it refused', () => {
    expect(() =>
      checkLicenses([
        { name: 'ok', version: '1.0.0', license: 'MIT' },
        { name: 'bad', version: '2.0.0', license: 'GPL-2.0-only' },
      ]),
    ).toThrow('bad@2.0.0 (GPL-2.0-only)');
  });

  // Desktop's packages are all devDependencies, as its main process is bundled; its build checks
  // what it bundles, as every build does.
  it("holds for the shipped packages' production dependencies", () => {
    const filters = ['server', 'web', 'mobile', 'shared'].flatMap((name) => [
      '--filter',
      `@newses/${name}`,
    ]);
    const result = spawnSync('pnpm', ['licenses', 'list', '--prod', '--json', ...filters], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
    expect(result.status, result.stderr).toBe(0);
    const byLicense = JSON.parse(result.stdout) as Record<
      string,
      { name: string; versions: string[] }[]
    >;
    const packages = Object.entries(byLicense).flatMap(([license, list]) =>
      list.map(({ name, versions }) => ({ name, version: versions.join(', '), license })),
    );
    expect(packages.length).toBeGreaterThan(0);
    expect(() => checkLicenses(packages)).not.toThrow();
  });
});
