/**
 * Public surface of the idempotency module.
 *
 * Mirrors the `src/audit/index.ts` convention so `AppModule` (and any
 * future feature module that needs the middleware directly) can import
 * the module and the middleware class without reaching past the module
 * boundary.
 */

export { IdempotencyModule } from './idempotency.module';
export { IdempotencyMiddleware } from './idempotency.middleware';
export {
  IDEMPOTENCY_HEADER,
  IDEMPOTENT_METHODS,
  DEFAULT_TTL_MS,
  KEY_MIN_LENGTH,
  KEY_MAX_LENGTH,
  buildMiddlewareScope,
} from './idempotency.constants';
