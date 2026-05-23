import * as Joi from 'joi';

/**
 * Joi schema for validating required environment variables at startup.
 * The application will fail fast if any required variable is missing or invalid.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),

  PORT: Joi.number().integer().min(1).max(65535).default(3000),

  DATABASE_URL: Joi.string().uri().required(),

  JWT_SECRET: Joi.string().min(32).required(),

  APP_BASE_URL: Joi.string().uri().default('http://localhost:3000'),

  INVITE_TOKEN_TTL_HOURS: Joi.number().integer().positive().default(72),

  DEAL_EXPIRES_HOURS: Joi.number().integer().positive().default(720),

  PLATFORM_FEE_PERCENT: Joi.number().min(0).max(100).default(2),

  DEFAULT_CURRENCY: Joi.string().length(3).uppercase().default('USD'),

  CORS_ORIGINS: Joi.string().allow('').default(''),

  TELEGRAM_BOT_TOKEN: Joi.string().allow('').default(''),

  TELEGRAM_BOT_ENABLED: Joi.boolean().default(false),

  ADMIN_BOOTSTRAP_EMAIL: Joi.string().email().required(),

  ADMIN_BOOTSTRAP_PASSWORD: Joi.string().min(8).required(),
}).options({ allowUnknown: true });
