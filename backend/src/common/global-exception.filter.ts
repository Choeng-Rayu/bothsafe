/**
 * Global exception filter — single source of truth for the BothSafe error
 * envelope.
 *
 * Every uncaught exception (or `HttpException` thrown from a controller
 * or service) flows through this filter. The filter:
 *
 *   1. Maps the exception to an HTTP status code.
 *   2. Maps it to a stable `ErrorBody` (`{ code, message_key, details? }`).
 *   3. Wraps the body in `{ error: ... }` and writes the response.
 *   4. Logs the original exception server-side via `@nestjs/common`'s
 *      `Logger` (planned to be replaced with Pino later — task list
 *      §"Cross-Cutting Concerns").
 *
 * Stack traces, raw Prisma metadata, internal cause chains, and any other
 * server-side details are NEVER serialised into the response body. The
 * filter is the last line of defence: even if a service throws a generic
 * `Error('something went wrong')`, the client sees only
 * `server.internal_error`.
 *
 * The filter handles three exception shapes explicitly:
 *
 *   - `DomainException` — already shaped, pass through verbatim.
 *   - `Prisma.PrismaClientKnownRequestError` — translate `P2002` (unique
 *     violation) and `P2025` (record-not-found) to canonical domain codes.
 *   - `HttpException` — preserve status, but coerce the body to the
 *     envelope shape using the suite of canonical codes.
 *
 * Anything else collapses to a 500 `server.internal_error`.
 *
 * Wire this filter into `AppModule` via the `APP_FILTER` provider so it
 * applies to every controller and gateway:
 *
 * ```ts
 * import { APP_FILTER } from '@nestjs/core';
 * import { GlobalExceptionFilter } from './common/global-exception.filter';
 *
 * @Module({
 *   providers: [{ provide: APP_FILTER, useClass: GlobalExceptionFilter }],
 * })
 * ```
 *
 * Requirements references (task 3.6):
 *   AGENTS.md → "Backend Coding Rules" (`message_key`); R1.5, R1.6, R1.7,
 *   R7.5, R7.7, R8.2, R9.3–R9.6, R10.5, R10.7, R10.8, R11.6, R11.7, R12.3,
 *   R12.5, R12.6, R13.7, R14.2, R15.6, R15.7, R16.4, R16.5, R16.8, R17.4,
 *   R17.6, R17.9.
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import {
  buildErrorBody,
  DomainException,
  ErrorBody,
  ErrorCode,
  ErrorEnvelope,
  isDomainException,
  isErrorEnvelope,
} from './errors';

/**
 * Extra response keys we're willing to forward when adapting a generic
 * `HttpException` whose body is a structured object. Specifically, any
 * unknown string key is dropped; only `details` survives — and even then,
 * only if it is a plain JSON object.
 */
const ALLOWED_PASSTHROUGH_KEYS: ReadonlySet<string> = new Set([
  'code',
  'message_key',
  'details',
]);

/**
 * Maps a Prisma `code` (e.g. `P2002`) onto an HTTP status / domain code
 * pair. The mapping is intentionally narrow — only the codes we have an
 * agreed translation for are listed here. Any unmapped Prisma error falls
 * through to `server.internal_error` after being logged.
 *
 * - P2002 (Unique constraint) → 409 Conflict / `resource.conflict`
 * - P2025 (Record not found)  → 404 Not Found / `resource.not_found`
 *
 * The list is `Object.freeze`d so consumers can rely on its immutability.
 */
const PRISMA_ERROR_MAP: Readonly<
  Record<string, { status: HttpStatus; code: ErrorCode }>
> = Object.freeze({
  P2002: { status: HttpStatus.CONFLICT, code: 'resource.conflict' },
  P2025: { status: HttpStatus.NOT_FOUND, code: 'resource.not_found' },
});

/**
 * Maps an HTTP status to a canonical fallback code used when an
 * `HttpException` is thrown without a structured body (e.g. plain
 * `throw new ForbiddenException()` somewhere we don't control).
 *
 * Keep this list in sync with the namespaces defined in `errors.ts`.
 */
