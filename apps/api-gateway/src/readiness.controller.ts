import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { currentCorrelationId } from '@wolfari/common';

export async function checkDependency(target: string | undefined): Promise<'up' | 'down'> {
  try {
    if (!target || !/^http:\/\/127\.0\.0\.1:\d+$/.test(target)) return 'down';
    const response = await fetch(`${target}/health/ready`, {
      signal: AbortSignal.timeout(2000),
    });
    await response.body?.cancel();
    return response.ok ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

@Controller('health')
export class GatewayReadinessController {
  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async ready() {
    const [identity, trip] = await Promise.all([
      checkDependency(process.env.IDENTITY_HTTP_URL),
      checkDependency(process.env.TRIP_HTTP_URL),
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

  @Get('dependencies')
  @Header('Cache-Control', 'no-store')
  async dependencies() {
    const names = ['identity', 'trip', 'finance', 'automation'] as const;
    const values = await Promise.all(
      names.map((name) => checkDependency(process.env[name.toUpperCase() + '_HTTP_URL'])),
    );
    const body = {
      status: values.every((value) => value === 'up') ? 'ok' : 'degraded',
      service: 'api-gateway',
      checks: Object.fromEntries(names.map((name, index) => [name, values[index]])),
      correlation_id: currentCorrelationId(),
    };
    if (body.status !== 'ok') throw new ServiceUnavailableException(body);
    return body;
  }
}
