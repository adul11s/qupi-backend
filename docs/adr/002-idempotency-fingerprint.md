# ADR 002 — Idempotency key + fingerprint dengan IDEM_CONFLICT

**Status:** Accepted

## Context

Jaringan yang tidak reliable membuat klien melakukan retry pada operasi uang (topup, transfer, QRIS pay, cicilan). Tanpa perisai, satu klik ganda bisa menghasilkan dua debit ledger. Sekadar key idempotency tanpa binding konten juga berbahaya: key dipakai-ulang dengan intent berbeda bisa menyebabkan salah-debit.

## Decision

Operasi uang berbahaya menerima `Idempotency-Key` yang tersimpan berikut fingerprint intent (tipe transaksi, akun tujuan, jumlah). Replay dengan fingerprint sama mengembalikan hasil asli — tepat satu ledger entry. Key dipakai untuk intent berbeda → `409 IDEM_CONFLICT`, tidak di-replay.

## Consequences

- Double-submit dari retry aman: tepat satu ledger entry per intent.
- Disiplin klien menetapkan key baru per intent; key yang direset di tengah intent berbeda akan ditolak server.
- Tabel idempotency bertumbuh; perlu proses housekeeping/retention di produksi.
