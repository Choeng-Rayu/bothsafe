/**
 * Pino logger configuration with sensitive field redaction + file rotation.
 *
 * Logs are saved to:
 *   - Development: `logs/app-dev.log` (daily rotation, 7 days retention)
 *   - Production: `logs/app.log` (daily rotation, 30 days retention)
 *
 * Rotation: Creates `app.log.1`, `app.log.2`, etc. when rotating.
 * Size limit: 50MB per file in production, 20MB in dev.
 *
 * Redacts: password, password_hash, token, raw_*_token, Authorization,
 * Cookie, TELEGRAM_BOT_TOKEN, *_secret, BINANCE_PAY_API_SECRET.
 */

import { LoggerModule } from 'nestjs-pino';
import * as path from 'node:path';

const isProduction = process.env.NODE_ENV === 'production';
const logLevel = isProduction ? 'info' : 'debug';

// Log directory (relative to backend root)
const logDir = path.join(__dirname, '../../logs');
const logFile = isProduction
  ? path.join(logDir, 'app.log')
  : path.join(logDir, 'app-dev.log');

export const PinoLoggerModule = LoggerModule.forRoot({
  pinoHttp: {
    level: logLevel,
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
        'raw_creator_access_token',
        'raw_participant_access_token',
        'raw_invite_token',
        'rawSessionToken',
        'rawToken',
        'Authorization',
        'Cookie',
        'TELEGRAM_BOT_TOKEN',
        'BINANCE_PAY_API_SECRET',
        'BINANCE_PAY_API_KEY',
        'jwt_secret',
        'session_secret',
        'encryption_master_key',
        'GOOGLE_CLIENT_SECRET',
        'BAKONG_API_TOKEN',
      ],
      censor: '[REDACTED]',
    },
    // Dual transport: stdout + file with rotation
    transport: {
      targets: [
        // Console output (pretty in dev, JSON in prod)
        {
          target: isProduction ? 'pino/file' : 'pino-pretty',
          level: logLevel,
          options: isProduction
            ? { destination: 1 } // stdout
            : {
                destination: 1,
                colorize: true,
                translateTime: 'HH:MM:ss',
                ignore: 'pid,hostname',
              },
        },
        // File output with daily rotation
        {
          target: 'pino-roll',
          level: logLevel,
          options: {
            file: logFile,
            frequency: 'daily',
            size: isProduction ? '50m' : '20m',
            limit: { count: isProduction ? 30 : 7 },
            mkdir: true,
          },
        },
      ],
    },
  },
});
