import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Blob, BlobStore } from '../core/ports.ts';
import { assertBlobKey } from './blob-key.ts';

/** BlobStore on a local directory. Content types live in a parallel `.meta` tree. */
export class LocalBlobStore implements BlobStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async put(key: string, blob: Blob): Promise<void> {
    const { dataPath, metaPath } = this.#paths(key);
    await writeAtomically(dataPath, blob.data);
    await writeAtomically(metaPath, JSON.stringify({ contentType: blob.contentType }));
  }

  async get(key: string): Promise<Blob | null> {
    const { dataPath, metaPath } = this.#paths(key);
    try {
      const [data, meta] = await Promise.all([readFile(dataPath), readFile(metaPath, 'utf8')]);
      const { contentType } = JSON.parse(meta) as { contentType: string };
      return { data: new Uint8Array(data), contentType };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const { dataPath, metaPath } = this.#paths(key);
    await Promise.all([rm(dataPath, { force: true }), rm(metaPath, { force: true })]);
  }

  #paths(key: string) {
    assertBlobKey(key);
    return { dataPath: join(this.#root, key), metaPath: join(this.#root, '.meta', `${key}.json`) };
  }
}

async function writeAtomically(path: string, data: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;
  await writeFile(temp, data);
  await rename(temp, path);
}
