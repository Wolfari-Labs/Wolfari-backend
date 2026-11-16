import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIETQR_BANKS } from '@wolfari/common';
import {
  authenticate,
  ensureQuery,
  fail,
  json,
  RequestError,
  type SessionValidator,
} from './trip-http';

export const BANK_DIRECTORY_PATH = '/api/v1/finance/banks';

/** Banks that accept NAPAS VietQR account transfers; clients pick from this list, never free text. */
export function bankDirectory() {
  return VIETQR_BANKS.filter((bank) => bank.transfer_supported).map(
    ({ code, bin, name, short_name }) => ({ code, bin, name, short_name }),
  );
}

export async function handleBankDirectory(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  validateSession: SessionValidator,
) {
  if (request.method !== 'GET') return fail(response, 404, 'RESOURCE_NOT_FOUND');
  const auth = await authenticate(request, response, validateSession, false);
  if (!auth) return;
  try {
    ensureQuery(url, []);
  } catch (error) {
    if (error instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
    throw error;
  }
  return json(response, 200, {
    data: { items: bankDirectory() },
    meta: { correlation_id: auth.correlationId },
  });
}