const HTTP_STATUS_FALLBACK_CODE: Readonly<Record<number, ErrorCode>> =
  Object.freeze({
    [HttpStatus.BAD_REQUEST]: 'request.invalid',
    [HttpStatus.UNAUTHORIZED]: 'auth.required',
    [HttpStatus.FORBIDDEN]: 'auth.forbidden',
    [HttpStatus.NOT_FOUND]: 'resource.not_found',
    [HttpStatus.CONFLICT]: 'resource.conflict',
    [HttpStatus.PAYLOAD_TOO_LARGE]: 'request.payload_too_large',
    [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'request.unsupported_media_type',
    [HttpStatus.UNPROCESSABLE_ENTITY]: 'request.unprocessable',
    [HttpStatus.TOO_MANY_REQUESTS]: 'rate.exceeded',
  });

/**
 * Serialise a request to a stable, low-cardinality identity for log lines.
 * Returns `undefined` if no request is on the host (e.g. WebSocket
 * gateway invocations).
 */
function describeRequest(req: Request | undefined): string | undefined {
  if (!req) return undefined;
  // We deliberately avoid logging the full URL with query parameters — those
  // can carry invite/access tokens (see AGENTS.md → "URL Format").
  return `${req.method} ${req.route?.path ?? req.path ?? req.url ?? '<unknown>'}`;
}

/**
 * Narrow an unknown to a `Prisma.PrismaClientKnownRequestError`. We use
 * structural detection (`code` starts with `P` + digits) on top of the
 * `instanceof` check because the Prisma 7 driver-adapter setup can produce
 * errors that don't quite reach the public class — but they always carry
 * the same `code` shape.
 */
function isPrismaKnownRequestError(
  e: unknown,
): e is Prisma.PrismaClientKnownRequestError {
  if (e instanceof Prisma.PrismaClientKnownRequestError) return true;
  if (typeof e !== 'object' || e === null) return false;
  const maybe = e as { name?: unknown; code?: unknown };
  return (
    maybe.name === 'PrismaClientKnownRequestError' &&
    typeof maybe.code === 'string' &&
    /^P\d+$/.test(maybe.code)
  );
}

/**
 * Adapt an `HttpException` body to the canonical error envelope. Handles
 * three flavours of `getResponse()` payload:
 *
 *   1. A `string` (e.g. `throw new BadRequestException('something')`) —
 *      fall back to the HTTP-status-keyed default code; preserve no extra
 *      detail (the string is treated as untrusted user-facing copy and
 *      dropped to avoid leaking internals through accidental error
 *      messages).
 *   2. A `class-validator` validation envelope
 *      (`{ statusCode, message: string[], error }`) — collapse `message`
 *      into `details.errors` under `request.validation_failed`.
 *   3. Anything already shaped as `{ code, message_key, details? }` — pass
 *      through verbatim, dropping unknown keys.
 */
function adaptHttpExceptionBody(
  exception: HttpException,
  status: HttpStatus,
): ErrorBody {
  const raw = exception.getResponse();

  // Flavour 1 — string body.
  if (typeof raw === 'string') {
    const fallbackCode =
      HTTP_STATUS_FALLBACK_CODE[status] ?? 'server.internal_error';
    return buildErrorBody(fallbackCode);
  }

  if (typeof raw !== 'object' || raw === null) {
    const fallbackCode =
      HTTP_STATUS_FALLBACK_CODE[status] ?? 'server.internal_error';
    return buildErrorBody(fallbackCode);
  }

  // Flavour 2 — class-validator envelope. Detect by `message: string[]`
  // and the canonical shape Nest produces for `ValidationPipe`.
  const candidate = raw as Record<string, unknown>;
  if (
    Array.isArray(candidate.message) &&
    candidate.message.every((m) => typeof m === 'string')
  ) {
    return buildErrorBody('request.validation_failed', {
      details: { errors: candidate.message as string[] },
    });
  }

  // Flavour 3 — already enveloped.
  if (
    typeof candidate.code === 'string' &&
    typeof candidate.message_key === 'string'
  ) {
    const code = candidate.code as ErrorCode;
    const messageKey = candidate.message_key as string;
    const detailsRaw = candidate.details;
    const details =
      typeof detailsRaw === 'object' &&
      detailsRaw !== null &&
      !Array.isArray(detailsRaw)
        ? (detailsRaw as Record<string, unknown>)
        : undefined;
    return buildErrorBody(code, { messageKey, details });
  }

  // Flavour 4 — structured but unknown shape. Log keys for the operator
  // (debug only) and fall back to the status-default code. Strip the body
  // entirely from the response to avoid leaking internal fields.
  const knownKeys = Object.keys(candidate).filter((k) =>
    ALLOWED_PASSTHROUGH_KEYS.has(k),
  );
  if (knownKeys.length > 0 && typeof candidate.code === 'string') {
    return buildErrorBody(candidate.code as ErrorCode);
  }

  const fallbackCode =
    HTTP_STATUS_FALLBACK_CODE[status] ?? 'server.internal_error';
  return buildErrorBody(fallbackCode);
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request | undefined>();

    const { status, body } = this.resolve(exception);

    this.logException(exception, status, request);

    // Defensive: if downstream middleware already wrote headers, there is
    // nothing useful we can do beyond logging — silently bail to avoid
    // crashing the process with `ERR_HTTP_HEADERS_SENT`.
    if (response.headersSent) {
      return;
    }

    const envelope: ErrorEnvelope = { error: body };
    response.status(status).json(envelope);
  }

  /**
   * Pure mapping from an unknown thrown value to the response shape. Split
   * out so it can be unit-tested without a request/response pair.
   *
   * `internal-only`: do not call from outside the filter or its tests; the
   * contract may evolve as new exception types are introduced.
   */
  resolve(exception: unknown): { status: HttpStatus; body: ErrorBody } {
    // 1. DomainException — preserve verbatim.
    if (isDomainException(exception)) {
      return {
        status: exception.getStatus(),
        body: this.extractDomainBody(exception),
      };
    }

    // 2. PrismaClientKnownRequestError — translate the codes we know.
    if (isPrismaKnownRequestError(exception)) {
      const mapped = PRISMA_ERROR_MAP[exception.code];
      if (mapped) {
        const details = this.safePrismaDetails(exception);
        return {
          status: mapped.status,
          body: buildErrorBody(mapped.code, { details }),
        };
      }
      // Fall through to the generic 500 case; the original error is logged.
      return this.internalErrorResult();
    }

    // 3. Generic HttpException (e.g. throttler, route-not-found, validation).
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = adaptHttpExceptionBody(exception, status);
      return { status, body };
    }

    // 4. Anything else — collapse to 500, never leak the cause.
    return this.internalErrorResult();
  }

  /**
   * Read the canonical body off a `DomainException`, falling back to the
   * code-level default if `getResponse()` was overridden in a subclass that
   * forgot to wire it through.
   */
  private extractDomainBody(exception: DomainException): ErrorBody {
    const raw = exception.getResponse();
    if (isErrorEnvelope({ error: raw })) {
      // `getResponse()` returns the body, not the full envelope; wrap-and-check.
      return raw as ErrorBody;
    }
    // Defensive fallback — synthesise the body from the public fields. This
    // path runs only if a subclass overrode `getResponse()` improperly.
    return buildErrorBody(exception.code, { details: exception.details });
  }

  private internalErrorResult(): { status: HttpStatus; body: ErrorBody } {
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: buildErrorBody('server.internal_error'),
    };
  }

  /**
   * Extract the small, response-safe subset of metadata Prisma carries on
   * a `PrismaClientKnownRequestError`. We only forward the constraint
   * `target` for `P2002` so the frontend can localise "phone is already
   * taken" without inspecting raw model field names — and even then, the
   * names are only safe because Prisma exposes the schema field name, not
   * the underlying SQL identifier.
   *
   * Anything else (the `meta` object as a whole, the SQL message, the
   * cause) stays out of the response body.
   */
  private safePrismaDetails(
    exception: Prisma.PrismaClientKnownRequestError,
  ): Record<string, unknown> | undefined {
    const meta = exception.meta;
    if (!meta || typeof meta !== 'object') return undefined;

    if (exception.code === 'P2002') {
      const target = (meta as { target?: unknown }).target;
      if (Array.isArray(target) && target.every((t) => typeof t === 'string')) {
        return { fields: target };
      }
      if (typeof target === 'string') {
        return { fields: [target] };
      }
    }

    if (exception.code === 'P2025') {
      const cause = (meta as { cause?: unknown }).cause;
      if (typeof cause === 'string') {
        // The string Prisma returns here is generic ("Record to update not
        // found") and does not include user data, so it is safe to forward.
        return { cause };
      }
    }

    return undefined;
  }

  /**
   * Server-side logging. Stack traces are written at the appropriate level
   * for the status — 5xx as `error` (keep them around), 4xx as `debug` so
   * the prod log stays focused on actionable problems.
   *
   * The logger is the `@nestjs/common` console logger today; task 3.10
   * swaps in pino with the redaction list defined in design §"Logging".
   */
  private logException(
    exception: unknown,
    status: HttpStatus,
    request: Request | undefined,
  ): void {
    const route = describeRequest(request);
    const message =
      exception instanceof Error
        ? `${exception.name}: ${exception.message}`
        : `Non-Error thrown: ${String(exception)}`;
    const stack =
      exception instanceof Error && typeof exception.stack === 'string'
        ? exception.stack
        : undefined;
    const prefix = route ? `[${route}]` : '';

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`${prefix} ${message}`, stack);
      return;
    }

    if (isDomainException(exception) || exception instanceof HttpException) {
      // Expected control-flow exception — log at debug so production logs
      // stay clean. Tests asserting "no leak" run against the response, not
      // this log line.
      this.logger.debug(`${prefix} ${message}`);
      return;
    }

    // Unknown 4xx-shaped exception: still warn-worthy because the filter
    // didn't have a specific mapping for it.
    this.logger.warn(`${prefix} ${message}`, stack);
  }
}
