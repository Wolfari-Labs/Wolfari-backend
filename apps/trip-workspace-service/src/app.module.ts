import { Module } from '@nestjs/common';
import { InfrastructureModule } from '@wolfari/common';
import { DatabaseModule } from '@wolfari/database';

@Module({ imports: [InfrastructureModule.forApp('trip-workspace-service'), DatabaseModule.forService('trip')] })
export class AppModule {}
