import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll } from 'vitest';
import { describeBlobStore } from '../test/blob-store-contract.ts';
import { S3BlobStore } from './s3-blob-store.ts';

let container: StartedTestContainer;
let store: S3BlobStore;

beforeAll(async () => {
  // Not from Docker Hub, whose anonymous pull limit shared CI hosts exhaust.
  container = await new GenericContainer('ghcr.io/versity/versitygw:v1.8.0')
    .withCommand(['--access', 'test', '--secret', 'test-secret', 'posix', '/tmp'])
    .withExposedPorts(7070)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  const client = new S3Client({
    endpoint: `http://${container.getHost()}:${String(container.getMappedPort(7070))}`,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test-secret' },
  });
  await client.send(new CreateBucketCommand({ Bucket: 'blobs' }));
  store = new S3BlobStore('blobs', client);
}, 120_000);

afterAll(async () => {
  await container.stop();
});

describeBlobStore('S3BlobStore', () => store);
