/**
 * Pino logger configuration with sensitive field redaction (§15.7).
 *
 * Redacts: password, password_hash, token, raw_*_token, Authorization,
 * Cookie, TELEGRAM_BOT_TOKEN, *_secret, BINANCE_PAY_API_SECRET.
 */

import { LoggerModule } from 'nestjs-pino';

export const PinoLoggerModule = LoggerModule.forRoot({
  pinoHttp: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.body.password',
        'req.body.password_hash',
        'req.body.token',
        'req.body.secret',
        'req.body.api_secret',
        'password',
        'password_hash',
        'token',
        'raw_access_token',
        'raw_refresh_token',
        'Authorization',
        'Cookie',
        'TELEGRAM_BOT_TOKEN',
        'BINANCE_PAY_API_SECRET',
        'jwt_secret',
        'session_secret',
        'encryption_master_key',
      ],
      censor: '[REDACTED]',
    },
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino/file', options: { destination: 1 } }
        : undefined,
  },
});
