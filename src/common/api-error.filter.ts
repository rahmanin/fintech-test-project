import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { MoneyError } from '../money/money.errors';
import { DomainError } from '../programs/programs.errors';

/** Every error response has this shape, whatever raised it. */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Domain and money error codes → HTTP status. Codes not listed here are
 * programming errors (e.g. CURRENCY_MISMATCH) and surface as 500 without
 * leaking their message.
 */
const STATUS_BY_CODE: Readonly<Record<string, HttpStatus>> = {
  PROGRAM_NOT_FOUND: HttpStatus.NOT_FOUND,
  RESERVATION_NOT_FOUND: HttpStatus.NOT_FOUND,
  INSUFFICIENT_CAPACITY: HttpStatus.CONFLICT,
  IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
  UNSUPPORTED_CURRENCY: HttpStatus.UNPROCESSABLE_ENTITY,
  AMOUNT_TOO_SMALL: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_AMOUNT_FORMAT: HttpStatus.BAD_REQUEST,
  INVALID_AMOUNT_SCALE: HttpStatus.BAD_REQUEST,
  AMOUNT_OUT_OF_RANGE: HttpStatus.BAD_REQUEST,
};

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.toResponse(exception);
    if (status >= 500) this.logger.error(exception);
    response.status(status).json(body);
  }

  private toResponse(exception: unknown): { status: number; body: ApiErrorBody } {
    if (exception instanceof DomainError || exception instanceof MoneyError) {
      const status = STATUS_BY_CODE[exception.code];
      if (status !== undefined) {
        const details = exception instanceof DomainError ? exception.details : undefined;
        return { status, body: { code: exception.code, message: exception.message, details } };
      }
      return internal();
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      // ValidationPipe puts its messages in `message` as string[]; keep them as details.
      const messages =
        typeof raw === 'object' &&
        raw !== null &&
        Array.isArray((raw as { message?: unknown }).message)
          ? (raw as { message: string[] }).message
          : undefined;
      return {
        status,
        body: {
          code: codeForStatus(status),
          message: messages ? 'Request validation failed' : exception.message,
          details: messages ? { messages } : undefined,
        },
      };
    }

    return internal();
  }
}

function internal(): { status: number; body: ApiErrorBody } {
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
  };
}

const CODE_BY_STATUS: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'VALIDATION_ERROR',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
};

function codeForStatus(status: number): string {
  return CODE_BY_STATUS[status] ?? 'HTTP_ERROR';
}
