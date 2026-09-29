import 'reflect-metadata';
import { bootstrapApp } from '@wolfari/common';
import { AppModule } from './app.module';
import { GRPC_LOADER_OPTIONS, GRPC_PACKAGES, PROTO_PATHS } from '@wolfari/contracts/grpc';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

function secureEqual(first: string, second: string): boolean {
  const a = Buffer.from(first); const b = Buffer.from(second);
  return a.length === b.length && timingSafeEqual(a, b);
}

void bootstrapApp(AppModule, 'identity-service', async app => {
  if (process.env.NODE_ENV === 'production') throw new Error('Identity internal HTTP/gRPC requires TLS in production');
  const secret = process.env.GATEWAY_IDENTITY_SECRET;
  if (!secret || secret.length < 32) throw new Error('GATEWAY_IDENTITY_SECRET missing');
  app.use('/internal/identity', (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const provided = request.headers['x-service-secret'];
    if (typeof provided !== 'string' || !secureEqual(provided, secret)) {
      response.statusCode = 403;
      response.end();
      return;
    }
    next();
  });
  const port = Number(process.env.IDENTITY_GRPC_PORT ?? 3201);
  app.connectMicroservice<MicroserviceOptions>({ transport: Transport.GRPC, options: { url: `127.0.0.1:${port}`, package: GRPC_PACKAGES.identity, protoPath: PROTO_PATHS.identity, loader: GRPC_LOADER_OPTIONS } }, { inheritAppConfig: true });
  await app.startAllMicroservices();
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
