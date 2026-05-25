/**
 * Domain exception base class and canonical error code namespaces for the
 * BothSafe backend.
 *
 * The wire format for every error response is the envelope defined in
 * `design.md` §"Cross-Cutting Concerns" / task 3.6:
 *
 * ```json
 * {
 *   "error": {
 *     "code": "wallet.insufficient_balance",
 *     "message_key": "errors.wallet.insufficient_balance",
 *     "details": { "available": "12.00", "required": "20.00" }
 *   }
 * }
 * ```
 *
 * - `code` is the stable, machine-readable identifier (e.g.
 *   `auth.invalid_credentials`, `deal.locked_after_payment`).
 * - `message_key` is the i18n key the frontend looks up to render localised
 *   text (km / en / zh) — defaults to `errors.${code}` so callers rarely
 *   need to pass it explicitly.
 * - `details` is an optional, JSON-serialisable object with structured
 *   context (the buyer's wallet balance, the field that failed validation,
 *   etc.). It MUST NOT contain plaintext secrets, password hashes, raw
 *   tokens, stack traces, or any other internal data; the filter strips
 *   forbidden keys defensively but the caller is the first line of
 *   defence (AGENTS.md → "Backend Coding Rules").
 *
 * `DomainException` extends NestJS's `HttpException` so it integrates
 * cleanly with `ExceptionsHandler`, the test harness, and any third-party
 * tooling that already understands `HttpException`. The global filter
 * (`GlobalExceptionFilter`) is responsible for serialising the body to the
 * envelope above; if a `DomainException` ever escapes the filter, the body
 * Nest sees is already shaped correctly and will be written verbatim.
 *
 * Pure module — no I/O, no module-level mutable state, no NestJS request
 * context dependencies.
 *
 * Requirements references (task 3.6):
 *   R1.5, R1.6, R1.7, R7.5, R7.7, R8.2, R9.3–R9.6, R10.5, R10.7, R10.8,
 *   R11.6, R11.7, R12.3, R12.5, R12.6, R13.7, R14.2, R15.6, R15.7, R16.4,
 *   R16.5, R16.8, R17.4, R17.6, R17.9.
 */

import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Canonical error-code namespaces. Every `DomainException` code MUST start
 * with one of these prefixes so the frontend can route by namespace
 * without parsing the full code.
 *
 * Add new namespaces here when introducing a new module surface; do not
 * scatter ad-hoc prefixes across the codebase.
 */
export const ERROR_CODE_NAMESPACES = [
  'auth',
  'deal',
  'wallet',
  'payment',
  'shipping',
  'confirmation',
  'dispute',
  'withdrawal',
  'invite',
  'join',
  'storage',
  'rate',
  'request',
  'resource',
  'server',
] as const;

export type ErrorCodeNamespace = (typeof ERROR_CODE_NAMESPACES)[number];

/**
 * Branded error code: `${namespace}.${suffix}` where `namespace` is one of
 * `ERROR_CODE_NAMESPACES`. Codes are conventional (not a fixed enum) so
 * modules can introduce new specific codes without touching this file —
 * the namespace prefix is the only contract the filter cares about.
 */
export type ErrorCode = `${ErrorCodeNamespace}.${string}`;

/**
 * Shape of the `error` field returned to clients. Always serialised as
 * `{ error: ErrorBody }` by `GlobalExceptionFilter`.
 *
 * `details` is intentionally typed as `Record<string, unknown>` (not `any`)
 * so callers must explicitly opt into looser typing at the call site.
 */
export interface ErrorBody {
  code: ErrorCode;
  message_key: string;
  details?: Record<string, unknown>;
}

/**
 * The full top-level envelope: `{ error: { code, message_key, details? } }`.
 */
export interface ErrorEnvelope {
  error: ErrorBody;
}

/**
 * Build the i18n message key for an error code. Default convention is
 * `errors.${code}` — frontends look this up in
 * `frontend/messages/{km,en,zh}.json` (task 3.10). Override only when a
 * code intentionally shares a translation with another code.
 */
export function defaultMessageKey(code: ErrorCode): string {
  return `errors.${code}`;
}

/**
 * Construct the body NestJS stores on a `DomainException`. Exported so
 * `GlobalExceptionFilter` can reuse the exact same shape when adapting
 * generic `HttpException`s, and so tests can assert on the body without
 * instantiating a request.
 */
export function buildErrorBody(
  code: ErrorCode,
  options?: {
    messageKey?: string;
    details?: Record<string, unknown>;
  },
): ErrorBody {
  const body: ErrorBody = {
    code,
    message_key: options?.messageKey ?? defaultMessageKey(code),
  };
  if (options?.details !== undefined) {
    body.details = options.details;
  }
  return body;
}

/**
 * Options accepted by `DomainException` and its helper factories.
 */
