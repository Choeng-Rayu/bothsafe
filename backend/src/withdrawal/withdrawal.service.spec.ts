import { WithdrawalService } from './withdrawal.service';

describe('WithdrawalService — validation', () => {
  let service: WithdrawalService;

  beforeEach(() => {
    service = new (WithdrawalService as any)(
      {}, // prisma
      {}, // walletService
      {}, // auditService
    );
  });

  describe('KHQR destination validation', () => {
    it('rejects khqr destination without khqr_string or khqr_image_key', async () => {
      await expect(
        service.create('seller1', {
          amount: '100.00',
          currency: 'USD',
          destination_type: 'khqr',
        }),
      ).rejects.toMatchObject({ code: 'withdrawal.invalid_field' });
    });

    it('rejects khqr_string shorter than 10 chars', async () => {
      await expect(
        service.create('seller1', {
          amount: '100.00',
          currency: 'USD',
          destination_type: 'khqr',
          khqr_string: 'short',
        }),
      ).rejects.toMatchObject({ code: 'withdrawal.invalid_field' });
    });

    it('rejects khqr_string longer than 512 chars', async () => {
      await expect(
        service.create('seller1', {
          amount: '100.00',
          currency: 'USD',
          destination_type: 'khqr',
          khqr_string: 'x'.repeat(513),
        }),
      ).rejects.toMatchObject({ code: 'withdrawal.invalid_field' });
    });
  });

  describe('bank destination validation', () => {
    it('rejects bank destination without required fields', async () => {
      await expect(
        service.create('seller1', {
          amount: '100.00',
          currency: 'USD',
          destination_type: 'bank',
        }),
      ).rejects.toMatchObject({ code: 'withdrawal.invalid_field' });
    });

    it('rejects non-alphanumeric bank_account_number', async () => {
      await expect(
        service.create('seller1', {
          amount: '100.00',
          currency: 'USD',
          destination_type: 'bank',
          bank_name: 'ABA Bank',
          bank_account_name: 'John Doe',
          bank_account_number: '123-456-789',
        }),
      ).rejects.toMatchObject({ code: 'withdrawal.invalid_field' });
    });

    it('rejects bank_account_number shorter than 5 chars', async () => {
      await expect(
        service.create('seller1', {
          amount: '100.00',
          currency: 'USD',
          destination_type: 'bank',
          bank_name: 'ABA Bank',
          bank_account_name: 'John Doe',
          bank_account_number: '1234',
        }),
      ).rejects.toMatchObject({ code: 'withdrawal.invalid_field' });
    });
  });

  describe('amount validation', () => {
    it('rejects amount below 0.01', async () => {
      await expect(
        service.create('seller1', {
          amount: '0.001',
          currency: 'USD',
          destination_type: 'khqr',
          khqr_string: '0123456789ABCDEF',
        }),
      ).rejects.toMatchObject({ code: 'withdrawal.invalid_field' });
    });

    it('rejects invalid currency', async () => {
      await expect(
        service.create('seller1', {
          amount: '100.00',
          currency: 'EUR',
          destination_type: 'khqr',
          khqr_string: '0123456789ABCDEF',
        }),
      ).rejects.toMatchObject({ code: 'withdrawal.invalid_field' });
    });

    it('rejects invalid destination_type', async () => {
      await expect(
        service.create('seller1', {
          amount: '100.00',
          currency: 'USD',
          destination_type: 'binance',
        }),
      ).rejects.toMatchObject({ code: 'withdrawal.invalid_field' });
    });
  });

  describe('available-balance invariant', () => {
    it('rejects withdrawal when balance is insufficient', async () => {
      const { Decimal } = require('decimal.js');
      const mockWalletService = {
        getOrCreate: jest.fn().mockResolvedValue({ id: 'w1', currency: 'USD' }),
        getAvailableBalance: jest.fn().mockResolvedValue(new Decimal('10.00')),
      };
      const mockPrisma = {
        runInTransaction: jest.fn((fn: any) => fn({})),
      };
      const svc = new (WithdrawalService as any)(
        mockPrisma,
        mockWalletService,
        {},
      );

      await expect(
        svc.create('seller1', {
          amount: '100.00',
          currency: 'USD',
          destination_type: 'khqr',
          khqr_string: '0123456789ABCDEF',
        }),
      ).rejects.toMatchObject({ code: 'wallet.insufficient_balance' });
    });
  });
});
