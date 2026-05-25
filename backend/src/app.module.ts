import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule, minutes } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AuditModule } from './audit';
import { AuthModule } from './auth/auth.module';
import { PinoLoggerModule } from './config/logger.config';
import { ConfirmationModule } from './confirmation';
import { DealModule } from './deal';
import { DisputeModule } from './dispute';
import { KhqrModule } from './khqr';
import { PaymentModule } from './payment';
import { SessionCookieMiddleware } from './auth/session.middleware';
import { ShippingModule } from './shipping';
import { GlobalExceptionFilter } from './common/global-exception.filter';
import configuration from './config/configuration';
import { envValidationSchema } from './config/env.validation';
import { IdempotencyMiddleware, IdempotencyModule } from './idempotency';
import { PrismaModule } from './prisma';
import { WalletModule } from './wallet';
import { BotModule } from './bot';
import { NotificationModule } from './notification';
import { StorageModule } from './storage';
import { WithdrawalModule } from './withdrawal';

/**
 * Named rate-limit buckets used across the API.
 *
 * Per `design.md` § "Rate limiting" and `requirements.md`:
 *
 *   default        — applied to every controller. Generous ceiling so normal
 *                    deal-room traffic is never blocked.
 *   auth_login     — login endpoints (R1.6, R1.7).
 *                    Decorate with: @Throttle({ auth_login: { limit: 5, ttl: 60_000 } })
 *                    Routes: POST /v1/auth/email/login
 *   auth_signup    — sign-up + external-identity login (R1.1, R1.4).
 *                    Decorate with: @Throttle({ auth_signup: { limit: 5, ttl: 60_000 } })
 *                    Routes: POST /v1/auth/email/signup, /v1/auth/telegram, /v1/auth/google
 *   invite_preview — public invite preview, IP-bucketed (R4.5, R4.6).
 *                    Decorate with: @Throttle({ invite_preview: { limit: 30, ttl: 60_000 } })
 *                    Routes: GET /v1/deals/:publicId/invite-preview
 *   upload         — pre-signed upload URL minting + multipart endpoints.
 *                    Lower than default to discourage abusing storage signing.
 *                    Decorate with: @Throttle({ upload: { limit: 20, ttl: 60_000 } })
 *                    Routes: POST /v1/storage/uploads/sign and any direct
 *                    multipart upload endpoints.
 *
 * Per-identity sliding window (5 fails / 15 min) for auth is enforced
 * separately by the `AuthService` against the `auth_attempt` table —
 * see task 4.5 — and is intentionally NOT a throttler bucket because it
 * keys on `identity_key`, not request IP.
 *
 * Storage backend: in-memory (default `ThrottlerStorageService`). MVP only —
 * fine for a single backend container. Swap to a Redis-backed
 * `ThrottlerStorage` if/when we horizontally scale the API.
 */
@Module({
  imports: [
    // Global configuration module with env validation
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: envValidationSchema,
      validationOptions: {
        abortEarly: false,
      },
    }),

    // Multi-bucket rate limiting. See header comment for per-bucket usage.
    ThrottlerModule.forRoot({
      throttlers: [
        {
          name: 'default',
          ttl: minutes(1),
          limit: 60,
        },
        {
          name: 'auth_login',
          ttl: minutes(1),
          limit: 5,
        },
        {
          name: 'auth_signup',
          ttl: minutes(1),
          limit: 5,
        },
        {
          name: 'invite_preview',
          ttl: minutes(1),
          limit: 30,
        },
        {
          name: 'upload',
          ttl: minutes(1),
          limit: 20,
        },
      ],
      // Skip throttling entirely while running unit / e2e tests so we don't
      // have to pepper every spec with stubs.
      skipIf: () => process.env.NODE_ENV === 'test',
    }),

    // Global Prisma client (shared across every feature module)
    PrismaModule,

    // Pino structured logger with sensitive field redaction (§15.7)
    PinoLoggerModule,

    // Append-only audit-log writer (R20.1–R20.4). Provides `AuditService`
    // for any feature module that performs deal status transitions, wallet
    // movements, or admin actions.
    AuditModule,

    // Deal Room state machine (tasks 5.x). Provides `DealService`, the
    // single transition engine that mutates `Deal_Status` (AGENTS.md →
    // "Backend Coding Rules"). Sibling tasks 5.3, 5.4, 5.5 append the
    // `computeTermsHash`, `computeMissingFields`, and
    // `computeAllowedActions` helpers to the same service.
    DealModule,

    // HTTP-level idempotency middleware (task 3.8). Wired in
    // `configure(consumer)` below against `'*'` so every request passes
    // through the no-op skip rules; only POST/PATCH/PUT requests carrying
    // an `Idempotency-Key` header for an authenticated user actually hit
    // the dedup table.
    IdempotencyModule,

    // Authentication module (tasks 4.x). Currently exposes
    // `AuthAttemptService` (the per-identity sliding-window rate limiter
    // backing R1.7); sibling 4.x tasks add `AuthService`, guards, and
    // the controller.
    AuthModule,

    // Wallet module (tasks 6.x). Provides `WalletService` for atomic
    // wallet payments (R9), KHQR settlement (R11.2), and auto-release
    // (R13.3) plus the `GET /v1/wallet/me` + ledger HTTP routes
    // (R14.1, R14.3).
    WalletModule,

    // KHQR module (task 7.x). Provides `KhqrGenerator` and `KhqrVerifier`.
    KhqrModule,

    // Payment module (task 7.x). KHQR payment flow + admin verify/reject.
    PaymentModule,

    // Shipping module (task 8.1). Seller shipping proof submission.
    ShippingModule,

    // Confirmation module (task 8.2). Buyer confirm-received + auto-release.
    ConfirmationModule,

    // Dispute module (task 8.3–8.5). Dispute open + admin resolution.
    DisputeModule,

    // Withdrawal module (task 9.x). Seller withdrawal + admin review.
    WithdrawalModule,

    // Notification module (task 10.x). Outbox pattern + adapters.
    NotificationModule,

    // Storage module (task 11.x). MinIO pre-signed uploads.
    StorageModule,

    // Telegram bot module (task 12.x). Conversation FSM + deal creation.
    BotModule,
  ],
  controllers: [AppController],
  providers: [
    // Global error envelope filter (task 3.6). Applied via APP_FILTER so
    // every controller, gateway, and microservice handler routes its
    // exceptions through the canonical `{ error: { code, message_key,
    // details? } }` shape. Registered before the throttler guard so
    // `ThrottlerException` is caught here and mapped to `rate.exceeded`.
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    // Apply ThrottlerGuard to every route by default. Endpoints opt into a
    // tighter named bucket via @Throttle({ <bucket>: { ... } }).
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule implements NestModule {
  /**
   * Apply HTTP-level middleware in the correct order:
   *
   *  1. {@link SessionCookieMiddleware} (task 4.4) — resolves
   *     `bothsafe_session` cookie / `Authorization: Bearer` header into
   *     `req.user`. Self-skips on missing/invalid credentials. Wired
   *     first so that downstream middleware and guards see the
   *     authenticated user.
   *  2. {@link IdempotencyMiddleware} (task 3.8) — keys on
   *     `(scope, key, user_id)`. It self-skips when no authenticated
   *     user is attached, so it MUST run after the session middleware
   *     to see `req.user`.
   *
   * Both middlewares self-skip when their preconditions don't hold, so
   * the global `'*'` registration is safe — there's no per-route opt-in
   * to maintain.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(SessionCookieMiddleware, IdempotencyMiddleware)
      .forRoutes('*');
  }
}
