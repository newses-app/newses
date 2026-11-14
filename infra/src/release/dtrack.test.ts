import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bomUploadRequest,
  dtrackApi,
  type DtrackApi,
  PROCESSING_LIMIT_MS,
  releaseKind,
  sbomsToUpload,
  uploadBom,
  uploadTarget,
} from './dtrack.ts';

describe('releaseKind', () => {
  it('tells releases, prereleases, and untagged builds apart', () => {
    expect(releaseKind('v1.2.3')).toBe('prod');
    expect(releaseKind('v1.2.3-rc.1')).toBe('dev');
    expect(releaseKind(undefined)).toBe('local');
  });
});

describe('uploadTarget', () => {
  it("makes a tagged build the release's latest version", () => {
    expect(uploadTarget('desktop', { tag: 'v1.2.3-rc.1' })).toEqual({
      projectName: 'newses-desktop',
      projectVersion: '1.2.3-rc.1',
      tags: ['newses', 'dev'],
      isLatest: true,
    });
  });

  it('files an untagged build under its branch, not as the latest', () => {
    expect(uploadTarget('server', { branch: 'dev' })).toEqual({
      projectName: 'newses-server',
      projectVersion: 'dev',
      tags: ['newses', 'local'],
      isLatest: false,
    });
  });

  it('needs a tag or a branch', () => {
    expect(() => uploadTarget('web', {})).toThrow(/tag or a branch/);
  });
});

describe('bomUploadRequest', () => {
  it('sends the SBOM base64-encoded and creates the project', () => {
    const body = bomUploadRequest(
      uploadTarget('image', { tag: 'v1.2.3' }),
      '{"bomFormat":"CycloneDX"}',
    );
    expect(body).toEqual({
      projectName: 'newses-image',
      projectVersion: '1.2.3',
      projectTags: [{ name: 'newses' }, { name: 'prod' }],
      autoCreate: true,
      isLatestProjectVersion: true,
      bom: Buffer.from('{"bomFormat":"CycloneDX"}').toString('base64'),
    });
  });
});

describe('sbomsToUpload', () => {
  it("takes the version's SBOMs and leaves other files", () => {
    const names = ['newses-1.2.3-desktop.cdx.json', 'newses-1.2.3-image.cdx.json', 'notes.txt'];
    expect(sbomsToUpload('sbom', names, 'v1.2.3')).toEqual([
      { name: 'newses-1.2.3-desktop.cdx.json', version: '1.2.3', deliverable: 'desktop' },
      { name: 'newses-1.2.3-image.cdx.json', version: '1.2.3', deliverable: 'image' },
    ]);
    expect(sbomsToUpload('sbom', ['newses-0.0.0-dev-web.cdx.json'], undefined)).toHaveLength(1);
  });

  it("refuses a folder without SBOMs, or with another build's", () => {
    expect(() => sbomsToUpload('sbom', ['notes.txt'], 'v1.2.3')).toThrow('No SBOMs in sbom');
    expect(() =>
      sbomsToUpload(
        'sbom',
        ['newses-1.2.3-web.cdx.json', 'newses-1.2.2-server.cdx.json'],
        'v1.2.3',
      ),
    ).toThrow('Not 1.2.3: newses-1.2.2-server.cdx.json');
  });
});

describe('dtrackApi', () => {
  it('sends the key and JSON, and reads the JSON answer', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(Response.json({ token: 't' })),
    );
    const api = dtrackApi('https://dtrack.example/', 'key', fetch);
    await expect(api('PUT', '/api/v1/bom', { a: 1 })).resolves.toEqual({ token: 't' });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://dtrack.example/api/v1/bom');
    expect(init).toMatchObject({
      method: 'PUT',
      headers: { 'X-Api-Key': 'key', 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
  });

  it('answers nothing for an empty body, and throws on an error status', async () => {
    const answers = [new Response(null, { status: 204 }), new Response('No key', { status: 401 })];
    const api = dtrackApi('https://dtrack.example', 'key', () =>
      Promise.resolve(answers.shift() ?? new Response()),
    );
    await expect(api('GET', '/api/v1/event/token/t')).resolves.toBeUndefined();
    await expect(api('GET', '/api/v1/event/token/t')).rejects.toThrow(
      'GET /api/v1/event/token/t: 401 No key',
    );
  });
});

describe('uploadBom', () => {
  const target = uploadTarget('web', { tag: 'v1.2.3' });

  /** An API that takes the upload, then answers each status poll in turn. */
  function api(...statuses: { processing: boolean; status?: string }[]) {
    const calls: string[] = [];
    const call: DtrackApi = (method, path) => {
      calls.push(`${method} ${path}`);
      return Promise.resolve(method === 'PUT' ? { token: 't1' } : statuses.shift());
    };
    return { call, calls };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uploads, then waits until it is processed', async () => {
    const { call, calls } = api({ processing: true }, { processing: true }, { processing: false });
    const wait = vi.fn(() => Promise.resolve());
    await uploadBom(call, 'newses-1.2.3-web.cdx.json', target, '{}', wait);
    expect(calls).toEqual([
      'PUT /api/v1/bom',
      'GET /api/v1/event/token/t1',
      'GET /api/v1/event/token/t1',
      'GET /api/v1/event/token/t1',
    ]);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('fails when processing fails or runs past five minutes', async () => {
    const failed = api({ processing: false, status: 'FAILED' });
    await expect(uploadBom(failed.call, 'web.cdx.json', target, '{}')).rejects.toThrow(
      'web.cdx.json: processing failed',
    );

    vi.useFakeTimers();
    const slow: DtrackApi = (method) =>
      Promise.resolve(method === 'PUT' ? { token: 't' } : { processing: true });
    const wait = (ms: number) => {
      vi.advanceTimersByTime(ms);
      return Promise.resolve();
    };
    await expect(uploadBom(slow, 'web.cdx.json', target, '{}', wait)).rejects.toThrow(
      'still processing after 5 minutes',
    );
    expect(PROCESSING_LIMIT_MS).toBe(300_000);
  });
});
