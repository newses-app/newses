import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll } from 'vitest';
import { describeBlobStore } from '../test/blob-store-contract.ts';
import { S3BlobStore } from './s3-blob-store.ts';

let container: StartedTestContainer;
let store: S3BlobStore;

beforeAll(async () => {
  container = await new GenericContainer('adobe/s3mock:5.2')
    .withExposedPorts(9090)
    .withWaitStrategy(Wait.forHttp('/', 9090))
    .start();
  const client = new S3Client({
    endpoint: `http://${container.getHost()}:${String(container.getMappedPort(9090))}`,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  await client.send(new CreateBucketCommand({ Bucket: 'blobs' }));
  store = new S3BlobStore('blobs', client);
}, 120_000);

afterAll(async () => {
  await container.stop();
});

describeBlobStore('S3BlobStore', () => store);
