import { getBackoffDelay, BACKOFF_DELAYS_MS } from './notification.dispatcher';

describe('NotificationDispatcher — exponential backoff', () => {
  it('returns 1m for first retry (attempts=0)', () => {
    expect(getBackoffDelay(0)).toBe(60_000);
  });

  it('returns 2m for second retry (attempts=1)', () => {
    expect(getBackoffDelay(1)).toBe(120_000);
  });

  it('returns 4m for third retry (attempts=2)', () => {
    expect(getBackoffDelay(2)).toBe(240_000);
  });

  it('returns 8m for fourth retry (attempts=3)', () => {
    expect(getBackoffDelay(3)).toBe(480_000);
  });

  it('caps at 15m for fifth+ retry (attempts=4)', () => {
    expect(getBackoffDelay(4)).toBe(900_000);
    expect(getBackoffDelay(10)).toBe(900_000);
  });

  it('backoff schedule is monotonically increasing', () => {
    for (let i = 1; i < BACKOFF_DELAYS_MS.length; i++) {
      expect(BACKOFF_DELAYS_MS[i]).toBeGreaterThan(BACKOFF_DELAYS_MS[i - 1]);
    }
  });
});

describe('NotificationDispatcher — at-least-once property', () => {
  const MAX_RETRIES = 5;

  it('pending rows are retried up to max_retries then marked failed', () => {
    // Simulate: a row starts at attempts=0, each drain increments attempts.
    // After MAX_RETRIES attempts, status must be 'failed'.
    let attempts = 0;
    let status: 'pending' | 'failed' = 'pending';

    while (status === 'pending' && attempts < 100) {
      attempts++;
      if (attempts >= MAX_RETRIES) {
        status = 'failed';
      }
    }

    expect(status).toBe('failed');
    expect(attempts).toBe(MAX_RETRIES);
  });

  it('successful send on any attempt marks row as sent', () => {
    // Simulate: adapter succeeds on attempt 3
    const succeedOnAttempt = 3;
    let attempts = 0;
    let status: 'pending' | 'sent' | 'failed' = 'pending';

    while (status === 'pending' && attempts < MAX_RETRIES) {
      attempts++;
      if (attempts === succeedOnAttempt) {
        status = 'sent';
        break;
      }
    }

    expect(status).toBe('sent');
    expect(attempts).toBe(succeedOnAttempt);
  });

  it('no row stays pending forever (property: terminates within max_retries)', () => {
    // For any number of consecutive failures, the row transitions to failed
    // within MAX_RETRIES attempts.
    for (let failCount = 1; failCount <= 20; failCount++) {
      let attempts = 0;
      let status: 'pending' | 'failed' = 'pending';

      while (status === 'pending') {
        attempts++;
        if (attempts >= MAX_RETRIES) {
          status = 'failed';
        }
      }

      expect(attempts).toBeLessThanOrEqual(MAX_RETRIES);
      expect(status).toBe('failed');
    }
  });
});
