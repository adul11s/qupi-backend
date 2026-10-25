import { ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: HttpStatus = HttpStatus.CONFLICT,
  ) {
    super(message);
  }
}

export const forbidden = (msg: string) => new ForbiddenException(msg);

export const isDomainError = (e: unknown): e is DomainError =>
  e instanceof DomainError || (e instanceof HttpException && e instanceof DomainError);
