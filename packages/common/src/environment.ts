import { validateDeploymentEnvironment } from './deployment';

export const appPorts = {
  'api-gateway': 'GATEWAY_PORT',
  'identity-service': 'IDENTITY_PORT',
  'trip-workspace-service': 'TRIP_PORT',
  'travel-intelligence-service': 'TRAVEL_PORT',
  'finance-service': 'FINANCE_PORT',
  'automation-service': 'AUTOMATION_PORT',
  'export-worker': 'EXPORT_WORKER_PORT',
} as const;

export type AppName = keyof typeof appPorts;

const defaultPorts: Record<AppName, number> = {
  'api-gateway': 3000,
  'identity-service': 3101,
  'trip-workspace-service': 3102,
  'travel-intelligence-service': 3103,
  'finance-service': 3104,
  'automation-service': 3105,
  'export-worker': 3106,
};

export function validateAppEnvironment(
  values: Record<string, unknown>,
  appName: AppName,
): Record<string, unknown> {
  const portKey = appPorts[appName];
  const rawPort = values[portKey] ?? String(defaultPorts[appName]);
  if (typeof rawPort !== 'string' || !/^\d+$/.test(rawPort)) {
    throw new Error(`${portKey} must be an integer TCP port`);
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${portKey} must be between 1024 and 65535`);
  }

  const nodeEnv = values.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(String(nodeEnv))) {
    throw new Error('NODE_ENV must be development, test, or production');
  }

  validateDeploymentEnvironment({ ...values, NODE_ENV: nodeEnv }, appName);
  return { ...values, NODE_ENV: nodeEnv, [portKey]: port };
}
