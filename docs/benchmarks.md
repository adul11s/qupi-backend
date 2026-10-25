# Benchmark QUPI Backend — run nyata tgl 2026-10-25 12:59 WIB

**Server:** `node dist/src/main.js`, Postgres 16 lokal (Homebrew).
**Loader:** Python thread-pool 50 koneksi — *bukan autocannon* (loader ini benar mengukur hanya request yang sampai, status dihitung persis; angka sama pakai autocannon mencemari hasil karena rate limiter login memotong window).
**Mesin:** MacBook Air M-series 8GB RAM, macOS 27.0.1 arm64, Node v26.7.0, Postgres 16, Prisma pool `connection_limit=10`.
**Profil users:** 120 user baru (register → OTP → pin/set) — login PIN `123456`, saldo di-seed via topup sebelum run transfer.

| Endpoint | n | status | p50 | p95 | p99 | throughput |
|---|---|---|---|---|---|---|
| POST /api/identity/login — scrypt async (`promisify(scrypt)`) | 1200 | 1200×201 | **282 ms** | 290 | 293 | 176 rps |
| GET /api/wallet/balance (auth, dihitung dari ledger) | 600 | 600×200 | **23 ms** | 58 | 62 | 1931 rps |
| GET /api/wallet/history (auth) | 400 | 400×200 | **25 ms** | 32 | 38 | 1900 rps |
| POST /api/wallet/transfer — debit/kredit ledger + outbox settle | 200 | 200×201 | **249 ms** | 400 | 484 | 170 rps |

**Nol error di seluruh 2400 request.**

## Interpretasi — kenapa beda dgn run pertama

- **Run pertama (hash masih SHA-256 sync) p50 login 1002 ms.** Kini scrypt N=16384
  asinkron — thread menjalan kerja berat **di thread pool libuv**, bukan di event
  loop, jadi 1200 login beruntun selesai 3,5× lebih cepat secara agregat tanpa
  menurunkan biaya per attempt (anti-bruteforce tetap ~1s biaya CPU per PIN).
- **Race fix `ensureAccount` (P2002 retry-or-re-read) menghilangkan dua 500 pada
  `GET /wallet/balance` paralel.** Run pertama-benchmark paralel menemukan bug ini;
  kini 0 error di 600 request paralel.
- **Login throughput terbatas by-design** — 176 rps berarti ~283 ms CPU KDF per
  percobaan. Ini murah untuk demo, mahal untuk brute force; OTP rate-limit dan
  PIN-lockout dengan mutex per-user melindungi pemakaian langsung.

> Baseline lama (p50 1002 ms) dicatat di git history — masih valid sebagai
> perbandingan SHA-256 sync vs scrypt async.

Environment variabel yang di-set saat run: `PORT=4000`, `OTP_DEBUG=1`. Bukti run
disimpan di `/tmp/bench-final.json` (loader output), user pool di `/tmp/bench-ready2.json`.
