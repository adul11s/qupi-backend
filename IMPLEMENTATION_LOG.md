# IMPLEMENTATION LOG — qupi-backend (Fase 1 + 2 pilot)

Semua verifikasi nyata dijalankan lokal (PostgreSQL 16 Homebrew `qupi@localhost:5432`, Redis `localhost:6379`; docker tidak tersedia di host Mac → dicatat sebagai gap infra).

## Fix DI-verifikasi sesi terakhir
- DI: `SessionService` tidak tersedia di Wallet/Payment/Credit/Admin → dibuat `src/common/session-global.module.ts` (`@Global`, provide & export PrismaService + SessionService); AdminModule import IdentityModule.
- `package.json` start: `node dist/src/main.js` (rootDir bukit ke dist/src).
- Credit: endpoint baru `GET /api/credit/paylater/installments` (list cicilan milik user — dibutuhkan halaman paylater frontend).
- KYC upload kontrak: `contentBase64` + `fileName` (bukan base64/filename).
- Idempotency key dikirim di BODY field `idempotencyKey` (bukan header).

## Unit test
`npm test` → **8/8 PASS** (otp, identity.lockout, wallet).

## E2E curl nyata (seed: register 2 user demo)
| Skenario | Hasil |
|---|---|
| register (2 user) | PASS |
| OTP request/verify + set PIN + login | PASS (`OTP_DEBUG=1` mengekspos kode) |
| KYC upload + admin approve | PASS (`Dokumen diperbarui ke status APPROVED`) |
| Top-up BKI sandbox (callback SUCCESS) → balance 1.000.000 | PASS |
| Idempotency callback kedua → saldo tetap | PASS |
| Transfer internal + dobel submit idem → saldo tetap | PASS (message `Transfer sudah pernah diproses (idempoten)`) |
| QRIS create 30 detik → pay saldo | PASS; dobel pay → error `QRIS_USED` |
| Bills inquiry PLN (idempotent) → pay BALANCE | PASS |
| Limit rule-based (KTP approved → 2.5x topup 30 hari, clamp) → `limit=5.000.000` | PASS |
| Paylater activate → checkout 3 bln (0% ≤30 hari? 1%/bln → total 618.000 / 3× 206.000) | PASS |
| Bayar cicilan #1 dari saldo → PAID; dobel → `Cicilan sudah pernah dibayar (idempoten)` | PASS |
| Recap paylater (unpaid 412.000, overdue 0) | PASS |
| Idle sesi 16 menit (clock/advance) → 401 | PASS |
| Lockout: 6x PIN salah → semua ditolak | PASS |

## Gap tersisa (pilot, disengaja)
- docker-compose tidak bisa diuji (docker tidak ada di host) — infra lokal via Homebrew.
- BullMQ asli: stub in-process (REDIS_QUEUE=1 opsional → belum diuji).
- Admin endpoint memakai SessionGuard umum (belum admin-role khusus).
- OTP belum jadi syarat wajib sebelum login PIN (login PIN berjalan sendiri — catatan keamanan fase lanjut).
