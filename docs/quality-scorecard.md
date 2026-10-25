# Quality Scorecard — qupi-backend

Template plan-portfolio-9,5 §6. Skor jujur per 2026-10-25 (HEAD: `c1b7b40`).

| Dimensi | Bobot | Skor | Bukti |
|---|---|---|---|
| Kejujuran (README/gaps) | 10% | 9 | Known gaps jujur; next-step sinkron dgn CI; ADR 5 file |
| Kebenaran domain | 15% | 9 | Ledger invariant universal 57/57 test; conflict/pending test; concurrence 50 paralel |
| Arsitektur | 20% | 9 | Monolith modular Nest (identity/wallet/payment/credit/admin/risk/outbox/audit/recon); outbox pattern |
| Auth & abstractions | 15% | 9 | Session token, scrypt async + lockout mutex, HMAC fail-closed webhook |
| Idempotency | 10% | 9 | Key + fingerprint, 409 IDEM_CONFLICT, replay race P2002 |
| Observabilitas | 10% | 7 | Audit log append-only + recon job; metric/log terstruktur belum ada (pino TODO) |
| Demo & reproduksibilitas | 10% | 8 | demo-script 5 menit, seed demo, satu perintah; video 90 detik menyusul |
| CI | 10% | 10 | e2e real Postgres 16/16 hijau CI (run 40162230995 & terbaru); badge valid |

**Total weighted:** (9×.10)+(9×.15)+(9×.20)+(9×.15)+(9×.10)+(7×.10)+(8×.10)+(10×.10) = **8.8**
