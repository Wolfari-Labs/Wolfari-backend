import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { currentCorrelationId } from '@wolfari/common';

@Controller('health')
export class GatewayReadinessController {
  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async ready() {
    let identity: 'up' | 'down' = 'down';
    try {
      const target = process.env.IDENTITY_HTTP_URL;
      if (!target) throw new Error('missing target');
      const response = await fetch(`${target}/health/ready`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) identity = 'up';
    } catch { /* Identity is unavailable. */ }
    const body = { status: identity === 'up' ? 'ok' : 'error', service: 'api-gateway', checks: { identity }, correlation_id: currentCorrelationId() };
    if (identity === 'down') throw new ServiceUnavailableException(body);
    return body;
  }
}
