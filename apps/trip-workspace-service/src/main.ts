import 'reflect-metadata';
import { bootstrapApp } from '@wolfari/common';
import { GRPC_LOADER_OPTIONS, GRPC_PACKAGES, PROTO_PATHS } from '@wolfari/contracts/grpc';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { AppModule } from './app.module';

void bootstrapApp(AppModule, 'trip-workspace-service', async (app) => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Trip internal gRPC requires TLS in production');
  }
  for (const key of [
    'GATEWAY_TRIP_SECRET',
    'FINANCE_TRIP_SECRET',
    'TRAVEL_TRIP_SECRET',
    'AUTOMATION_TRIP_SECRET',
  ]) {
    if (!process.env[key] || process.env[key]!.length < 32) throw new Error(`${key} missing`);
  }
  const port = Number(process.env.TRIP_GRPC_PORT ?? 3202);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('TRIP_GRPC_PORT must be between 1024 and 65535');
  }
  app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.GRPC,
      options: {
        url: `127.0.0.1:${port}`,
        package: GRPC_PACKAGES.trip,
        protoPath: PROTO_PATHS.trip,
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
