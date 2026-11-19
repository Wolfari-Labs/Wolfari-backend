import 'reflect-metadata';
import { bootstrapApp, productionTransportBlocked } from '@wolfari/common';
import { GRPC_LOADER_OPTIONS, GRPC_PACKAGES, PROTO_PATHS } from '@wolfari/contracts/grpc';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { AppModule } from './app.module';

void bootstrapApp(AppModule, 'travel-intelligence-service', async (app) => {
  // Keep an unconfigured existing installation available; discovery returns unavailable.
  if (!process.env.GATEWAY_TRAVEL_SECRET) return;
  if (productionTransportBlocked() || process.env.GATEWAY_TRAVEL_SECRET.length < 32)
    throw new Error('Travel transport configuration invalid');
  const port = Number(process.env.TRAVEL_GRPC_PORT ?? 3203);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('TRAVEL_GRPC_PORT invalid');
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
