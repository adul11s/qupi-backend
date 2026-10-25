# ADR 004 — Monolith modular, bukan microservices

**Status:** Accepted

## Context

Backend mencakup identity, wallet, payment, credit, risk, admin — di pilot, volume transaksi dan ukuran tim kecil. Microservices menambah biaya operasi yang belum dibutuhkan (deploy terpisah, jaringan antar-servis, distributed tracing, distributed transactions).

## Decision

Satu aplikasi NestJS dengan boundary di level modul (`src/<modul>`), antar-modul komunikasi lewat service contract di dalam proses. Store/adapter interface (wallet store, identity repo) dipisahkan agar logika service tetap sama bila adapter berganti.

## Consequences

- Bisa demo, test, dan deploy nyaman; test in-memory terjadi cepat tanpa DB.
- Boundary yang tidak dijaga bisa erosi — disiplin review dibutuhkan agar tidak ada akses tabel lintas-modul.
- Ekstraksi jadi servis terpisah lebih mudah bila boundary sudah rapi, namun bukan tanpa biaya (data migration, kontrak API eksternal).
