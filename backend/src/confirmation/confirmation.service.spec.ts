import { ConfirmationService } from './confirmation.service';
import { DealStatus, ParticipantRole } from '../common/enums';

describe('ConfirmationService — idempotency property', () => {
  it('returns already_confirmed=true on duplicate without re-releasing', async () => {
    const mockDeal = {
      id: 'deal-1',
      public_id: 'pub-1',
      status: DealStatus.SHIPPED,
      deal_amount: { toString: () => '100.00' },
      currency: 'USD',
    };

    let transitionCount = 0;
    const mockTx = {
      dealRoom: {
        findUnique: jest.fn().mockResolvedValue(mockDeal),
      },
      dealParticipant: {
        findUnique: jest.fn().mockResolvedValue({ role: ParticipantRole.buyer }),
      },
      confirmation: {
        findUnique: jest.fn().mockResolvedValue({ id: 'existing-conf' }),
        create: jest.fn(),
      },
      notificationOutboxEntry: { create: jest.fn() },
    };

    const mockPrisma = {
      runInTransaction: jest.fn((fn: any) => fn(mockTx)),
      dealRoom: { findUnique: jest.fn().mockResolvedValue(mockDeal) },
    };

    const mockDealService = {
      transition: jest.fn(() => {
        transitionCount++;
        return mockDeal;
      }),
    };

    const mockWalletService = {
      autoReleaseToSeller: jest.fn(),
    };

    const service = new (ConfirmationService as any)(
      mockPrisma,
      mockDealService,
      mockWalletService,
    );

    const result = await service.confirmReceived('pub-1', 'buyer-1', 'key-1');

    expect(result.already_confirmed).toBe(true);
    expect(mockTx.confirmation.create).not.toHaveBeenCalled();
    expect(transitionCount).toBe(0);
    expect(mockWalletService.autoReleaseToSeller).not.toHaveBeenCalled();
  });
});