export interface DomainExceptionOptions {
  /** Optional structured context. JSON-serialisable; never include secrets. */
  details?: Record<string, unknown>;
  /** Override the default `errors.${code}` i18n key. */
  messageKey?: string;
  /**
   * Optional underlying error preserved on the exception for server-side
   * logging only. Never serialised to the response.
   */
  cause?: unknown;
}

/**
 * Base class for every domain-level exception in the BothSafe backend.
 *
 * Construct directly when a status/code pair is one-off, or use the static
 * factories (`DomainException.badRequest`, `.forbidden`, etc.) for the
 * common cases. The instance is shaped so:
 *
 *   - `instance.code` exposes the stable code for switch-style branching
 *     in tests and middleware.
 *   - `instance.details` exposes the structured context payload.
 *   - `instance.getStatus()` (inherited) returns the HTTP status.
 *   - `instance.getResponse()` (inherited) returns the `ErrorBody` that
 *     `GlobalExceptionFilter` wraps in `{ error: ... }` before sending.
 *
 * Stack traces and any wrapped `cause` are kept on the JS Error instance
 * but are not part of `getResponse()` — the filter logs them, the response
 * never echoes them.
 */
export class DomainException extends HttpException {
  public readonly code: ErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    status: HttpStatus,
    options?: DomainExceptionOptions,
  ) {
    super(buildErrorBody(code, options), status, { cause: options?.cause });
    this.code = code;
    this.details = options?.details;
    // `HttpException` sets `name` to its constructor name; keep
    // `DomainException` so log lines are easy to filter.
    this.name = 'DomainException';
  }

  // ---------------------------------------------------------------------------
  // Status-keyed factories.
  //
  // Each factory exists so call sites read intent-first
  // (`DomainException.forbidden('auth.role_forbidden')`) rather than
  // status-first. They are thin wrappers — no extra logic — so test
  // expectations against the constructor are equivalent.
  // ---------------------------------------------------------------------------

  /** 400 Bad Request — malformed input, validation failure, business-rule precondition. */
  static badRequest(code: ErrorCode, options?: DomainExceptionOptions): DomainException {
    return new DomainException(code, HttpStatus.BAD_REQUEST, options);
  }

  /** 401 Unauthorized — missing or invalid session/credentials. */
  static unauthorized(code: ErrorCode, options?: DomainExceptionOptions): DomainException {
    return new DomainException(code, HttpStatus.UNAUTHORIZED, options);
  }

  /** 403 Forbidden — authenticated, but not allowed (role, ownership, deal state). */
  static forbidden(code: ErrorCode, options?: DomainExceptionOptions): DomainException {
    return new DomainException(code, HttpStatus.FORBIDDEN, options);
  }

  /** 404 Not Found — resource missing or invisible to this viewer. */
  static notFound(code: ErrorCode, options?: DomainExceptionOptions): DomainException {
    return new DomainException(code, HttpStatus.NOT_FOUND, options);
  }

  /** 409 Conflict — unique-constraint violation, idempotency clash, state-machine conflict. */
  static conflict(code: ErrorCode, options?: DomainExceptionOptions): DomainException {
    return new DomainException(code, HttpStatus.CONFLICT, options);
  }

  /** 422 Unprocessable Entity — semantic validation failure on a well-formed payload. */
  static unprocessable(code: ErrorCode, options?: DomainExceptionOptions): DomainException {
    return new DomainException(code, HttpStatus.UNPROCESSABLE_ENTITY, options);
  }

  /** 429 Too Many Requests — rate-limit / throttle exhaustion. */
  static tooManyRequests(code: ErrorCode, options?: DomainExceptionOptions): DomainException {
    return new DomainException(code, HttpStatus.TOO_MANY_REQUESTS, options);
  }

  /** 503 Service Unavailable — upstream (Bakong, MinIO, etc.) temporarily down. */
  static serviceUnavailable(
    code: ErrorCode,
    options?: DomainExceptionOptions,
  ): DomainException {
    return new DomainException(code, HttpStatus.SERVICE_UNAVAILABLE, options);
  }
}

/**
 * Type guard for `DomainException`. Useful in tests and in the filter when
 * narrowing an unknown caught value.
 */
export function isDomainException(e: unknown): e is DomainException {
  return e instanceof DomainException;
}

/**
 * Type guard for the wire `ErrorEnvelope`. Used by tests and the filter to
 * detect responses that are already enveloped (e.g. a manually-thrown
 * `HttpException` whose body matches the canonical shape).
 */
export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const maybe = (value as { error?: unknown }).error;
  if (typeof maybe !== 'object' || maybe === null) return false;
  const body = maybe as Partial<ErrorBody>;
  return typeof body.code === 'string' && typeof body.message_key === 'string';
}
