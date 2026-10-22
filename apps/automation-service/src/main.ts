import 'reflect-metadata';
import { bootstrapApp } from '@wolfari/common';
import { GRPC_LOADER_OPTIONS, GRPC_PACKAGES, PROTO_PATHS } from '@wolfari/contracts/grpc';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { AppModule } from './app.module';

void bootstrapApp(AppModule, 'automation-service', async (app) => {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Automation internal gRPC requires TLS in production');
  if (!process.env.GATEWAY_AUTOMATION_SECRET || process.env.GATEWAY_AUTOMATION_SECRET.length < 32)
    throw new Error('GATEWAY_AUTOMATION_SECRET missing');
  if (!process.env.AUTOMATION_CURSOR_SECRET || process.env.AUTOMATION_CURSOR_SECRET.length < 32)
    throw new Error('AUTOMATION_CURSOR_SECRET missing');
  const port = Number(process.env.AUTOMATION_GRPC_PORT ?? 3205);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('AUTOMATION_GRPC_PORT must be between 1024 and 65535');
  app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.GRPC,
      options: {
        url: `127.0.0.1:${port}`,
        package: GRPC_PACKAGES.automation,
        protoPath: PROTO_PATHS.automation,
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
