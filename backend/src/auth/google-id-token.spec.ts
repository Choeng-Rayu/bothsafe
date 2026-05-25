/**
 * Unit tests for `verifyGoogleIdToken` (task 4.3).
 *
 * Acceptance criteria covered: R1.1, R1.3.
 *
 * Strategy:
 *   - We avoid bringing up a real Google certificate fetch by stubbing
 *     `OAuth2Client.prototype.verifyIdToken` per test. The verifier's
 *     contract with `google-auth-library` is small (call `verifyIdToken`,
 *     read `getPayload()`), so spying on that method is enough to cover
 *     the success / failure / wrong-audience / malformed-payload paths.
 *   - We keep `verifyIdToken`'s `audience` argument explicit on every
 *     call so a regression that drops it is caught.
 */

import { OAuth2Client } from 'google-auth-library';

import { verifyGoogleIdToken } from './google-id-token';

const AUDIENCE = '987654321-test-client-id.apps.googleusercontent.com';
const ID_TOKEN = 'header.payload.signature';

/**
 * `OAuth2Client.verifyIdToken` returns a `LoginTicket` whose full type
 * surface is unhelpful here (the library re-exports it from a deeply
 * nested namespace). Tests only need `getPayload()`, so we spy and
 * mockImplementation through `as unknown as` to dodge the structural
 * mismatch — the runtime is exactly what the verifier expects.
 */
function mockVerifyIdToken(
  impl: (args: { idToken: string; audience: string }) => Promise<{
    getPayload: () => Record<string, unknown> | undefined;
  }>,
): jest.SpyInstance {
  return jest
    .spyOn(OAuth2Client.prototype, 'verifyIdToken')
    .mockImplementation(impl as unknown as OAuth2Client['verifyIdToken']);
}

describe('verifyGoogleIdToken', () => {
  let verifySpy: jest.SpyInstance | undefined;

  afterEach(() => {
    verifySpy?.mockRestore();
    verifySpy = undefined;
  });

  it('returns parsed claims when google-auth-library accepts the token', async () => {
    verifySpy = mockVerifyIdToken(async () => ({
      getPayload: () => ({
        iss: 'https://accounts.google.com',
        aud: AUDIENCE,
        sub: '1234567890',
        email: 'alice@example.com',
        email_verified: true,
        name: 'Alice Example',
        picture: 'https://example.invalid/alice.png',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
      }),
    }));

    const claims = await verifyGoogleIdToken(ID_TOKEN, AUDIENCE);

    expect(claims).toEqual({
      sub: '1234567890',
      email: 'alice@example.com',
      email_verified: true,
      name: 'Alice Example',
      picture: 'https://example.invalid/alice.png',
    });
    expect(verifySpy).toHaveBeenCalledWith({
      idToken: ID_TOKEN,
      audience: AUDIENCE,
    });
  });

  it('returns null when google-auth-library rejects the audience', async () => {
    // `OAuth2Client.verifyIdToken` throws on audience mismatch; mirror
    // that behaviour with a rejected promise.
    verifySpy = mockVerifyIdToken(async () => {
      throw new Error('Wrong recipient, payload audience != requiredAudience');
    });

    const claims = await verifyGoogleIdToken(
      ID_TOKEN,
      'wrong-audience.apps.googleusercontent.com',
    );
    expect(claims).toBeNull();
  });

  it('returns null when the verified payload has no `sub` claim', async () => {
    verifySpy = mockVerifyIdToken(async () => ({
      getPayload: () => ({
        iss: 'https://accounts.google.com',
        aud: AUDIENCE,
        email: 'alice@example.com',
        // sub deliberately missing
      }),
    }));

    const claims = await verifyGoogleIdToken(ID_TOKEN, AUDIENCE);
    expect(claims).toBeNull();
  });

  it('returns null when the verified payload is undefined', async () => {
    verifySpy = mockVerifyIdToken(async () => ({
      getPayload: () => undefined,
    }));

    const claims = await verifyGoogleIdToken(ID_TOKEN, AUDIENCE);
    expect(claims).toBeNull();
  });

  it('returns null without calling the library on empty inputs', async () => {
    verifySpy = jest.spyOn(OAuth2Client.prototype, 'verifyIdToken');

    expect(await verifyGoogleIdToken('', AUDIENCE)).toBeNull();
    expect(await verifyGoogleIdToken(ID_TOKEN, '')).toBeNull();
    expect(verifySpy).not.toHaveBeenCalled();
  });
});
