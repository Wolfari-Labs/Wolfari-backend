import { Module } from '@nestjs/common';
import { InfrastructureModule } from '@wolfari/common';
import { GatewayReadinessController } from './readiness.controller';

@Module({ imports: [InfrastructureModule.forApp('api-gateway')], controllers: [GatewayReadinessController] })
export class AppModule {}
