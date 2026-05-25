/**
 * AuthController — HTTP surface for the auth module (task 4.7).
 *
 * Source of truth: tasks.md §4.7; design §"AuthService"; AGENTS.md →
 * "Token Strategy" + "Backend Coding Rules". Acceptance criteria: R1.1,
 * R1.2, R1.3, R1.5, R1.6, R1.7, R1.8.
 *
 * All routes hang off `/auth` and inherit the global `/v1` prefix
 * configured in `main.ts` (`app.enableVersioning({ type: URI, prefix:
 * 'v', defaultVersion: '1' })`).
 *
 * ## Routes
 *
 *   - `POST /v1/auth/email/signup`  — create a new email-backed user.
 *   - `POST /v1/auth/email/login`   — authenticate an existing user.
 *   - `POST /v1/auth/telegram`      — sign in via verified initData blob.
 *   - `POST /v1/auth/google`        — sign in via verified Google id_token.
 *   - `POST /v1/auth/logout`        — revoke the current session.
 *   - `GET  /v1/auth/me`            — return the current user envelope.
 *
 * Each authenticating route returns the canonical envelope:
 *
 * ```json
 * {
 *   "user": {
 *     "id": "...",
 *     "email": "...",
 *     "display_name": "...",
 *     "preferred_lang": "en",
 *     "is_admin": false
 *   },
 *   "expires_at": "2026-..."
 * }
 * ```
 *
 * ## Throttling
 *
 *   - `email/login`  → `auth_login` (5 req/min/IP).
 *   - `email/signup`, `telegram`, `google` → `auth_signup` (5 req/min/IP).
 *
 * The IP bucket is the first line of defence; the per-identity sliding
 * window from `AuthAttemptService` (task 4.5) closes the credential-
 * stuffing gap and is enforced inside the service path. Logout / me are
 * guarded by `AuthGuard` and ride the default throttler bucket.
 *
 * ## Cookie hygiene
 *
 * Every authenticating route writes the issued raw session token via
 * `setSessionCookie(res, raw, { maxAgeMs })` so the cookie's `Max-Age`
 * matches `Session.expires_at`. We pass `passthrough: true` on `@Res()`
 * so Nest still serialises the JSON return value — without it, manually
 * touching the response object would suppress the controller's response
 * mapping pipeline.
 *
 * ## Sanitisation
 *
 * Internal columns (`password_hash`, `created_at`, `updated_at`, etc.)
 * NEVER appear in a response. `toUserPublic(user)` strips the row down
 * to the five fields we want callers to see (R1.9 / AGENTS.md →
 * "Backend Coding Rules"). Preferring an explicit allowlist over a
 * blocklist means a future migration that adds an internal column
 * (e.g. `mfa_secret`) cannot accidentally leak through this surface.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { User } from '@prisma/client';
import type { Request, Response } from 'express';

import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { EmailLoginDto } from './dto/email-login.dto';
import { EmailSignupDto } from './dto/email-signup.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { TelegramLoginDto } from './dto/telegram-login.dto';
import { TelegramWidgetDto } from './dto/telegram-widget.dto';
import { GoogleAuthService } from './google-auth.service';
import {
  clearSessionCookie,
  setSessionCookie,
  type SessionAuthenticatedRequest,
} from './session.middleware';
import { SessionService } from './session.service';
import { TelegramAuthService } from './telegram-auth.service';

// -----------------------------------------------------------------------------
// Public response shapes
// -----------------------------------------------------------------------------

/**
 * Sanitised user projection sent on the wire. Matches the design's
 * "auth response" shape exactly. Allowlist (not blocklist) so internal
 * columns added in future migrations cannot accidentally surface here.
 */
export interface UserPublic {
  id: string;
  /** May be `null` when the user only has a Telegram or Google identity. */
  email: string | null;
  display_name: string | null;
  preferred_lang: 'km' | 'en' | 'zh';
  is_admin: boolean;
}

/** Standard response envelope shared by every authenticating route. */
export interface AuthResponse {
  user: UserPublic;
  /** ISO-8601 string; identical to `Session.expires_at`. */
  expires_at: string;
}

/** Response shape for `GET /v1/auth/me`. */
export interface MeResponse {
  user: UserPublic;
}

/** Response shape for `POST /v1/auth/logout`. */
export interface LogoutResponse {
  ok: true;
}

