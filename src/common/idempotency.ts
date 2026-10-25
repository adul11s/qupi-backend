import { createHash } from 'crypto';

// Fase-3 #2: fingerprint idempotensi — kunci idempotensi di-bind ke payload.
// Replay hanya sah jika key sama DAN fingerprint identik; kalau tidak → 409
// IDEM_CONFLICT (dilempar di wallet store / service saat replay terdeteksi).
export const makeFingerprint = (userId: string, kind: string, amount: number, counterparty: string | null | undefined): string =>
  createHash('sha256')
    .update([userId ?? '', kind, amount, counterparty ?? ''].join('|'))
    .digest('hex');
