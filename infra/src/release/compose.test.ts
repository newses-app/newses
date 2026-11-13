import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The Compose files releases publish, as Compose reads them; skipped where it is not installed.
const docker = fileURLToPath(new URL('../../../docker/', import.meta.url));
const available = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

function config(files: string[], env: Record<string, string>) {
  const result = spawnSync(
    'docker',
    // No .env from the checkout.
    [
      'compose',
      '--env-file',
      '/dev/null',
      ...files.flatMap((f) => ['-f', f]),
      'config',
      '--format',
      'json',
    ],
    {
      cwd: docker,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        APP_SECRET: 'x'.repeat(32),
        POSTGRES_USER: 'u',
        POSTGRES_PASSWORD: 'p',
        POSTGRES_DB: 'd',
        ...env,
      },
    },
  );
  expect(result.stderr).not.toMatch(/error|warn/i);
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as {
    services: Record<
      string,
      {
        environment?: Record<string, string>;
        ports?: { published: string }[];
        networks?: Record<string, unknown>;
        volumes?: { source: string; target: string; read_only?: boolean }[];
        secrets?: { source: string }[];
        platform?: string;
      }
    >;
  };
}

describe.skipIf(!available)('docker/compose.yaml', () => {
  it('leaves ntfy out, and the server without a distributor, unless its profile is on', () => {
    const { services } = config(['compose.yaml'], {});
    expect(services.ntfy).toBeUndefined();
    expect(services.server?.environment).toMatchObject({
      PUSH_DISTRIBUTOR_URL: '',
      PUSH_TRUSTED_HOSTS: '',
      PUSH_TOKENS: '',
    });
  });

  it('runs ntfy locked down at NTFY_HOST with the profile, and points the server at it', () => {
    const { services } = config(['compose.yaml'], {
      COMPOSE_PROFILES: 'ntfy',
      NTFY_HOST: 'ntfy.example.com',
    });
    expect(services.ntfy?.environment).toMatchObject({
      NTFY_BASE_URL: 'https://ntfy.example.com',
      NTFY_AUTH_DEFAULT_ACCESS: 'deny-all',
      NTFY_AUTH_ACCESS: '*:up*:wo',
      NTFY_WEB_ROOT: 'disable',
    });
    expect(services.ntfy?.ports?.map((p) => p.published)).toEqual(['8081']);
    expect(services.worker?.environment).toMatchObject({
      PUSH_DISTRIBUTOR_URL: 'https://ntfy.example.com',
      PUSH_TRUSTED_HOSTS: 'ntfy.example.com',
    });
  });

  it('lets only users publish when NTFY_AUTH_ACCESS denies anyone, the server with its token', () => {
    const { services } = config(['compose.yaml'], {
      COMPOSE_PROFILES: 'ntfy',
      NTFY_HOST: 'ntfy.example.com',
      NTFY_AUTH_ACCESS: '*:up*:deny',
      PUSH_TOKENS: 'ntfy.example.com=tk_abc',
    });
    expect(services.ntfy?.environment).toMatchObject({
      NTFY_AUTH_DEFAULT_ACCESS: 'deny-all',
      NTFY_AUTH_ACCESS: '*:up*:deny',
    });
    for (const app of [services.server, services.worker])
      expect(app?.environment).toMatchObject({ PUSH_TOKENS: 'ntfy.example.com=tk_abc' });
  });

  it('routes NTFY_HOST through nginx-proxy, unpublished', () => {
    const { services } = config(['compose.yaml', 'compose.nginx-proxy.yaml'], {
      COMPOSE_PROFILES: 'ntfy',
      NTFY_HOST: 'ntfy.example.com',
      VIRTUAL_HOST: 'reader.example.com',
      LETSENCRYPT_HOST: 'reader.example.com',
    });
    expect(services.ntfy?.environment).toMatchObject({
      VIRTUAL_HOST: 'ntfy.example.com',
      VIRTUAL_PORT: '80',
      LETSENCRYPT_HOST: 'ntfy.example.com',
    });
    expect(services.ntfy?.ports ?? []).toEqual([]);
    expect(Object.keys(services.ntfy?.networks ?? {}).sort()).toEqual(['default', 'proxy']);

    const without = config(['compose.yaml', 'compose.nginx-proxy.yaml'], {
      VIRTUAL_HOST: 'reader.example.com',
    });
    expect(without.services.ntfy).toBeUndefined();
  });

  it('serves the downloads volume read-only, which only the apps override builds into', () => {
    const { services } = config(['compose.yaml'], {});
    expect(services.server?.environment).toMatchObject({ DOWNLOADS_DIR: '/data/downloads' });
    expect(services.server?.volumes).toContainEqual(
      expect.objectContaining({ source: 'downloads', target: '/data/downloads', read_only: true }),
    );
    expect(services.worker?.environment?.DOWNLOADS_DIR).toBeUndefined();
    expect(services.apps).toBeUndefined();

    const apps = config(['compose.yaml', 'compose.apps.yaml'], {
      COMPOSE_PROFILES: 'apps',
      RELEASE_TAG: 'v1.2.3',
      PUBLIC_URL: 'https://reader.example.com',
      ANDROID_KEYSTORE_BASE64: '',
      ANDROID_KEYSTORE_PASSWORD: '',
      ANDROID_KEY_ALIAS: '',
      ANDROID_KEY_PASSWORD: '',
    }).services.apps;
    expect(apps?.platform).toBe('linux/amd64');
    expect(apps?.environment).toMatchObject({
      RELEASE_TAG: 'v1.2.3',
      PUBLIC_URL: 'https://reader.example.com',
      APPS_PLATFORMS: 'linux,android',
    });
    expect(apps?.environment).not.toHaveProperty('ANDROID_KEYSTORE_PASSWORD');
    expect(apps?.secrets?.map((secret) => secret.source)).toHaveLength(4);
    expect(apps?.volumes).toContainEqual(
      expect.objectContaining({ source: 'downloads', target: '/data/downloads' }),
    );
  });
});
