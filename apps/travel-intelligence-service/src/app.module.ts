import { Module } from '@nestjs/common';
import { InfrastructureModule } from '@wolfari/common';
import { DatabaseModule } from '@wolfari/database';

@Module({ imports: [InfrastructureModule.forApp('travel-intelligence-service'), DatabaseModule.forService('travel')] })
export class AppModule {}
