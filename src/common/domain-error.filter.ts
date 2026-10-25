import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { DomainError } from './errors';

// Kembalikan error domain dalam bentuk {code, message} konsisten.
@Catch(DomainError)
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: DomainError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse();
    res.status(exception.status ?? 409).json({
      error: true,
      code: exception.code,
      message: exception.message,
    });
  }
}
