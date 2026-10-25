# Threat Model — qupi-backend (pilot fintech)

**Scope:** dompet digital + paylater pilot (QUPI). Termination local HTTP; Postgres; Nest monolith modular.

## Assets
- Ledger (source of truth saldo, double-entry)
- KTP upload (KYC)
- Session tokens (15 menit idle)
- Admin capability (KYC approve, income, refund)

## Actors
- User (pemilik wallet)
- B user (akun lain)
- Admin
- Attacker luar (token/enum/replay)
- Provider stub (BKI, QRIS, bills)

## Attack paths & mitigasi (masing-masing dengan test)
| Jalur | Mitigasi | Test |
|---|---|---|
| ATO (OTP brute) | OTP 5×/menit, TTL 5 menit, scrypt PIN | `identity` unit + PG e2e pin lock |
| PIN brute | `failedPinAttempts` counter + lock (403 PIN_LOCKED), per-user mutex verifikasi | `identity.lockout.spec.ts`, `e2e.pg` PIN lock |
| IDOR lintas user | Otorisasi owner-only (tx/tagihan/kyc/QRIS) | `matriks IDOR` di `e2e.pg.spec.ts` |
| Replay webhook | HMAC-SHA256 atas raw body (fail-closed secret) + idempotensi ledger | `e2e.pg` HMAC + replay, `chaos.spec` webhook ganda |
| Idem replay lintas payload | fingerprint binding (userId+kind+amount+counterparty) → 409 IDEM_CONFLICT | `idempotency.spec`, `e2e.pg` |
| Saldo minus paralel | FOR UPDATE + saldo via ledger; 50 transfer paralel → tepat 20 sukses | `e2e.pg` konkurensi |
| Ledger dasar termutilasi | Invariant Σdebit == Σkredit per transaksi (+ suspense vault funding eksternal & clearing payout (invariant universal)) | `ledger-invariant.spec.ts`, `e2e.pg` invariant |
| Enumerasi admin | `AdminRoleGuard` (isAdmin), audit log append-only | `e2e.pg` admin matrix, `audit.spec.ts` |
| Risk bypass | risk.evaluate sebelum debit (QRIS cap 2jt, velocity harian, transfer safety cap) | `risk.rules.spec.ts`, `e2e.pg` RISK_BLOCK |
| KTP bocor | untracked `uploads/`, riwayat git sudah dibersihkan (filter+force-push), content-type/size guard | setup `git log` + FE client guard |

## Known gaps (jujur)
- OTP masih **OTP_DEBUG** (kode di response) — provider SMS nyata belum ada.
- Transport TLS diasumsikan di depan (nginx) — lokal HTTP.
- Audit log admin unauthenticated read tidak diekspos — hanya via admin session.
