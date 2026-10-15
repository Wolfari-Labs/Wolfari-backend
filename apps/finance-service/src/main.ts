import 'reflect-metadata';
import { bootstrapApp } from '@wolfari/common';
import { AppModule } from './app.module';
import { GRPC_LOADER_OPTIONS, GRPC_PACKAGES, PROTO_PATHS } from '@wolfari/contracts/grpc';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { loopbackTarget } from './finance.errors';

void bootstrapApp(AppModule, 'finance-service', async (app) => {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Finance internal gRPC requires TLS in production');
  for (const key of ['GATEWAY_FINANCE_SECRET', 'FINANCE_TRIP_SECRET', 'TRIP_FINANCE_SECRET']) {
    if ((process.env[key]?.length ?? 0) < 32) throw new Error(`${key} missing`);
  }
  if (!loopbackTarget(process.env.TRIP_GRPC_TARGET ?? ''))
    throw new Error('Invalid TRIP_GRPC_TARGET');
  const port = Number(process.env.FINANCE_GRPC_PORT ?? 3204);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Invalid FINANCE_GRPC_PORT');
  app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.GRPC,
      options: {
        url: `127.0.0.1:${port}`,
        package: GRPC_PACKAGES.finance,
        protoPath: PROTO_PATHS.finance,
        loader: GRPC_LOADER_OPTIONS,
      },
    },
    { inheritAppConfig: true },
  );
  await app.startAllMicroservices();
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
