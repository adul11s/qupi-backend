# ADR 005 — Provider pembayaran stub + antrean in-memory

**Status:** Accepted

## Context

Integrasi vendor pembayaran (QRIS, biller) dan Redis produksi membutuhkan kontrak vendor, kredensial, dan environment nyata — tidak tersedia saat pilot/development. Tapi jalur code, task-product kepanjan, dan state machine harus tetap teruji.

## Decision

Provider pembayaran disimulasikan lewat `PROVIDER_MODE=success|fail|timeout` (`src/payment/payment.service.ts`) dengan antarmuka yang sama dengan vendor nantinya. Antrean pekerjaan berjalan dengan in-memory queue (`src/queue/queue.service.ts`) dengan BullMQ terpasang agar migrasi nanti tidak mengubah konsumen antarmuka-nya.

## Consequences

- Seluruh flow QRIS/tagihan bisa didemokan dan dipush ke semua lingkungan tanpa dependensi vendor.
- Keterbatasan: pekerjaan in-memory hilang saat restart; tidak ada retry/dead-letter.
- Produksi wajib menggantikan keduanya; stub tidak boleh tersisa di environment produksi (sama seperti `OTP_DEBUG`).
