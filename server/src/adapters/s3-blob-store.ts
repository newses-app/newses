import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Blob, BlobStore } from '../core/ports.ts';
import { assertBlobKey } from './blob-key.ts';

/** BlobStore on an S3 bucket; keys are object keys and content types object metadata. */
export class S3BlobStore implements BlobStore {
  readonly #bucket: string;
  readonly #client: S3Client;

  constructor(bucket: string, client = new S3Client({})) {
    this.#bucket = bucket;
    this.#client = client;
  }

  async put(key: string, blob: Blob): Promise<void> {
    assertBlobKey(key);
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: blob.data,
        ContentType: blob.contentType,
      }),
    );
  }

  async get(key: string): Promise<Blob | null> {
    assertBlobKey(key);
    try {
      const object = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      if (!object.Body) return null;
      return {
        data: await object.Body.transformToByteArray(),
        contentType: object.ContentType ?? 'application/octet-stream',
      };
    } catch (err) {
      if (err instanceof NoSuchKey) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    assertBlobKey(key);
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }
}
