import { Module } from '@nestjs/common';
import { InfrastructureModule } from '@wolfari/common';
import { DatabaseModule } from '@wolfari/database';

@Module({ imports: [InfrastructureModule.forApp('finance-service'), DatabaseModule.forService('finance')] })
export class AppModule {}
