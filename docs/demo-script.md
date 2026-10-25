# Demo 5 Menit — QUPI Backend

## Persiapan (sebelum demo)

```bash
cp .env.example .env && docker compose up -d && npm install
npm run db:push && npm run seed
npm run start:dev
```

Kredensial: **user** `628123456789` PIN `123456` • **admin** `62899000` PIN `123456`
Semua request: header `Content-Type: application/json` (user endpoint memakai header session dari login).

## 0:00–0:45 — Register & login

```bash
# register (biarkan OTP dikirim ke log server, atau aktifkan OTP_DEBUG untuk debug lokal)
curl -X POST localhost:3000/identity/register -H 'Content-Type: application/json' \
  -d '{"phone":"628123456789","name":"Demo","pin":"123456"}'
# login
curl -X POST localhost:3000/identity/login -H 'Content-Type: application/json' \
  -d '{"phone":"628123456789","pin":"123456"}'
```

## 0:45–1:30 — Topup

```bash
TID=<transaction-id>
curl -X POST localhost:3000/wallet/topup -H 'Content-Type: application/json' \
  -d '{"amount":500000,"idempotencyKey":"demo-topup-1"}'
# uji idempotency: kirim ulang dengan key sama → hasil sama, saldo tetap
curl localhost:3000/wallet/balance
```

## 1:30–2:15 — Transfer (dalam) + idempotency

```bash
curl -X POST localhost:3000/wallet/transfer -H 'Content-Type: application/json' \
  -d '{"toPhone":"628123456790","amount":50000,"note":"demo","idempotencyKey":"demo-trf-1"}'
# kirim ulang dengan key sama → tepat satu ledger entry; beda intent → 409 IDEM_CONFLICT
curl localhost:3000/wallet/history
```

## 2:15–3:00 — QRIS

```bash
curl -X POST localhost:3000/payment/qris -H 'Content-Type: application/json' \
  -d '{"amount":250000,"merchantId":"M-DEMO"}'   # max 2jt, velocity 20/hari
Q=<qris-id>
curl -X POST localhost:3000/payment/qris/$Q/pay -H 'Content-Type: application/json' -d '{}'
curl localhost:3000/payment/qris/$Q
```

## 3:00–3:45 — Tagihan PLN/pulsa/data

```bash
curl -X POST localhost:3000/payment/bills/inquiry -H 'Content-Type: application/json' \
  -d '{"type":"PLN","ref":"1234567890"}'
curl -X POST localhost:3000/payment/bills/pay -H 'Content-Type: application/json' \
  -d '{"type":"PLN","ref":"1234567890","idempotencyKey":"demo-bill-1"}'
```

## 3:45–4:30 — PayLater checkout

```bash
curl localhost:3000/credit/paylater/limit                        # limit gaji x 2.5 plafon 15jt
curl -X POST localhost:3000/credit/paylater/checkout -H 'Content-Type: application/json' \
  -d '{"amount":1000000,"tenor":6}'                              # DTI 25% dicek di sini
```

## 4:30–5:00 — Bayar cicilan + admin

```bash
curl -X POST localhost:3000/credit/paylater/installments/<id>/pay -H 'Content-Type: application/json' \
  -d '{"idempotencyKey":"demo-inst-1"}'

# sisi admin: login sebagai 62899000, review KYC (approve) dan verifikasi penghasilan Tier 2
curl -X PATCH localhost:3000/admin/kyc/documents/<documentId> -H 'Content-Type: application/json' \
  -d '{"decision":"approved"}'
curl -X POST localhost:3000/admin/users/<userId>/income -H 'Content-Type: application/json' \
  -d '{"monthlyIncome":2000000}'
```

## Titik highlight demo

- Idempotency replay/hapus: topup atau transfer dengan key sama — tepat satu ledger entry.
- `IDEM_CONFLICT`: kirim lagi transfer dengan key sama tetapi intent beda → 409.
- DTI: checkout paylater melebihi 25% penghasilan → 400 `DTI_EXCEEDED`.
- Ledger invariant: saldo = jumlah ledger di `wallet/history`.
