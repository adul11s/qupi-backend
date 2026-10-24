# qupi-backend

Backend **qupi** — fintech wallet + paylater — sebagai **monolith modular NestJS 11** dengan modul terpisah:

```
src/
  identity/   register, OTP (5 menit, max 3/menit), PIN 6 digit, lockout 5x salah
  wallet/     saldo, topup, transfer, ledger double-entry, idempotency, row lock
  payment/    tagihan PLN/pulsa/data (provider disimulasikan, env-switch)
  credit/     PayLater (limit, used, aktivasi) + installment 1/3/6 bulan
  risk/       stub evaluasi risiko
  admin/      stub review KYC
  queue/      BullMQ stub (Redis belum aktif, antrean simulasi di memori)
```

Teknologi: Node 22 (dicek CI), TypeScript strict, Prisma ORM, PostgreSQL, Redis+BullMQ (stub).

## Menjalankan

```bash
cp .env.example .env            # sesuaikan DATABASE_URL
docker compose up -d            # postgres + redis
npm install
npm run db:push                 # buat schema
npm run seed                    # data demo (user &i, saldo, paylater, cicilan)
npm run start:dev
```

Kredensial demo: `628123456789` / `628123456790`, PIN `123456`.

## Mapping ke Plan Task 1.1 – 2.3

| Task | Status | Bagian |
|---|---|---|
| 1.1 Boot NestJS modular, Prisma, docker-compose | ✅ | `src/app.module.ts`, `docker-compose.yml` |
| 1.2 Identity: OTP 5 menit + rate 3/menit, PIN 6 digit, lockout 5x | ✅ | `src/identity/` |
| 1.3 KYC dokumen (status pending/approved/rejected/upload_again) | ✅ schema | `prisma/schema.prisma`, review di `src/admin/` |
| 2.1 Wallet: ledger double-entry immutable, saldo = sum ledger | ✅ | `src/wallet/wallet.store.ts` |
| 2.2 Transfer + idempotency key UNIQUE + debounce double submit | ✅ + test `test/wallet.spec.ts` | `src/wallet/` |
| 2.3 Default provider simulator (`PROVIDER_MODE=success|fail|timeout`) | ✅ | `src/payment/payment.service.ts` |

Unit test tanpa Postgres: service pakai **repository interface** + **adapter in-memory dengan mutex** (semantik sama dengan `SELECT ... FOR UPDATE`), sehingga 3 skala wajib dijalankan tanpa DB:

1. Lockout setelah 5 PIN salah → `test/identity.lockout.spec.ts`
2. Idempotency double-submit transfer → tepat satu ledger entry → `test/wallet.spec.ts`
3. Debit paralel 50x → saldo tidak pernah negatif → `test/wallet.spec.ts`

**Asumsi (tested tanpa Postgres)**: adapter in-memory hanya untuk unit test; aturan row lock asli memakai
`SELECT ... FOR UPDATE` di `src/wallet/prisma-wallet.store.ts` — jalur kode/service sama, hanya store adapter yang berganti.

## CI

`.github/workflows/ci.yml`: Node 22 → `npm ci` → `prisma validate` + `generate` → `npm run lint` → `npm run build` → `npm test`.
