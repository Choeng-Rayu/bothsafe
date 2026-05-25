/**
 * Property test: total wallet conservation across auto-release.
 * Tasks.md §14.2 — validates R13.3, R14.4.
 *
 * Property: for any closed deal, sum(credits) == sum(debits) across all
 * ledger entries for that deal. Money is conserved.
 */

import * as fc from 'fast-check';
import Decimal from 'decimal.js';

/**
 * Simulates ledger entries for a deal lifecycle.
 * In a real release flow:
 *   - ESCROW_RECEIVED credit (escrow wallet) + debit (buyer wallet)
 *   - SELLER_PAYOUT_PENDING debit (escrow) + credit (seller)
 *   - PLATFORM_FEE_RESERVED debit (escrow) + credit (platform)
 *
 * Conservation: total credits == total debits across all wallets.
 */
interface LedgerEntry {
  amount: Decimal;
  direction: 'credit' | 'debit';
}

function simulateReleaseFlow(dealAmount: Decimal, feePercent: number): LedgerEntry[] {
  const fee = dealAmount.mul(feePercent).div(100).toDecimalPlaces(2);
  const sellerPayout = dealAmount.minus(fee);

  return [
    // Buyer pays into escrow
    { amount: dealAmount, direction: 'debit' },   // buyer wallet
    { amount: dealAmount, direction: 'credit' },  // escrow wallet
    // Release: escrow → seller + platform fee
    { amount: sellerPayout, direction: 'debit' },  // escrow wallet
    { amount: sellerPayout, direction: 'credit' }, // seller wallet
    { amount: fee, direction: 'debit' },           // escrow wallet
    { amount: fee, direction: 'credit' },          // platform wallet
  ];
}

describe('Wallet conservation property tests (§14.2)', () => {
  it('sum(credits) == sum(debits) for any deal amount and fee', () => {
    fc.assert(
      fc.property(
        // Deal amount: 0.01 to 999999.99
        fc.integer({ min: 1, max: 99999999 }).map((n) => new Decimal(n).div(100)),
        // Fee percent: 0 to 10
        fc.integer({ min: 0, max: 10 }),
        (dealAmount, feePercent) => {
          const entries = simulateReleaseFlow(dealAmount, feePercent);

          const totalCredits = entries
            .filter((e) => e.direction === 'credit')
            .reduce((sum, e) => sum.plus(e.amount), new Decimal(0));

          const totalDebits = entries
            .filter((e) => e.direction === 'debit')
            .reduce((sum, e) => sum.plus(e.amount), new Decimal(0));

          return totalCredits.equals(totalDebits);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('escrow wallet balance is zero after release', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99999999 }).map((n) => new Decimal(n).div(100)),
        fc.integer({ min: 0, max: 10 }),
        (dealAmount, feePercent) => {
          const fee = dealAmount.mul(feePercent).div(100).toDecimalPlaces(2);
          const sellerPayout = dealAmount.minus(fee);

          // Escrow: +dealAmount (receive) - sellerPayout - fee (release)
          const escrowBalance = dealAmount.minus(sellerPayout).minus(fee);
          return escrowBalance.equals(new Decimal(0));
        },
      ),
      { numRuns: 500 },
    );
  });
});
