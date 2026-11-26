import 'reflect-metadata';
import { bootstrapApp } from '@wolfari/common';
import { AppModule } from './app.module';
import { GatewayRouter } from './gateway-router';

void bootstrapApp(AppModule, 'api-gateway', (app) => {
  const router = app.get(GatewayRouter);
  app.use(
    // /invitations also covers /invitations/local (local invitation test page).
    ['/api/v1', '/invitations'],
    (
      request: import('node:http').IncomingMessage,
      response: import('node:http').ServerResponse,
    ) => {
      void router.handle(request, response);
    },
  );
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
