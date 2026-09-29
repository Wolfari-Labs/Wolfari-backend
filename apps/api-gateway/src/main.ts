import 'reflect-metadata';
import { bootstrapApp } from '@wolfari/common';
import { AppModule } from './app.module';
import { IdentityProxy } from './identity-proxy';

void bootstrapApp(AppModule, 'api-gateway', app => {
  const proxy = new IdentityProxy();
  app.use('/api/v1', (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => {
    void proxy.handle(request, response);
  });
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
