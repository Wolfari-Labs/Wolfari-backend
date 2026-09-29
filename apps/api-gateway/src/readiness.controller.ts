import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { currentCorrelationId } from '@wolfari/common';

@Controller('health')
export class GatewayReadinessController {
  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async ready() {
    const check = async (target: string | undefined): Promise<'up' | 'down'> => {
      try {
        if (!target || !/^http:\/\/127\.0\.0\.1:\d+$/.test(target)) return 'down';
        const response = await fetch(`${target}/health/ready`, {
          signal: AbortSignal.timeout(2000),
        });
        return response.ok ? 'up' : 'down';
      } catch {
        return 'down';
      }
    };
    const [identity, trip] = await Promise.all([
      check(process.env.IDENTITY_HTTP_URL),
      check(process.env.TRIP_HTTP_URL),
    ]);
    const body = {
      status: identity === 'up' && trip === 'up' ? 'ok' : 'error',
      service: 'api-gateway',
      checks: { identity, trip },
      correlation_id: currentCorrelationId(),
    };
    if (body.status === 'error') throw new ServiceUnavailableException(body);
    return body;
  }
}
