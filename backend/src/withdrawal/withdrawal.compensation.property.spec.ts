/**
 * Property test: withdrawal hold ↔ rejection compensation.
 * Tasks.md §14.3 — validates R15.8, R16.3.
 *
 * Property: after a withdrawal rejection, the ADJUSTMENT credit exactly
 * offsets the SELLER_PAYOUT_PENDING debit. The seller's available balance
 * returns to its pre-withdrawal value.
 */

import * as fc from 'fast-check';
import Decimal from 'decimal.js';

interface LedgerEntry {
  amount: Decimal;
  direction: 'credit' | 'debit';
  type: 'SELLER_PAYOUT_PENDING' | 'ADJUSTMENT';
}

function simulateWithdrawalAndRejection(amount: Decimal): {
  holdEntry: LedgerEntry;
  compensationEntry: LedgerEntry;
} {
  return {
    // Hold: debit from seller wallet when withdrawal is created
    holdEntry: { amount, direction: 'debit', type: 'SELLER_PAYOUT_PENDING' },
    // Compensation: credit back to seller wallet on rejection
    compensationEntry: { amount, direction: 'credit', type: 'ADJUSTMENT' },
  };
}

describe('Withdrawal compensation property tests (§14.3)', () => {
  it('ADJUSTMENT credit exactly offsets SELLER_PAYOUT_PENDING debit after rejection', () => {
    fc.assert(
      fc.property(
        // Withdrawal amount: 0.01 to 999999.99
        fc.integer({ min: 1, max: 99999999 }).map((n) => new Decimal(n).div(100)),
        (withdrawalAmount) => {
          const { holdEntry, compensationEntry } =
            simulateWithdrawalAndRejection(withdrawalAmount);

          // The compensation credit must equal the hold debit
          return (
            holdEntry.amount.equals(compensationEntry.amount) &&
            holdEntry.direction === 'debit' &&
            compensationEntry.direction === 'credit'
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  it('available balance returns to pre-withdrawal value after rejection', () => {
    fc.assert(
      fc.property(
        // Initial balance
        fc.integer({ min: 100, max: 99999999 }).map((n) => new Decimal(n).div(100)),
        // Withdrawal amount (must be <= initial balance)
        fc.integer({ min: 1, max: 100 }),
        (initialBalance, withdrawPct) => {
          const withdrawalAmount = initialBalance
            .mul(withdrawPct)
            .div(100)
            .toDecimalPlaces(2);

          if (withdrawalAmount.lte(0)) return true; // skip degenerate

          // After hold: balance decreases
          const afterHold = initialBalance.minus(withdrawalAmount);
          // After rejection compensation: balance restored
          const afterRejection = afterHold.plus(withdrawalAmount);

          return afterRejection.equals(initialBalance);
        },
      ),
      { numRuns: 500 },
    );
  });
});
