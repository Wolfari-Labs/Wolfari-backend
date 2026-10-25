import { Controller, Get, Header } from '@nestjs/common';
import { FinanceOutboxService } from './finance-outbox.service';
@Controller('health')
export class FinanceDependenciesController {
  constructor(private readonly outbox: FinanceOutboxService) {}
  @Get('dependencies')
  @Header('Cache-Control', 'no-store')
  dependencies() {
    return this.outbox.diagnostics();
  }
}
