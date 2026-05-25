/**
 * Unit tests for the global exception filter.
 *
 * The filter is the single source of truth for the BothSafe error
 * envelope, so these tests exercise the explicit examples and edge cases
 * that the contract promises to clients (task 3.6):
 *
 *   - DomainException is preserved verbatim with its code, message_key,
 *     details, and HTTP status.
 *   - Prisma's P2002 / P2025 known errors map to canonical codes and the
 *     correct HTTP status, with safe metadata forwarded.
 *   - Generic HttpException flavours (string body, validation envelope,
 *     pre-shaped envelope, foreign object) collapse to the canonical
 *     shape.
 *   - Anything else collapses to 500 / `server.internal_error` and never
 *     leaks the cause string into the response body.
 *   - Headers-already-sent path bails silently rather than re-writing.
 */

import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainException } from './errors';
import { GlobalExceptionFilter } from './global-exception.filter';

interface MockResponse {
  status: jest.Mock;
  json: jest.Mock;
  headersSent: boolean;
}

function buildHost(opts?: { headersSent?: boolean }): {
  host: ArgumentsHost;
  res: MockResponse;
} {
  const res: MockResponse = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    headersSent: opts?.headersSent ?? false,
  };
  const req = { method: 'GET', path: '/v1/test', url: '/v1/test' };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => req,
    }),
  } as unknown as ArgumentsHost;
  return { host, res };
}

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    // Silence the logger during tests — the filter is allowed (and expected)
    // to log; we just don't want it polluting the console.
    jest.spyOn(filter['logger'], 'error').mockImplementation();
    jest.spyOn(filter['logger'], 'warn').mockImplementation();
    jest.spyOn(filter['logger'], 'debug').mockImplementation();
  });

  describe('DomainException', () => {
    it('preserves code, message_key, details, and status', () => {
      const exc = DomainException.badRequest('wallet.insufficient_balance', {
        details: { available: '12.00', required: '20.00' },
      });
      const { host, res } = buildHost();

      filter.catch(exc, host);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'wallet.insufficient_balance',
          message_key: 'errors.wallet.insufficient_balance',
          details: { available: '12.00', required: '20.00' },
        },
      });
    });

    it('honours an explicit messageKey override', () => {
      const exc = DomainException.forbidden('auth.role_forbidden', {
        messageKey: 'errors.custom.override',
      });
      const { host, res } = buildHost();

      filter.catch(exc, host);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
      const body = res.json.mock.calls[0][0] as { error: { message_key: string } };
      expect(body.error.message_key).toBe('errors.custom.override');
    });

    it('omits details when not provided', () => {
      const exc = DomainException.notFound('deal.not_found');
      const { host, res } = buildHost();

      filter.catch(exc, host);

      const body = res.json.mock.calls[0][0] as {
        error: Record<string, unknown>;
      };
      expect(body.error).toEqual({
        code: 'deal.not_found',
        message_key: 'errors.deal.not_found',
      });
      expect(body.error).not.toHaveProperty('details');
    });
  });

  describe('Prisma known request errors', () => {
    it('maps P2002 (unique violation) to 409 resource.conflict with safe target metadata', () => {
      const exc = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`email`)',
        {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['email'] },
        },
      );
      const { host, res } = buildHost();

      filter.catch(exc, host);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'resource.conflict',
          message_key: 'errors.resource.conflict',
          details: { fields: ['email'] },
        },
      });
    });

    it('maps P2002 with string target to a single-element fields array', () => {
      const exc = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: 'phone' },
        },
      );
      const { host, res } = buildHost();

      filter.catch(exc, host);

      const body = res.json.mock.calls[0][0] as {
        error: { details: { fields: string[] } };
      };
      expect(body.error.details).toEqual({ fields: ['phone'] });
    });

    it('maps P2025 (record not found) to 404 resource.not_found', () => {
      const exc = new Prisma.PrismaClientKnownRequestError(
        'An operation failed because it depends on one or more records that were required but not found.',
        {
          code: 'P2025',
          clientVersion: 'test',
          meta: { cause: 'Record to update not found.' },
        },
      );
      const { host, res } = buildHost();

      filter.catch(exc, host);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'resource.not_found',
          message_key: 'errors.resource.not_found',
          details: { cause: 'Record to update not found.' },
        },
      });
    });

    it('collapses unmapped Prisma codes to 500 server.internal_error', () => {
      const exc = new Prisma.PrismaClientKnownRequestError('Some other prisma error', {
        code: 'P9999',
        clientVersion: 'test',
        meta: { secret: 'should-not-leak' },
      });
      const { host, res } = buildHost();

      filter.catch(exc, host);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'server.internal_error',
          message_key: 'errors.server.internal_error',
        },
      });
    });
  });

  describe('Generic HttpException', () => {
    it('class-validator envelope collapses to request.validation_failed', () => {
      const exc = new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: ['email must be an email', 'password is too short'],
      });
      const { host, res } = buildHost();

      filter.catch(exc, host);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'request.validation_failed',
          message_key: 'errors.request.validation_failed',
          details: {
            errors: ['email must be an email', 'password is too short'],
          },
        },
      });
    });

    it('falls back to status-keyed default code for plain string body', () => {
      const exc = new ForbiddenException('not allowed');
      const { host, res } = buildHost();

      filter.catch(exc, host);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'auth.forbidden',
          message_key: 'errors.auth.forbidden',
        },
      });
    });

    it('passes through pre-shaped error envelope verbatim', () => {
      const exc = new HttpException(
        {
          code: 'payment.invalid_state',
          message_key: 'errors.payment.invalid_state',
          details: { current: 'PAID_ESCROWED' },
        },
        HttpStatus.CONFLICT,
      );
      const { host, res } = buildHost();

      filter.catch(exc, host);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'payment.invalid_state',
          message_key: 'errors.payment.invalid_state',
          details: { current: 'PAID_ESCROWED' },
        },
      });
    });

    it('strips unknown keys from a partly-shaped HttpException body', () => {
      const exc = new HttpException(
        {
          code: 'payment.invalid_state',
          internal_secret: 'should-not-leak',
        },
        HttpStatus.CONFLICT,
      );
      const { host, res } = buildHost();

      filter.catch(exc, host);

      const body = res.json.mock.calls[0][0] as { error: Record<string, unknown> };
      expect(body.error).not.toHaveProperty('internal_secret');
      expect(body.error.code).toBe('payment.invalid_state');
    });

    it('maps NotFoundException without body to resource.not_found', () => {
      const exc = new NotFoundException();
      const { host, res } = buildHost();

      filter.catch(exc, host);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      const body = res.json.mock.calls[0][0] as { error: { code: string } };
      expect(body.error.code).toBe('resource.not_found');
    });

    it('maps 429 Too Many Requests to rate.exceeded', () => {
      const exc = new HttpException('Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
      const { host, res } = buildHost();

      filter.catch(exc, host);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.TOO_MANY_REQUESTS);
      const body = res.json.mock.calls[0][0] as { error: { code: string } };
      expect(body.error.code).toBe('rate.exceeded');
    });
  });

  describe('Generic Error and unknown throws', () => {
    it('collapses generic Error to 500 server.internal_error and does not leak the message', () => {
      const exc = new Error('database password is hunter2');
      const { host, res } = buildHost();

      filter.catch(exc, host);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'server.internal_error',
          message_key: 'errors.server.internal_error',
        },
      });
      const body = JSON.stringify(res.json.mock.calls[0][0]);
      expect(body).not.toContain('hunter2');
    });

    it('collapses non-Error throws (string, object) to 500 server.internal_error', () => {
      const { host, res } = buildHost();

      filter.catch('plain string thrown' as unknown, host);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'server.internal_error',
          message_key: 'errors.server.internal_error',
        },
      });
    });
  });

  describe('headers-already-sent', () => {
    it('does not attempt to write a response when headers are already sent', () => {
      const exc = DomainException.badRequest('deal.invalid_field');
      const { host, res } = buildHost({ headersSent: true });

      filter.catch(exc, host);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });
  });
});
