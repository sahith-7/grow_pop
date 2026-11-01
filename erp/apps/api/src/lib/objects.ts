import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../config.js';
import { appError } from './phase1.js';

/** Private object storage. Keys always start with the tenant id. The browser never talks to the bucket directly. */
export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;   // B7: expired data exports
}

class S3Store implements ObjectStore {
  private s3 = new S3Client({
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT || undefined,
    forcePathStyle: Boolean(config.S3_ENDPOINT), // local S3 (SeaweedFS) / LocalStack
    credentials: config.S3_ACCESS_KEY_ID
      ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY ?? '' }
      : undefined,
  });
  constructor(private bucket: string) {}
  async put(key: string, body: Buffer, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: 'AES256' }));
  }
  async get(key: string) {
    const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await out.Body!.transformToByteArray());
  }
  async delete(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** Tests only. */
export class MemoryStore implements ObjectStore {
  data = new Map<string, Buffer>();
  async put(key: string, body: Buffer) { this.data.set(key, body); }
  async get(key: string) {
    const b = this.data.get(key);
    if (!b) throw new Error(`no object ${key}`);
    return b;
  }
  async delete(key: string) { this.data.delete(key); }
}

class MissingStore implements ObjectStore {
  private fail(): never { throw appError(503, 'STORAGE_NOT_CONFIGURED', 'File storage is not configured on this server'); }
  async put() { this.fail(); }
  async get(): Promise<Buffer> { this.fail(); }
  async delete() { this.fail(); }
}

export const objects: ObjectStore =
  config.NODE_ENV === 'test' ? new MemoryStore() : config.S3_BUCKET ? new S3Store(config.S3_BUCKET) : new MissingStore();
