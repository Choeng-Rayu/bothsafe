import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';

const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const PRESIGN_TTL_SEC = 900; // 15 min

export type UploadKind = 'payment_receipt' | 'shipping' | 'dispute' | 'withdrawal_khqr';

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface SignUploadInput {
  kind: UploadKind;
  mime: string;
  size: number;
}

export interface SignUploadResult {
  object_key: string;
  put_url: string;
  expires_at: string;
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly bucket: string;
  private readonly endpoint: string;
  private readonly port: number;
  private readonly useSsl: boolean;

  constructor(private readonly config: ConfigService) {
    this.bucket = this.config.get<string>('MINIO_BUCKET', 'bothsafe');
    this.endpoint = this.config.get<string>('MINIO_ENDPOINT', 'localhost');
    this.port = this.config.get<number>('MINIO_PORT', 59000);
    this.useSsl = this.config.get<string>('MINIO_USE_SSL', 'false') === 'true';
  }

  validateMime(mime: string): boolean {
    return (ALLOWED_MIMES as readonly string[]).includes(mime);
  }

  validateSize(size: number): boolean {
    return size > 0 && size <= MAX_SIZE_BYTES;
  }

  async signUpload(userId: string, input: SignUploadInput): Promise<SignUploadResult> {
    const ext = MIME_TO_EXT[input.mime] ?? 'bin';
    const timestamp = Date.now();
    const randomId = randomBytes(8).toString('hex');
    const objectKey = `${input.kind}/${userId}/${timestamp}-${randomId}.${ext}`;

    // Stub pre-signed URL (no real S3 client available)
    const protocol = this.useSsl ? 'https' : 'http';
    const putUrl = `${protocol}://${this.endpoint}:${this.port}/${this.bucket}/${objectKey}?X-Amz-Expires=${PRESIGN_TTL_SEC}`;

    const expiresAt = new Date(Date.now() + PRESIGN_TTL_SEC * 1000).toISOString();

    this.logger.debug(`Signed upload: ${objectKey}`);

    return { object_key: objectKey, put_url: putUrl, expires_at: expiresAt };
  }

  async validateUpload(_objectKey: string): Promise<boolean> {
    // Stub: in production would HEAD the object and verify MIME + size
    return true;
  }
}
