# Chaos — qupi-backend (hasil uji nyata, bukan karangan)

Semua item dijalankan via `test/chaos.spec.ts` (deterministic sandbox provider).

## 1. Provider timeout di tengah transaksi
- Top-up dengan `PROVIDER_MODE=timeout` → transaksi **PENDING**, tidak ada saldo.
- Webhook callback internal (`x-internal-signature` valid) kirim `SUCCESS` →
  transaksi **SUCCESS + kredi ledger** (saldo naik persis sekali).
- **Kesimpulan:** kondisi gantung dapat diselamatkan; tidak ada dana hilang.

## 2. Webhook ganda (replay)
- Helper test mengirim HMAC valid dua kali dengan body identik.
- Hasil: idempoten — **saldo tidak bertambah dua kali**; kedua respons konsisten.

## 3. Crash mid-settlement
- Settlement berjalan via **outbox pattern**: event ditulis ATOMIK dalam
  transaction POS yang sama; jika proses mati sebelum drain, event tetap PENDING.
- Restart → drain outbox → event diproses **tepat sekali** (handler idempoten,
  event gagal tetap PENDING untuk retry).
- **Kesimpulan:** tidak ada saldo menggantung; at-least-once delivery dengan
  dedupe idempoten = exactly-once efek pada ledger.

## 4. Audit antar-susunan
- Baris audit **append-only** — percobaan update/delete ditolak (test).

## How to reproduce
```bash
RUN_PG_TESTS=0 npm test -- test/chaos.spec.ts
```
Laporan rekonsiliasi hidup: `npx ts-node scripts/reconcile.ts`
(balanced=true, differences=[] pada DB demo — lihat docs/reconciliation-sample.json).
