import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { PaymentService } from './payment.service';
import type { PaymentRepository } from '../repositories/payment.repository';
import type { FundQueryService } from './fund-query.service';
import type { FundCommandService } from './fund-command.service';
import type { PaymentProcessor } from './payment-processor';
import type { MomoSandboxProvider } from '../providers/momo-sandbox.provider';

const webhook = {
  partner_code: 'MOMO_TEST',
  order_id: 'wqr-' + 'a'.repeat(40),
  request_id: 'test-request',
  amount: '150000',
  order_info: 'Wolfari QR Sandbox: Dinner',
  order_type: 'momo_wallet',
  transaction_id: '123',
  result_code: 0,
  message: 'Successful',
  pay_type: 'qr',
  response_time: '1794988672000',
  extra_data: '',
  signature: 'a'.repeat(64),
};
describe('QR sandbox callback isolation', () => {
  it('verifies sandbox callbacks without writing ledger, receipts, payment exceptions or kicking the fund processor', async () => {
    const receive = vi.fn(),
      kick = vi.fn(),
      verify = vi.fn().mockReturnValue(true);
    const service = new PaymentService(
      { receiveWebhook: receive } as unknown as PaymentRepository,
      {} as FundQueryService,
      {} as FundCommandService,
      {
        ready: () => true,
        partnerCode: () => 'MOMO_TEST',
        verifyIpn: verify,
      } as unknown as MomoSandboxProvider,
      { kick } as unknown as PaymentProcessor,
    );
    await expect(service.webhook(webhook)).resolves.toEqual({});
    expect(verify).toHaveBeenCalled();
    expect(receive).not.toHaveBeenCalled();
    expect(kick).not.toHaveBeenCalled();
    verify.mockReturnValue(false);
    await expect(service.webhook(webhook)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(service.webhook({ ...webhook, partner_code: 'OTHER' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(receive).not.toHaveBeenCalled();
  });
});
