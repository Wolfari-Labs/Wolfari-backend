import 'reflect-metadata';
import { bootstrapApp } from '@wolfari/common';
import { GRPC_LOADER_OPTIONS, GRPC_PACKAGES, PROTO_PATHS } from '@wolfari/contracts/grpc';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { AppModule } from './app.module';

void bootstrapApp(AppModule, 'travel-intelligence-service', async (app) => {
  if (process.env.NODE_ENV === 'production')
    throw Error('Travel internal gRPC requires TLS in production');
  const port = Number(process.env.TRAVEL_GRPC_PORT ?? 3203);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error('Invalid Travel gRPC port');
  app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.GRPC,
      options: {
        url: `127.0.0.1:${port}`,
        package: GRPC_PACKAGES.travel,
        protoPath: PROTO_PATHS.travel,
        loader: GRPC_LOADER_OPTIONS,
      },
    },
    { inheritAppConfig: true },
  );
  await app.startAllMicroservices();
}).catch(() => {
  process.stderr.write('Travel startup failed; check service configuration.\n');
  process.exitCode = 1;
});
