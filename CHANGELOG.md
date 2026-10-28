# Changelog

## [1.0.0] — 2026-10-28

First tagged release of the QUPI backend: a modular-monolith **NestJS 11 + Prisma** service for a wallet and paylater product.

### Domain
- Double-entry ledger as the single source of truth, with a universal balance invariant enforced by tests (57/57 green).
- Idempotency keys with request-fingerprint binding — a replayed key with a different body returns `409` instead of double-charging.
- PIN and OTP stored with **scrypt + per-record salt** (legacy `sha256` rows are migrated automatically on login).
- Global session guard, HMAC-signed internal callbacks, PIN lockout, audit log, reconciliation job and outbox pattern.
- QRIS payment resolves to a **single** operation (balance *or* paylater) — never a double debit.

### API & docs
- OpenAPI specification for the public surface.
- Domain-scoped modules: identity, wallet, payment, credit, admin, queue, risk, common.

### Quality
- e2e suite runs against **real PostgreSQL and Redis service containers** in CI, not mocks.
- Honest benchmark harness: **2,400 requests, 0 errors**; loader limitations documented rather than hidden.
- `strict: true` TypeScript, ESLint over `src/` and `tests/`, versioned Prisma migrations.

### Known gaps
Listed in the README under *Known gaps* — read that before assuming production readiness.
