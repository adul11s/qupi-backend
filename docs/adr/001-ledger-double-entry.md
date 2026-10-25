# ADR 001 — Ledger double-entry sebagai sumber kebenaran

**Status:** Accepted

## Context

Saldo dompet bisa berubah karena topup, transfer, paylater, cicilan, dan tagihan. Jika saldo disimpan sebagai field yang di-update, selalu ada risiko salting error, lost update, dan sulitnya audit trail.

## Decision

Semua pergerakan dana dicatat sebagai ledger entries double-entry yang immutable: pasangan debit/kredit per transaksi. Saldo tidak disimpan — saldo dihitung dari jumlah ledger. Row control memakai `SELECT ... FOR UPDATE` (atau mutex pada adapter in-memory).

## Consequences

- **Invariant universal Σdebit == Σkredit untuk SETIAP transaksi** — termasuk dana masuk/keluar eksternal via akun virtual `external-funding-suspense` (debit saat kredit) dan `external-payout-clearing` (kredit saat debit). Di-cache/diparitasikan di kedua store (Prisma & in-memory); test tanpa pengecualian (`test/ledger-invariant.spec.ts`).
- Audit trail lengkap — setiap perubahan dana dapat direkonstruksi tanpa log tambahan.
- Query saldo membutuhkan agregasi; dapat dioptimisasi dengan cache atau saldo snapshot bila menjadi bottleneck.
- Penghapusan/correction menggunakan ledger entries pembalik, bukan edit.
