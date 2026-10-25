import { randomBytes, scryptSync, createHash, timingSafeEqual } from 'crypto';

// Fase-2 #1: PIN & OTP di-hash SCRYPT dengan salt per-record.
// Format baru: "scrypt$<N>$<saltHex>$<keyHex>".
// Backward-compat: hash lama = hex-64 murni (SHA-256 tanpa salt) — tetap
// diverifikasi, lalu dipanggilan (migrasi otomatis) ke scrypt saat login sukses.

const SCRYPT_N = 16384;
const SALT_LEN = 16;
const KEY_LEN = 32;

export function hashSecret(value: string): string {
  const salt = randomBytes(SALT_LEN);
  const key = scryptSync(value, salt, KEY_LEN, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function isLegacySha256(hash: string): boolean {
  return /^[0-9a-f]{64}$/.test(hash);
}

/** Tidak fungsional (mis. OTP pas) saat gagal; null bila format hash tak dikenal. */
export function verifySecret(value: string, hash: string): boolean | null {
  if (!hash) return null;
  if (hash.startsWith('scrypt$')) {
    const parts = hash.split('$');
    if (parts.length !== 4) return null;
    const n = Number(parts[1]);
    const salt = Buffer.from(parts[2], 'hex');
    const expected = Buffer.from(parts[3], 'hex');
    if (!Number.isFinite(n) || salt.length === 0 || expected.length === 0) return null;
    const candidate = scryptSync(value, salt, expected.length, { N: n });
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }
  if (isLegacySha256(hash)) {
    const candidate = createHash('sha256').update(value).digest('hex');
    const a = Buffer.from(candidate, 'hex');
    const b = Buffer.from(hash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }
  return null;
}

export function needsMigrationToScrypt(hash: string): boolean {
  return isLegacySha256(hash);
}
