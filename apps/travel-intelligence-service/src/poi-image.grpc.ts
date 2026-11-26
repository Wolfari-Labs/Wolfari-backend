import { Controller } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status, type Metadata } from '@grpc/grpc-js';
import { DatabaseProvider } from '@wolfari/database';
import type { TravelV1 } from '@wolfari/contracts/grpc';
import { assertGatewayCaller } from './gateway-caller';
import { POI_IMAGE_BUCKET, POI_IMAGE_WIDTHS, SHA256, getObject, servablePhoto } from './poi-media';

/** Stored WebP variants are small (≤ ~400 KB at 1280 px); anything bigger is not ours. */
const MAX_BYTES = 2 * 1024 * 1024;

@Controller()
export class PoiImageController {
  constructor(
    private readonly database: DatabaseProvider,
    private readonly config: ConfigService,
  ) {}

  @GrpcMethod('TravelService', 'GetPoiImage')
  async getPoiImage(request: TravelV1.GetPoiImageRequest, metadata: Metadata): Promise<TravelV1.GetPoiImageResponse> {
    assertGatewayCaller(this.config, metadata);
    const sha256 = String(request.sha256 ?? '');
    const width = Number(request.width ?? 0);
    if (!SHA256.test(sha256) || !POI_IMAGE_WIDTHS.includes(width as (typeof POI_IMAGE_WIDTHS)[number]))
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'VALIDATION_FAILED' });
    let bytes: Buffer | null;
    try {
      // Taken-down or inactive photos are not served, even though the object still exists.
      if (!(await servablePhoto(this.database, sha256))) bytes = null;
      else
        bytes = await getObject(
          {
            endpoint: this.config.get<string>('MINIO_ENDPOINT') ?? '',
            accessKey: this.config.get<string>('MINIO_ACCESS_KEY') ?? '',
            secretKey: this.config.get<string>('MINIO_SECRET_KEY') ?? '',
          },
          POI_IMAGE_BUCKET,
          `poi/${sha256}/${width}.webp`,
          { signal: AbortSignal.timeout(4000) },
        );
    } catch {
      throw new RpcException({ code: status.UNAVAILABLE, message: 'SERVICE_UNAVAILABLE' });
    }
    if (!bytes) throw new RpcException({ code: status.NOT_FOUND, message: 'RESOURCE_NOT_FOUND' });
    if (bytes.length > MAX_BYTES || bytes.subarray(8, 12).toString('ascii') !== 'WEBP')
      throw new RpcException({ code: status.UNAVAILABLE, message: 'SERVICE_UNAVAILABLE' });
    return { content: bytes, mime_type: 'image/webp', size_bytes: bytes.length };
  }
}
