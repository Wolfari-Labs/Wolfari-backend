import type { INestApplication, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { CorrelationMiddleware } from './correlation';
import { appPorts, type AppName } from './environment';
import { StructuredLogger } from './structured-logger';

export async function bootstrapApp(module: Type<unknown>, appName: AppName, configure?: (app: INestApplication) => Promise<void> | void): Promise<void> {
  const app = await NestFactory.create(module, {
    logger: new StructuredLogger(appName),
  });
  const middleware = new CorrelationMiddleware();
  app.use(middleware.use.bind(middleware));
  app.enableShutdownHooks();
  await configure?.(app);

  const port = app.get(ConfigService).getOrThrow<number>(appPorts[appName]);
  await app.listen(port, '127.0.0.1');
  process.on('message', (message) => {
    if (message === 'shutdown') void app.close().then(() => process.exit(0));
  });
}
