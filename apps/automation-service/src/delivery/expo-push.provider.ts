export type PushResult = {
  reference?: string;
  pending?: boolean;
  error?: string;
  permanent?: boolean;
  invalidToken?: boolean;
};
export const expoToken = (value: string) =>
  /^(?:ExpoPushToken|ExponentPushToken)\[[A-Za-z0-9_-]{1,200}\]$/.test(value);
const permanentErrors = new Set([
  'DeviceNotRegistered',
  'MessageTooBig',
  'MismatchSenderId',
  'InvalidCredentials',
  'UNAUTHORIZED',
  'INVALID_PAYLOAD',
]);
function providerResult(raw: unknown, ticket: boolean): PushResult {
  const value = raw as
    { status?: unknown; id?: unknown; details?: { error?: unknown } } | undefined;
  if (value?.status === 'ok') {
    if (!ticket) return {};
    if (typeof value.id === 'string' && /^[\w-]{1,180}$/.test(value.id))
      return { reference: value.id };
  }
  if (value?.status === 'error' && typeof value.details?.error === 'string') {
    const error = value.details.error;
    return {
      error:
        permanentErrors.has(error) || ['MessageRateExceeded', 'ProviderError'].includes(error)
          ? error
          : 'PROVIDER_ERROR',
      permanent: permanentErrors.has(error),
      invalidToken: error === 'DeviceNotRegistered',
    };
  }
  return { error: 'INVALID_PROVIDER_RESPONSE' };
}
async function requestExpo(
  endpoint: 'send' | 'getReceipts',
  body: unknown,
  accessToken: string,
  request: typeof fetch,
) {
  const response = await request(`https://exp.host/--/api/v2/push/${endpoint}`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return {
      error:
        response.status === 401 || response.status === 403
          ? 'UNAUTHORIZED'
          : response.status >= 400 && response.status < 500 && response.status !== 429
            ? 'INVALID_PAYLOAD'
            : 'PROVIDER_UNAVAILABLE',
      permanent: response.status >= 400 && response.status < 500 && response.status !== 429,
    };
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error('Empty push response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        throw Error('Push response too large');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return { payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) as { data?: unknown } };
}
export async function sendExpoPush(
  token: string,
  data: Record<string, string>,
  accessToken: string,
  request: typeof fetch = fetch,
): Promise<PushResult> {
  if (!expoToken(token))
    return { error: 'DeviceNotRegistered', permanent: true, invalidToken: true };
  const response = await requestExpo(
    'send',
    {
      to: token,
      title: 'Wolfari',
      body: 'Bạn có thông báo mới. Mở ứng dụng để xem.',
      sound: 'default',
      channelId: 'default',
      ttl: 900,
      data,
    },
    accessToken,
    request,
  );
  if ('error' in response) return response;
  const value = response.payload.data;
  return providerResult(Array.isArray(value) ? value[0] : value, true);
}
export async function getExpoReceipt(
  reference: string,
  accessToken: string,
  request: typeof fetch = fetch,
): Promise<PushResult> {
  const response = await requestExpo('getReceipts', { ids: [reference] }, accessToken, request);
  if ('error' in response) return response;
  const value = (response.payload.data as Record<string, unknown> | undefined)?.[reference];
  return value ? providerResult(value, false) : { pending: true };
}
