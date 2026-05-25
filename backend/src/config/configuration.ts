/**
 * Application configuration factory.
 * Reads environment variables and returns a typed configuration object.
 */
export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  database: {
    url: process.env.DATABASE_URL,
  },

  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN ?? '1h',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',
  },

  app: {
    baseUrl: process.env.APP_BASE_URL ?? 'http://localhost:3000',
    inviteTokenTtlHours: parseInt(process.env.INVITE_TOKEN_TTL_HOURS ?? '72', 10),
    dealExpiresHours: parseInt(process.env.DEAL_EXPIRES_HOURS ?? '720', 10),
    platformFeePercent: parseFloat(process.env.PLATFORM_FEE_PERCENT ?? '2'),
    defaultCurrency: process.env.DEFAULT_CURRENCY ?? 'USD',
    receiverAccountLabel: process.env.RECEIVER_ACCOUNT_LABEL ?? 'BothSafe Escrow',
  },

  session: {
    // Lifetime of an authenticated session (R1.2 = 24 h minimum). The env
    // var is in days for operator ergonomics; SessionService converts to ms.
    // Defaults to 1 day so unit tests / dev never silently inherit a longer
    // window than R1.2 prescribes.
    ttlDays: parseInt(process.env.SESSION_TTL_DAYS ?? '1', 10),
  },

  cors: {
    origins: (process.env.CORS_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
    webhookUrl: process.env.TELEGRAM_WEBHOOK_URL,
    botUsername: process.env.TELEGRAM_BOT_USERNAME,
    botEnabled: process.env.TELEGRAM_BOT_ENABLED === 'true',
  },

  // Google OAuth — `GOOGLE_CLIENT_ID` is consumed by
  // `verifyGoogleIdToken(idToken, audience)` (task 4.3). The verifier
  // rejects any id_token whose `aud` claim does not match this value.
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  },

  minio: {
    endpoint: process.env.MINIO_ENDPOINT ?? 'localhost',
    port: parseInt(process.env.MINIO_PORT ?? '9000', 10),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY ?? 'minioadmin',
    bucket: process.env.MINIO_BUCKET ?? 'bothsafe',
  },

  admin: {
    bootstrapEmail: process.env.ADMIN_BOOTSTRAP_EMAIL,
    bootstrapPassword: process.env.ADMIN_BOOTSTRAP_PASSWORD,
  },

  bakong: {
    accountId: process.env.BAKONG_ACCOUNT_ID ?? '',
    merchantName: process.env.BAKONG_MERCHANT_NAME ?? 'BothSafe Escrow',
    merchantCity: process.env.BAKONG_MERCHANT_CITY ?? 'Phnom Penh',
    apiToken: process.env.BAKONG_API_TOKEN ?? '',
  },
});
