/**
 * Auth module barrel.
 *
 * Re-exports the public surface of `src/auth/`. Consumers should import
 * from this module (`import { … } from 'src/auth'`) rather than reaching
 * into individual files so that internal reorganisation stays a private
 * concern.
 *
 * Append-only: every 4.x task adds its own re-exports here.
 */

export { AuthModule } from './auth.module';
export {
  AuthController,
  type AuthResponse,
  type LogoutResponse,
  type MeResponse,
  type UserPublic,
} from './auth.controller';
export {
  AuthService,
  type AuthRequestMeta,
  type AuthResult,
  type LoginEmailInput,
  type SignupEmailInput,
} from './auth.service';
export { EmailSignupDto } from './dto/email-signup.dto';
export { EmailLoginDto } from './dto/email-login.dto';
export { TelegramLoginDto } from './dto/telegram-login.dto';
export { GoogleLoginDto } from './dto/google-login.dto';
export {
  SessionService,
  type IssuedSession,
  type SessionRequestMeta,
} from './session.service';
export {
  SESSION_COOKIE_NAME,
  SessionCookieMiddleware,
  clearSessionCookie,
  setSessionCookie,
  type SessionAuthenticatedRequest,
} from './session.middleware';
export {
  ARGON2ID_PARAMS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  dummyVerify,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password';
export { AuthAttemptService, type AuthAttemptMeta } from './auth-attempt.service';
export { AuthGuard } from './auth.guard';
export { AdminGuard } from './admin.guard';
export { CurrentUser } from './current-user.decorator';
export {
  type AuthenticatedRequest,
  type AuthenticatedUser,
  readRequestUser,
} from './auth.types';
export {
  TelegramAuthService,
  type LoginTelegramInput,
  type LoginTelegramResult,
} from './telegram-auth.service';
export {
  GoogleAuthService,
  type LoginGoogleInput,
  type LoginGoogleResult,
} from './google-auth.service';
export {
  verifyTelegramInitData,
  MAX_AUTH_DATE_AGE_MS,
  type TelegramUser,
  type VerifiedTelegramInitData,
} from './telegram-init-data';
export { verifyGoogleIdToken, type GoogleClaims } from './google-id-token';
