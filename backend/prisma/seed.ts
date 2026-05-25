// BothSafe — Prisma seed script
//
// Source of truth:
//   • .kiro/specs/bothsafe-deal-flow/tasks.md, task 2.11
//   • .kiro/specs/bothsafe-deal-flow/design.md, §"Wallet and ledger"
//     ("A single canonical platform-owned escrow wallet per currency.
//      It is a Wallet row owned by a designated 'platform' User with
//      is_admin=true. We additionally mark it via WalletRole below for
//      clarity.")
//
// What this script provisions (idempotently — safe to re-run):
//   1. One platform User
//        email          = 'platform@bothsafe.local'
//        display_name   = 'BothSafe Platform'
//        is_admin       = true
//        password_hash  = null  (this user is not credential-login-able;
//                                admins log in via ADMIN_BOOTSTRAP_*)
//        preferred_lang = 'en'
//   2. One Wallet per supported Currency (USD, KHR), owned by the
//      platform User. The composite UNIQUE (user_id, currency) keeps
//      the upsert safe.
//   3. One WalletRole row per escrow Wallet with role='escrow', so the
//      Wallet service can identify the canonical escrow wallets per
//      currency without hard-coding wallet IDs.
//
// Run via: `npx prisma db seed` (wired through `migrations.seed` in
// `prisma.config.ts` — Prisma 7 moved this off `package.json`).

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Currency } from '@prisma/client';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

const prisma = new PrismaClient({ adapter });

const PLATFORM_EMAIL = 'platform@bothsafe.local';
const PLATFORM_DISPLAY_NAME = 'BothSafe Platform';
const ESCROW_ROLE = 'escrow';

async function main(): Promise<void> {
  // 1. Platform user — upsert by unique email.
  const platform = await prisma.user.upsert({
    where: { email: PLATFORM_EMAIL },
    create: {
      email: PLATFORM_EMAIL,
      display_name: PLATFORM_DISPLAY_NAME,
      is_admin: true,
      // password_hash intentionally omitted: the platform user is not
      // a credential-login-able account. Admin login uses
      // ADMIN_BOOTSTRAP_EMAIL / ADMIN_BOOTSTRAP_PASSWORD.
      password_hash: null,
      preferred_lang: 'en',
    },
    update: {
      display_name: PLATFORM_DISPLAY_NAME,
      is_admin: true,
      preferred_lang: 'en',
    },
  });

  // 2 + 3. Escrow wallet per currency + WalletRole='escrow'.
  const currencies: Currency[] = [Currency.USD, Currency.KHR];

  for (const currency of currencies) {
    // Upsert the wallet on the (user_id, currency) UNIQUE so re-running
    // the seed never creates a duplicate.
    const wallet = await prisma.wallet.upsert({
      where: {
        user_id_currency: {
          user_id: platform.id,
          currency,
        },
      },
      create: {
        user_id: platform.id,
        currency,
      },
      update: {},
    });

    // wallet_role.wallet_id is both PK and FK, so a single upsert
    // by `wallet_id` is enough.
    await prisma.walletRole.upsert({
      where: { wallet_id: wallet.id },
      create: {
        wallet_id: wallet.id,
        role: ESCROW_ROLE,
      },
      update: {
        role: ESCROW_ROLE,
      },
    });
  }

  // Report what was provisioned (handy when seeding by hand in dev).
  const count = await prisma.walletRole.count({
    where: { role: ESCROW_ROLE },
  });
  // eslint-disable-next-line no-console
  console.log(
    `[seed] platform user: ${platform.email} (${platform.id}); escrow wallets: ${count}`,
  );
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[seed] failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
