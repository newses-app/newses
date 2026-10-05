import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { describeBlobStore } from '../test/blob-store-contract.ts';
import { LocalBlobStore } from './local-blob-store.ts';

let root: string;
let store: LocalBlobStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'blobs-'));
  store = new LocalBlobStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describeBlobStore('LocalBlobStore', () => store);
