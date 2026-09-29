import { Module } from '@nestjs/common';
import { InfrastructureModule } from '@wolfari/common';
import { GatewayReadinessController } from './readiness.controller';
import { GatewayRouter } from './gateway-router';

@Module({
  imports: [InfrastructureModule.forApp('api-gateway')],
  controllers: [GatewayReadinessController],
  providers: [GatewayRouter],
})
export class AppModule {}
