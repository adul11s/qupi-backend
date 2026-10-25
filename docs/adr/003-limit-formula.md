# ADR 003 — Formula limit paylater gaji x 2.5 plafon 15jt + DTI 25%

**Status:** Accepted

## Context

Paylater memerlukan aturan limit yang deterministik dan tidak bisa dimanipulasi. Jika limit dihitung dari akumulasi CREDIT ledger, injeksi saldo/transfer antar akun bisa mempengaruhi limit — celah cheat yang nyata di pilot.

## Decision

- Limit = penghasilan bulanan terverifikasi admin x 2.5, plafon Rp15.000.000.
- Tier 1/2 (10jt/20jt) berlaku untuk saldo wallet, bukan untuk paylater.
- Penghasilan tidak berdefault: tanpa verifikasi admin, limit tak terhitung dan aktivasi ditolak (`NO_INCOME_DATA`).
- DTI: cicilan bulanan <= 25% penghasilan, ditegakkan di semua kemungkinan paylater (checkout, cicilan) lewat `src/common/dti.ts`.

## Consequences

- Limit terlindungi dari manipulasi: tidak berasal dari mutasi ledger.
- Limit terikat pada data penghasilan yang terverifikasi, bukan pada mutasi dana.
- Ada penundaan aktivasi: user menunggu review admin penghasilan Tier 2.
- Rule-based dan statis — skoring model bila sudah tersedia dapat menggantikan nantinya.
