import { Module } from '@nestjs/common';
import { InfrastructureModule } from '@wolfari/common';
import { DatabaseModule } from '@wolfari/database';
import { FundRepository } from './repositories/fund.repository';

@Module({
  imports: [InfrastructureModule.forApp('finance-service'), DatabaseModule.forService('finance')],
  providers: [FundRepository],
})
export class AppModule {}
