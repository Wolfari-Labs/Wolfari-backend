import { Controller, DynamicModule, Get, Header, Inject, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { resolve } from 'node:path';
import { validateAppEnvironment, type AppName } from './environment';

const APP_NAME = Symbol('APP_NAME');

@Controller('health')
class HealthController {
  constructor(@Inject(APP_NAME) private readonly appName: AppName) {}

  @Get('live')
  @Header('Cache-Control', 'no-store')
  live(): { status: 'ok'; service: AppName } {
    return { status: 'ok', service: this.appName };
  }
}

@Module({})
export class InfrastructureModule {
  static forApp(appName: AppName): DynamicModule {
    return {
      module: InfrastructureModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: resolve(__dirname, '../../../apps', appName, '.env'),
          validate: (values) => validateAppEnvironment(values, appName),
        }),
      ],
      controllers: [HealthController],
      providers: [{ provide: APP_NAME, useValue: appName }],
    };
  }
}

export type { AppName } from './environment';