// -----------------------------------------------------------------------------
// Controller
// -----------------------------------------------------------------------------

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly telegramAuth: TelegramAuthService,
    private readonly googleAuth: GoogleAuthService,
    private readonly sessions: SessionService,
  ) {}

  // ---------------------------------------------------------------------------
  // Email — signup
  // ---------------------------------------------------------------------------

  /**
   * `POST /v1/auth/email/signup` — create a new email-backed user.
   *
   * Tighter `auth_signup` IP bucket so a flooding client cannot create
   * thousands of empty `User` rows. Per-identity rate limit lives in
   * `AuthService.signupEmail` via `AuthAttemptService` (R1.7).
   */
  @Throttle({ auth_signup: { limit: 5, ttl: 60_000 } })
  @Post('email/signup')
  @HttpCode(HttpStatus.OK)
  async signupEmail(
    @Body() dto: EmailSignupDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const result = await this.authService.signupEmail({
      email: dto.email,
      password: dto.password,
      displayName: dto.displayName ?? null,
      preferredLang: dto.preferredLang ?? null,
      ip: extractIp(req),
      userAgent: extractUserAgent(req),
    });

    setSessionCookie(res, result.rawSessionToken, {
      maxAgeMs: this.sessions.sessionTtlMs,
    });

    return buildAuthResponse(result.user, result.session.expires_at);
  }

  // ---------------------------------------------------------------------------
  // Email — login
  // ---------------------------------------------------------------------------

  /**
   * `POST /v1/auth/email/login` — authenticate an existing user.
   *
   * `auth_login` IP bucket gates raw bursts; `AuthAttemptService` gates
   * per-account attempts. Wrong credentials surface as
   * `auth.invalid_credentials` (HTTP 401) from the service.
   */
  @Throttle({ auth_login: { limit: 5, ttl: 60_000 } })
  @Post('email/login')
  @HttpCode(HttpStatus.OK)
  async loginEmail(
    @Body() dto: EmailLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const result = await this.authService.loginEmail({
      email: dto.email,
      password: dto.password,
      ip: extractIp(req),
      userAgent: extractUserAgent(req),
    });

    setSessionCookie(res, result.rawSessionToken, {
      maxAgeMs: this.sessions.sessionTtlMs,
    });

    return buildAuthResponse(result.user, result.session.expires_at);
  }

  // ---------------------------------------------------------------------------
  // Telegram — login
  // ---------------------------------------------------------------------------

  /**
   * `POST /v1/auth/telegram` — sign in via verified Telegram WebApp
   * `initData`. The service performs HMAC verification, upserts the
   * `ExternalIdentity` and `User`, and issues a session.
   *
   * Uses the `auth_signup` bucket (a fresh sign-in may create a brand-
   * new user) — same IP ceiling as the email-signup route.
   */
  @Throttle({ auth_signup: { limit: 5, ttl: 60_000 } })
  @Post('telegram')
  @HttpCode(HttpStatus.OK)
  async loginTelegram(
    @Body() dto: TelegramLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const result = await this.telegramAuth.loginTelegram({
      initData: dto.initData,
      ip: extractIp(req),
      userAgent: extractUserAgent(req),
    });

    setSessionCookie(res, result.rawSessionToken, {
      maxAgeMs: this.sessions.sessionTtlMs,
    });

    return buildAuthResponse(result.user, result.sessionExpiresAt);
  }

  // ---------------------------------------------------------------------------
  // Telegram — Login Widget (web)
  // ---------------------------------------------------------------------------

  /**
   * `POST /v1/auth/telegram/widget` — sign in via Telegram Login Widget.
   *
   * Different from `POST /v1/auth/telegram` (Mini App `initData`). The
   * web Login Widget uses `secret = SHA256(bot_token)` HMAC scheme.
   */
  @Throttle({ auth_signup: { limit: 5, ttl: 60_000 } })
  @Post('telegram/widget')
  @HttpCode(HttpStatus.OK)
  async loginTelegramWidget(
    @Body() dto: TelegramWidgetDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const result = await this.telegramAuth.loginTelegramWidget({
      payload: dto.payload,
      ip: extractIp(req),
      userAgent: extractUserAgent(req),
    });

    setSessionCookie(res, result.rawSessionToken, {
      maxAgeMs: this.sessions.sessionTtlMs,
    });

    return buildAuthResponse(result.user, result.sessionExpiresAt);
  }

  // ---------------------------------------------------------------------------
  // Google — login
  // ---------------------------------------------------------------------------

  /**
   * `POST /v1/auth/google` — sign in via verified Google `id_token`.
   *
   * Body uses the wire field `id_token` (matches Google's SDK); the
   * service expects camelCase `idToken`, so we map at the controller
   * boundary instead of leaking snake_case beyond DTOs.
   */
  @Throttle({ auth_signup: { limit: 5, ttl: 60_000 } })
  @Post('google')
  @HttpCode(HttpStatus.OK)
  async loginGoogle(
    @Body() dto: GoogleLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const result = await this.googleAuth.loginGoogle({
      idToken: dto.id_token,
      ip: extractIp(req),
      userAgent: extractUserAgent(req),
    });

    setSessionCookie(res, result.rawSessionToken, {
      maxAgeMs: this.sessions.sessionTtlMs,
    });

    return buildAuthResponse(result.user, result.sessionExpiresAt);
  }

  // ---------------------------------------------------------------------------
  // Logout
  // ---------------------------------------------------------------------------

  /**
   * `POST /v1/auth/logout` — revoke the current session and clear the
   * `bothsafe_session` cookie.
   *
   * Reads the raw token from `req.sessionToken` (set by
   * `SessionCookieMiddleware` when it resolved the session) rather than
   * re-parsing the cookie — using the slot the middleware already
   * validated guarantees we're revoking the same session the client is
   * currently authenticated as.
   *
   * Idempotent: if `revokeSession` returns `false` (already gone) we
   * still clear the cookie and report `ok: true`. The user has logged
   * out as far as the client is concerned.
   */
  @UseGuards(AuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LogoutResponse> {
    const authReq = req as SessionAuthenticatedRequest;
    const rawToken = authReq.sessionToken;
    if (typeof rawToken === 'string' && rawToken.length > 0) {
      await this.sessions.revokeSession(rawToken);
    }
    clearSessionCookie(res);
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Me
  // ---------------------------------------------------------------------------

  /**
   * `GET /v1/auth/me` — return the authenticated user envelope.
   *
   * `AuthGuard` short-circuits unauthenticated requests with
   * `auth.required` (R1.8) so the `@CurrentUser()` value is guaranteed
   * non-null inside this handler. We still narrow defensively because
   * the decorator's static type is `User | undefined`.
   */
  @UseGuards(AuthGuard)
  @Get('me')
  me(@CurrentUser() user: User | undefined): MeResponse {
    // Guard already rejected the unauthenticated case; the assertion is
    // a belt-and-braces narrow for the static type. If the guard is ever
    // accidentally removed from this route, the runtime check makes the
    // failure mode explicit instead of returning `{ user: undefined }`.
    if (!user) {
      throw new Error('AuthGuard contract violation: req.user is undefined');
    }
    return { user: toUserPublic(user) };
  }
}

// -----------------------------------------------------------------------------
// File-private helpers
// -----------------------------------------------------------------------------

/**
 * Project a Prisma `User` row to the wire-safe `UserPublic` shape.
 * Allowlist-based: we explicitly enumerate every field that crosses the
 * boundary, so internal columns added in future migrations cannot leak.
 */
function toUserPublic(user: User): UserPublic {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    preferred_lang: user.preferred_lang,
    is_admin: user.is_admin,
  };
}

/** Build the standard `{ user, expires_at }` response envelope. */
function buildAuthResponse(user: User, expiresAt: Date): AuthResponse {
  return {
    user: toUserPublic(user),
    expires_at: expiresAt.toISOString(),
  };
}

/**
 * Pull the source IP off the request. `req.ip` honours the trust-proxy
 * config when set; we fall back to the raw socket address so dev /
 * test setups without trust-proxy still get something useful. Returns
 * `null` when neither is available so the service's optional metadata
 * stays optional.
 */
function extractIp(req: Request): string | null {
  if (typeof req.ip === 'string' && req.ip.length > 0) return req.ip;
  const remote = req.socket?.remoteAddress;
  if (typeof remote === 'string' && remote.length > 0) return remote;
  return null;
}

/** Extract the `User-Agent` header verbatim (best-effort). */
function extractUserAgent(req: Request): string | null {
  const header = req.headers['user-agent'];
  if (typeof header !== 'string' || header.length === 0) return null;
  return header;
}
