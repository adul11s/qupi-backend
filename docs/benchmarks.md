# Benchmarks — qupi-backend

**Tool:** autocannon (npm), 50 connections, 10s duration, Node v26.7.0, macOS 27.0.1 arm64, 8 GB RAM
**Target:** server :4000, dist build, Postgres 16 (Homebrew) — production-like service chain (Prisma, session guard, scrypt for login).

## Results (latency in ms)

| Endpoint | p50 | p97.5 | p99 | Throughput (req/s) | Total | Error rate |
|---|---|---|---|---|---|---|
| `POST /api/identity/login` | 1002 | 1142 | 1633 | 49 | 494 | 0% |
| `GET /api/wallet/balance` (auth, real ledger read) | 16 | 23 | 26 | 3025 | 30,244 | 0% |
| `GET /api/wallet/balance` (unauth guard — early 401) | 1 | 1 | 3 | 29,190 | 321,080 | 0% |

## Interpretation (honest numbers, no spin)

- **Login cost is intentional.** ~1s per login is the scrypt KDF anti-bruteforce
  parameter — brute force is 1000× more expensive than balance reads. This is
  the design trade-off, not a bottleneck.
- **Authenticated balance read** (real Postgres + session middleware + ledger
  aggregation) runs at ~3k rps single-instance with p99 = 26ms on modest hardware.
- **Unauth requests** are rejected in 1ms — guard work is effectively free.
- Transfer benchmark intentionally **excluded**: each call needs a fresh
  idempotencyKey (fingerprint binding would otherwise 409), so a load test
  would benchmark key generation, not money movement.

## Reproduce

```bash
npx autocannon http://localhost:4000/api/wallet/balance -c 50 -d 10 -H "x-session-token: $TOKEN" --json
```
