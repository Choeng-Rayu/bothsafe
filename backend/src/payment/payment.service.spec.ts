import { PaymentService } from './payment.service';

describe('PaymentService — receipt validation', () => {
  let service: PaymentService;

  beforeEach(() => {
    // Minimal mock — we only test the validation logic
    service = new (PaymentService as any)(
      {}, // prisma
      {}, // dealService
      {}, // walletService
      {}, // khqrGenerator
      {}, // auditService
    );
  });

  describe('submitReceipt validation', () => {
    it('rejects empty receipt (no paid_amount and no attachment_key)', async () => {
      await expect(
        service.submitReceipt('deal123', 'buyer1', {}),
      ).rejects.toMatchObject({ code: 'payment.empty_receipt' });
    });

    it('rejects when both paid_amount and attachment_key are null', async () => {
      await expect(
        service.submitReceipt('deal123', 'buyer1', {
          paid_amount: null,
          attachment_key: null,
        }),
      ).rejects.toMatchObject({ code: 'payment.empty_receipt' });
    });
  });
});
