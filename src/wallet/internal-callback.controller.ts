import { Body, Controller, ForbiddenException, Param, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { Public } from '../common/session.guard';
import { DomainError } from '../common/errors';
import { WalletService } from './wallet.service';

// Fase-3 #1: callback provider pindah ke webhook internal — TIDAK di jalur user
// (tanpa x-session-token), wajib verifikasi HMAC-SHA256 atas body RAW.
// Secret dari env WALLET_CALLBACK_SECRET — FAIL-CLOSED fase-4 #1: tanpa secret
// (kosong/tidak di-set) setiap callback ditolak 403, tidak ada default dev.
const SECRET_MISSING = 'WALLET_CALLBACK_SECRET belum di-set di env (fail-closed)';
export const callbackSecretConfigured = (): boolean => typeof process.env.WALLET_CALLBACK_SECRET === 'string' && process.env.WALLET_CALLBACK_SECRET.length > 0;

@Public()
@Controller('internal/callback')
export class InternalCallbackController {
  constructor(private readonly wallet: WalletService) {}

  @Post('topup/:tid')
  async topupCallback(
    @Req() req: Request & { rawBody?: Buffer },
    @Param('tid') tid: string,
    @Body() body: { status?: 'SUCCESS' | 'FAILED' },
  ) {
    const secret = process.env.WALLET_CALLBACK_SECRET;
    if (!secret || secret.length === 0) throw new ForbiddenException(SECRET_MISSING);
    const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(JSON.stringify(body ?? {}));
    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    const got = req.headers['x-internal-signature'];
    const gotStr = typeof got === 'string' ? got : Array.isArray(got) ? got[0] : '';
    const okLen = expected.length === gotStr.length;
    const ok = okLen && timingSafeEqual(Buffer.from(expected), Buffer.from(gotStr));
    if (!ok) throw new ForbiddenException('INVALID_SIGNATURE');
    if (body.status !== 'SUCCESS' && body.status !== 'FAILED') {
      throw new DomainError('STATUS_INVALID', 'status wajib SUCCESS atau FAILED', 400 as never);
    }
    return this.wallet.topupCallback(tid, body.status);
  }
}
