import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '../generated/prisma/client';

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(error: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const mapping: Record<string, [number, string]> = {
      P2002: [409, 'A record with that value already exists'],
      P2003: [409, 'The operation conflicts with related records'],
      P2025: [404, 'Resource not found'],
      P2034: [409, 'Concurrent update conflict; retry the operation'],
    };
    const [statusCode, message] = mapping[error.code] ?? [
      500,
      'Database operation failed',
    ];
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(statusCode)
      .json({ statusCode, message });
  }
}
