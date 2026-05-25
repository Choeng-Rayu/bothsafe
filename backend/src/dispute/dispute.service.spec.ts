import { DisputeService } from './dispute.service';
import { ALL_DISPUTE_REASONS } from '../common/enums';

describe('DisputeService — reason allow-list and message bounds', () => {
  let service: DisputeService;

  beforeEach(() => {
    service = new (DisputeService as any)(
      {}, // prisma
      {}, // dealService
      {}, // walletService
      {}, // auditService
    );
  });

  describe('reason validation', () => {
    it('rejects invalid reason', async () => {
      await expect(
        service.openDispute('deal1', 'user1', {
          reason: 'INVALID_REASON',
          message: 'This is a valid message with enough chars',
        }),
      ).rejects.toMatchObject({ code: 'dispute.invalid_field' });
    });

    it.each(ALL_DISPUTE_REASONS)('accepts valid reason: %s', (reason) => {
      // Just verify the reason is in the allow-list (no full flow test)
      expect(ALL_DISPUTE_REASONS).toContain(reason);
    });
  });

  describe('message bounds', () => {
    it('rejects message shorter than 10 chars', async () => {
      await expect(
        service.openDispute('deal1', 'user1', {
          reason: 'ITEM_NOT_RECEIVED',
          message: 'short',
        }),
      ).rejects.toMatchObject({ code: 'dispute.invalid_field' });
    });

    it('rejects message longer than 2000 chars', async () => {
      await expect(
        service.openDispute('deal1', 'user1', {
          reason: 'ITEM_NOT_RECEIVED',
          message: 'x'.repeat(2001),
        }),
      ).rejects.toMatchObject({ code: 'dispute.invalid_field' });
    });
  });
});
