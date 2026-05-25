/**
 * AuthModule — provider/exporter container for the auth surface.
 *
 * Source of truth: tasks.md §4 (Auth module); design §"AuthService" /
 * §"User and authentication".
 *
 * ## Scope
 *
 * Task 4.4 contributes session issuance and the cookie middleware.
 * Sibling tasks 4.5 (rate limiter) and 4.6 (guards) contribute their
 * own providers; we register all known additive providers here so a
 * single import (`AuthModule`) is enough for downstream feature modules
 * regardless of which 4.x tasks have landed.
 *
 *   - {@link SessionService} (4.4) — minting / lookup / sliding /
 *     revocation of `Session` rows. Re-exported so other modules can
 *     issue tokens for bot-originated flows.
 *   - {@link SessionCookieMiddleware} (4.4) — wired in
 *     `AppModule.configure()` against `'*'` so every request resolves
 *     `req.user` when a valid session is present, and no-ops otherwise.
 *   - {@link AuthAttemptService} (4.5) — sliding-window per-identity
 *     rate limiter backing R1.7.
 *   - {@link AuthGuard} / {@link AdminGuard} (4.6) — route guards.
 *     Registered as providers so `@UseGuards(AuthGuard)` works without
 *     each consuming module having to re-declare them.
 *   - {@link AuthService} (4.1, 4.2) — email/password signup + login.
 *     Composes `AuthAttemptService`, `SessionService`, and `AuditService`.
 *
 * `PrismaModule` is already declared `@Global()` in
 * `src/prisma/prisma.module.ts`, so callers obtain `PrismaService`
 * (and the transaction client) without explicit imports here. The
 * `ConfigModule` is global (set up in `AppModule`) so `ConfigService`
 * injection works without re-importing.
 *
 * Sibling tasks 4.1 (signup), 4.2 (login), 4.3 (Telegram/Google) will
 * append `AuthService` and the controller to this same module.
 */

import { Module } from '@nestjs/common';

import { AuditModule } from '../audit';

import { AdminGuard } from './admin.guard';
import { AuthAttemptService } from './auth-attempt.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { GoogleAuthService } from './google-auth.service';
import { SessionCookieMiddleware } from './session.middleware';
import { SessionService } from './session.service';
import { TelegramAuthService } from './telegram-auth.service';

@Module({
  // `AuditModule` is needed so the OAuth services can inject
  // `AuditService` and write authentication audit rows inside the same
  // transaction as the `User` / `ExternalIdentity` upsert (R20.4, R1.3).
  imports: [AuditModule],
  // `AuthController` (task 4.7) — HTTP surface for signup, login,
  // OAuth, logout, and `/me`. Listed alongside the providers below so
  // a single `AuthModule` import wires the entire auth feature.
  controllers: [AuthController],
  providers: [
    SessionService,
    SessionCookieMiddleware,
    AuthAttemptService,
    AuthGuard,
    AdminGuard,
    AuthService,
    TelegramAuthService,
    GoogleAuthService,
  ],
  exports: [
    SessionService,
    SessionCookieMiddleware,
    AuthAttemptService,
    AuthGuard,
    AdminGuard,
    AuthService,
    TelegramAuthService,
    GoogleAuthService,
  ],
})
export class AuthModule {}
