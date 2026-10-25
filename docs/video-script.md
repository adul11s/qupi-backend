# Video Script — QUPI fintech (90 detik, 1 take list)

**Format:** screen recording 1920×1080, 90 detik. Voice-over bahasa lalu siap dirilis; bisa tanpa voice (subtitle).
**Studio setup:** backend jalan (`PORT=4000 OTP_DEBUG=1 node dist/src/main.js`), frontend `npm run dev` → container :3000, wallet :3003; data demo sudah rapi seed.
**Demo login:** 628123456789 / PIN 123456 (OTP tampil di log karena OTP_DEBUG).

| # | Detik | Layar | Subtitle / VO |
|---|---|---|---|
| 1 | 0–6 | Halaman utama container :3000 dengan banner Sandbox | "QUPI — dompet digital & paylater, dibangun end-to-end." |
| 2 | 6–14 | Landing → login (HP + OTP) | "Login OTP, PIN di-hash scrypt, sesi server-side dengan idle 15 menit." |
| 3 | 14–26 | Topup 500.000 → saldo bertambah | "Topup lewat callback internal yang ditandatangani HMAC; ledger double-entry, saldonya dihitung dari ledger." |
| 4 | 26–36 | Transfer 100.000 ke user lain → riwayat 2 entri ledger | "Setiap perpindahan uang menulis debit & kredit berpasangan — invariant Σdebit=Σkredit dites CI." |
| 5 | 36–46 | QRIS scan → bayar pakai saldo | "QRIS pakai idempotency key + fingerprint. Kirim dobel menabrak 409 IDEM_CONFLICT, bukan kredit dua kali." |
| 6 | 46–56 | Tagihan → checkout paylater → cicilan | "Paylater melewati limit check: gaji×2.5, tier 10/20 jt, DTI 25 persen dari verified income." |
| 7 | 56–66 | Terminal: recount 50 transfer paralel → 20 sukses / 30×409, saldo tetap benar | "Stres: 50 pembayaran paralel, tidak ada saldo yang minus." |
| 8 | 66–78 | Halaman GitHub CI hijau + file `test/e2e.pg.spec.ts` | "16 end-to-end uji melawan Postgres asli — terbukti hijau di CI, bukan klaim." |
| 9 | 78–90 | README: Known gaps section | "Sisanya deskriptaz jujur di Known gaps: provider stub, antrean in-memory. Detail angka & cara reproduce ada di README." |

**Hasil rekaman harus:** setiap aksi selesai sukses (tidak cut di tengah error), kursor mudah diikuti, zoom 110% pada saldo/selisih penting.
**Post:** trim, subtitle burn-in, ekspor 1080p (mp4 H.264), tempat simpan: `docs/video/`.
