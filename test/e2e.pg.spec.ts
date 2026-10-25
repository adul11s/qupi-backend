import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module';
import { PrismaClient, KycStatus } from '@prisma/client';
import { createHmac, randomInt } from 'crypto';
import { execSync } from 'child_process';
import { join } from 'path';

// Checklist 3: suite INTEGRASI dengan Postgres ASLI (bukan adapter in-memory).
// - CI: service postgres:16 (.github/workflows/ci.yml) menjalankan `prisma db
//   push` lalu test dengan RUN_PG_TESTS=1 → seluruh suite ini dieksekusi.
// - Lokal tanpa Postgres: dilompati otomatis (RUN_PG_TESTS tidak diset) sehingga
//   unit test in-memory tetap hijau. Butuh OTP_DEBUG=1 agar kode OTP terbaca.
const RUN = process.env.RUN_PG_TESTS === '1';
const itIf = RUN ? it : it.skip;

jest.setTimeout(180_000);

if (RUN) {
  // schema Prisma didorong ke Postgres sungguhan sebelum app naik.
  execSync('npx prisma db push --skip-generate', { stdio: 'inherit', env: process.env, cwd: join(__dirname, '..') });
}

let app: NestExpressApplication;
let db: PrismaClient;
let url = '';

interface ApiRes { status: number; json: unknown }

const body = (j: unknown): Record<string, unknown> => (j ?? {}) as Record<string, unknown>;

const api = async (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  payload: Record<string, unknown> | undefined,
  token?: string,
  headers: Record<string, string> = {},
): Promise<ApiRes> => {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-session-token': token } : {}), ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = {};
  }
  return { status: res.status, json };
};

const post = (p: string, payload: Record<string, unknown> | undefined, token?: string, headers?: Record<string, string>) => api('POST', p, payload, token, headers);

const uniquePhone = () => `6281${String(randomInt(1_000_000_000, 9_999_999_999))}`;

// Provision user penuh: register → OTP (kode via OTP_DEBUG) → set PIN → login PIN.
const provisionUser = async (phone: string, name: string): Promise<{ userId: string; token: string }> => {
  const reg = await post('/api/identity/register', { phone, name });
  if (reg.status !== 201) throw new Error(`register gagal: ${JSON.stringify(reg.json)}`);
  const userId = body(body(reg.json).data).id as string;
  const otpReq = await post('/api/identity/otp/request', { phone, purpose: 'LOGIN' });
  const code = body(otpReq.json).otp as string | undefined;
  if (otpReq.status !== 201 || !code) throw new Error(`otp/request gagal (cek OTP_DEBUG=1): ${JSON.stringify(otpReq.json)}`);
  const verified = await post('/api/identity/otp/verify', { userId, purpose: 'LOGIN', code });
  const bootstrapToken = body(body(verified.json).data).sessionToken as string | undefined;
  if (!bootstrapToken) throw new Error(`otp/verify tidak mengembalikan sesi: ${JSON.stringify(verified.json)}`);
  const setPin = await post('/api/identity/pin/set', { pin: '123456' }, bootstrapToken);
  if (setPin.status !== 201) throw new Error(`pin/set gagal: ${JSON.stringify(setPin.json)}`);
  const login = await post('/api/identity/login', { phone, pin: '123456' });
  const token = body(body(login.json).data).sessionToken as string | undefined;
  if (login.status !== 201 || !token) throw new Error(`login gagal: ${JSON.stringify(login.json)}`);
  return { userId, token };
};

describe('Integrasi Postgres: alur uang kritis', () => {
  beforeAll(async () => {
    if (!RUN) return;
    db = new PrismaClient();
    await db.$connect();
    await db.ledgerEntry.deleteMany();
    await db.payLaterInstallment.deleteMany();
    await db.payLaterTx.deleteMany();
    await db.qrisPayment.deleteMany();
    await db.bill.deleteMany();
    await db.transaction.deleteMany();
    await db.kycDocument.deleteMany();
    await db.payLaterLine.deleteMany();
    await db.session.deleteMany();
    await db.otpCode.deleteMany();
    await db.loginAttempt.deleteMany();
    await db.walletAccount.deleteMany();
    await db.user.deleteMany();

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api');
    // bootstrap harus identik dengan src/main.ts — tanpa ini, validasi dan
    // error-shape berbeda dari server asli (root cause 8 test gagal di CI).
    const { ValidationPipe } = await import('@nestjs/common');
    const { DomainErrorFilter } = await import('../src/common/domain-error.filter');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: false }));
    app.useGlobalFilters(new DomainErrorFilter());
    app.enableCors({ origin: true, credentials: true });
    app.use(await import('express').then((m) => m.json({
      limit: '6mb',
      verify: (req: unknown, _res: unknown, buf: Buffer) => { (req as { rawBody?: Buffer }).rawBody = buf; },
    })));
    await app.init();
    await app.listen(0, '127.0.0.1');
    const srv = app.getHttpServer() as unknown as { address: () => { port: number } };
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : 3000;
    url = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (!RUN) return;
    await app.close();
    await db.$disconnect();
  });

  // === Setup shared: user A, B, admin ===
  let a = { userId: '', token: '', phone: '' };
  let b = { userId: '', token: '', phone: '' };
  let adminToken = '';

  itIf('app hidup di atas Postgres asli', async () => {
    const noAuth = await api('GET', '/api/wallet/balance', undefined, undefined);
    expect(noAuth.status).toBe(401); // SessionGuard jalan
    const badAuth = await api('GET', '/api/wallet/balance', undefined, 'token-palsu');
    expect(badAuth.status).toBe(401);
    expect(await db.user.count()).toBe(0);
    // simpan port dinamis untuk subsesi
    const os = await import('os');
    void os;
  });

  itIf('setup: provision user A, B, dan admin', async () => {
    a.phone = uniquePhone();
    b.phone = uniquePhone();
    a = { ...a, ...(await provisionUser(a.phone, 'Andi A')) };
    b = { ...b, ...(await provisionUser(b.phone, 'Budi B')) };
    expect(a.token).toBeTruthy();
    expect(b.token).toBeTruthy();
    // admin: user kedua dipromosikan langsung lewat DB (kredensial admin terkunci di luar e2e)
    const adminPhone = uniquePhone();
    const admin = await provisionUser(adminPhone, 'Admin Root');
    await db.user.update({ where: { id: admin.userId }, data: { isAdmin: true } });
    adminToken = admin.token;
    expect(adminToken).toBeTruthy();
  });

  itIf('topup A 2jt & B 500k: ledger terisi, saldo terbaca', async () => {
    const r1 = await post('/api/wallet/topup', { amount: 2_000_000, pin: '123456', idempotencyKey: 'e2e-topup-a-1' }, a.token);
    expect(r1.status).toBe(201);
    const rB = await post('/api/wallet/topup', { amount: 500_000, pin: '123456', idempotencyKey: 'e2e-topup-b-1' }, b.token);
    expect(rB.status).toBe(201);
    const balA = body(body((await api('GET', '/api/wallet/balance', undefined, a.token)).json).data).balance as number;
    const balB = body(body((await api('GET', '/api/wallet/balance', undefined, b.token)).json).data).balance as number;
    expect(balA).toBe(2_000_000);
    expect(balB).toBe(500_000);
  });

  itIf('transfer A→B 100k: pin benar, saldo bergerak', async () => {
    const r = await post('/api/wallet/transfer', { toUserId: b.userId, amount: 100_000, pin: '123456', idempotencyKey: 'e2e-trf-ab-1' }, a.token);
    expect(r.status).toBe(201);
    const balA = body(body((await api('GET', '/api/wallet/balance', undefined, a.token)).json).data).balance as number;
    const balB = body(body((await api('GET', '/api/wallet/balance', undefined, b.token)).json).data).balance as number;
    expect(balA).toBe(1_900_000);
    expect(balB).toBe(600_000);
  });

  itIf('idempotency di Postgres: key sama payload sama → replay; key sama payload beda → 409 IDEM_CONFLICT', async () => {
    const r1 = await post('/api/wallet/transfer', { toUserId: b.userId, amount: 11_000, pin: '123456', idempotencyKey: 'e2e-idem-1' }, a.token);
    expect(r1.status).toBe(201);
    const r2 = await post('/api/wallet/transfer', { toUserId: b.userId, amount: 11_000, pin: '123456', idempotencyKey: 'e2e-idem-1' }, a.token);
    expect(r2.status).toBe(201); // replay idempoten
    const r3 = await post('/api/wallet/transfer', { toUserId: b.userId, amount: 12_000, pin: '123456', idempotencyKey: 'e2e-idem-1' }, a.token);
    expect(r3.status).toBe(409);
    expect(body(r3.json).code).toBe('IDEM_CONFLICT');
    const balA = body(body((await api('GET', '/api/wallet/balance', undefined, a.token)).json).data).balance as number;
    expect(balA).toBe(1_900_000 - 11_000); // sekali saja
  });

  itIf('matriks IDOR: B membaca transaksi A → 403; endpoint admin via token user → 403; token admin → 200', async () => {
    const histA = await api('GET', '/api/wallet/history?limit=5', undefined, a.token);
    expect(histA.status).toBe(200);
    const items = body(body(histA.json).data).items as { transactionId: string }[];
    expect(items.length).toBeGreaterThan(0);
    const tidA = items[0].transactionId;
    const resB = await api('GET', `/api/wallet/transactions/${tidA}`, undefined, b.token);
    expect(resB.status).toBe(403);
    const noAdmin = await api('GET', '/api/admin/kyc/documents', undefined, a.token);
    expect(noAdmin.status).toBe(403);
    const yesAdmin = await api('GET', '/api/admin/kyc/documents', undefined, adminToken);
    expect(yesAdmin.status).toBe(200);
  });

  itIf('matriks IDOR: B membayar tagihan inquiry milik A → 403', async () => {
    const inq = await post('/api/payment/bills/inquiry', { provider: 'PLN', number: '5432109876' }, a.token);
    expect(inq.status).toBe(201);
    const inquiryId = body(body(inq.json).data).inquiryId as string;
    const wrongUser = await post('/api/payment/bills/pay', { inquiryId, method: 'BALANCE', pin: '123456', idempotencyKey: 'e2e-bill-idor' }, b.token);
    expect(wrongUser.status).toBe(403);
    // inquiry idempotent: inquiry ulang mengembalikan inquiry yang sama
    const again = await post('/api/payment/bills/inquiry', { provider: 'PLN', number: '5432109876' }, a.token);
    expect(body(body(again.json).data).inquiryId).toBe(inquiryId);
  });

  let dPl = { userId: '', token: '' };

  itIf('DTI 25%: checkout paylater melebihi 25% penghasilan → 400 DTI_EXCEEDED; di bawah → sukses', async () => {
    dPl = { ...dPl, ...(await provisionUser(uniquePhone(), 'Dimas D')) };
    const kyc = await db.kycDocument.create({ data: { userId: dPl.userId, kind: 'KTP', fileUrl: '/tmp/e2e.jpg', status: KycStatus.APPROVED } });
    expect(kyc.status).toBe(KycStatus.APPROVED);
    const income = await post(`/api/admin/users/${dPl.userId}/income`, { verifiedIncome: 1_000_000 }, adminToken);
    expect(income.status).toBe(201);
    const activate = await post('/api/credit/paylater/activate', { pin: '123456' }, dPl.token);
    expect(activate.status).toBe(201);
    const lim = body(body((await api('GET', '/api/credit/paylater/limit', undefined, dPl.token)).json).data).limit as number;
    expect(lim).toBe(2_500_000); // gaji 1jt × 2.5
    // gagal: 800rb tenor 3 → cicilan ≈274.667 > 250rb (25%)
    const bad = await post('/api/credit/paylater/checkout', { amount: 800_000, tenorMonths: 3, idempotencyKey: 'e2e-dti-bad', pin: '123456' }, dPl.token);
    expect(bad.status).toBe(400);
    expect(body(bad.json).code).toBe('DTI_EXCEEDED');
    // sukses: 450rb tenor 3 → cicilan ≈154.500 ≤ 250rb
    const ok = await post('/api/credit/paylater/checkout', { amount: 450_000, tenorMonths: 3, idempotencyKey: 'e2e-dti-ok', pin: '123456' }, dPl.token);
    expect(ok.status).toBe(201);
    const rec = body(body((await api('GET', '/api/credit/paylater/recap', undefined, dPl.token)).json).data) as { used: number; installmentCount: number };
    expect(rec.used).toBe(450_000);
    expect(rec.installmentCount).toBe(3);
  });

  itIf('QRIS PayLater: limit paylater terpakai, saldo TIDAK tersentuh; cek QRIS milik user lain → 403', async () => {
    const d = await provisionUser(uniquePhone(), 'Dina D2');
    await db.kycDocument.create({ data: { userId: d.userId, kind: 'KTP', fileUrl: '/tmp/e2e.jpg', status: KycStatus.APPROVED } });
    await post(`/api/admin/users/${d.userId}/income`, { verifiedIncome: 2_000_000 }, adminToken);
    await post('/api/credit/paylater/activate', { pin: '123456' }, d.token);
    const mk = await post('/api/payment/qris', { amount: 120_000 }, d.token);
    expect(mk.status).toBe(201);
    const qrisId = body(body(mk.json).data).id as string;
    const stranger = await provisionUser(uniquePhone(), 'Not Owner');
    const peek = await api('GET', `/api/payment/qris/${qrisId}`, undefined, stranger.token);
    expect(peek.status).toBe(403); // IDOR QRIS
    const pay = await post(`/api/payment/qris/${qrisId}/pay`, { method: 'PAYLATER', tenorMonths: 1, pin: '123456', idempotencyKey: 'e2e-qris-pl-1' }, d.token);
    expect(pay.status).toBe(201);
    const used = body(body((await api('GET', '/api/credit/paylater/limit', undefined, d.token)).json).data).used as number;
    expect(used).toBe(120_000);
    const bal = body(body((await api('GET', '/api/wallet/balance', undefined, d.token)).json).data).balance as number;
    expect(bal).toBe(0); // saldo tidak dibayar paylater
  });

  itIf('QRIS dari saldo: PAID → settlement worker (payload {qrisId}) → SETTLED', async () => {
    const u = await provisionUser(uniquePhone(), 'Qia Qi');
    const top = await post('/api/wallet/topup', { amount: 200_000, pin: '123456', idempotencyKey: 'e2e-qris-topup-1' }, u.token);
    expect(top.status).toBe(201);
    const mk = await post('/api/payment/qris', { amount: 45_000 }, u.token);
    const qrisId = body(body(mk.json).data).id as string;
    const pay = await post(`/api/payment/qris/${qrisId}/pay`, { method: 'BALANCE', pin: '123456', idempotencyKey: 'e2e-qris-bal-1' }, u.token);
    expect(pay.status).toBe(201);
    const paid = body(body((await api('GET', `/api/payment/qris/${qrisId}`, undefined, u.token)).json).data).status as string;
    expect(['PAID', 'SETTLED']).toContain(paid); // outbox worker boleh settle sangat cepat
    // settlement worker in-process berjalan via setImmediate setelah enqueue
    await new Promise((r) => setTimeout(r, 500));
    const settled = body(body((await api('GET', `/api/payment/qris/${qrisId}`, undefined, u.token)).json).data).status as string;
    expect(settled).toBe('SETTLED');
    const bal = body(body((await api('GET', '/api/wallet/balance', undefined, u.token)).json).data).balance as number;
    expect(bal).toBe(200_000 - 45_000);
  });

  itIf('risk QRIS: 2.5jt → RISK_BLOCK 403 dan saldo tidak terpotong (eval sebelum claim/debit)', async () => {
    const u = await provisionUser(uniquePhone(), 'Rio Risk');
    const top = await post('/api/wallet/topup', { amount: 3_000_000, pin: '123456', idempotencyKey: 'risk-topup-1' }, u.token);
    expect(top.status).toBe(201);
    const mk = await post('/api/payment/qris', { amount: 2_500_000 }, u.token);
    const qrisId = body(body(mk.json).data).id as string;
    const pay = await post(`/api/payment/qris/${qrisId}/pay`, { method: 'BALANCE', pin: '123456', idempotencyKey: 'risk-qris-pay' }, u.token);
    expect(pay.status).toBe(403);
    expect(body(pay.json).code).toBe('RISK_BLOCK');
    const q = body(body((await api('GET', `/api/payment/qris/${qrisId}`, undefined, u.token)).json).data).status as string;
    expect(q).toBe('PENDING'); // claim belum terjadi
    const bal = body(body((await api('GET', '/api/wallet/balance', undefined, u.token)).json).data).balance as number;
    expect(bal).toBe(3_000_000); // tidak terpotong
  });

  itIf('batas saldo tier T1: topup melewati 10jt → SALDO_TIER_EXCEEDED', async () => {
    const u = await provisionUser(uniquePhone(), 'Tina T1');
    const t1 = await post('/api/wallet/topup', { amount: 10_000_000, pin: '123456', idempotencyKey: 'tier-check-1' }, u.token);
    expect(t1.status).toBe(201);
    const t2 = await post('/api/wallet/topup', { amount: 1, pin: '123456', idempotencyKey: 'tier-check-2' }, u.token);
    console.log('TIER_BODY', JSON.stringify(body(t2.json))); // debug
    expect([400, 409]).toContain(t2.status);
    expect(body(t2.json).code).toBe('SALDO_TIER_EXCEEDED');
    const bal = body(body((await api('GET', '/api/wallet/balance', undefined, u.token)).json).data).balance as number;
    expect(bal).toBe(10_000_000);
  });

  itIf('konkurensi: 50 transfer paralel 1rb pada saldo 20rb → tepat 20 sukses, saldo tidak pernah negatif', async () => {
    const f = await provisionUser(uniquePhone(), 'Conc F');
    const top = await post('/api/wallet/topup', { amount: 20_000, pin: '123456', idempotencyKey: 'conc-topup' }, f.token);
    expect(top.status).toBe(201);
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        post('/api/wallet/transfer', { toUserId: a.userId, amount: 1_000, pin: '123456', idempotencyKey: `conc-parallel${i}` }, f.token),
      ),
    );
    const statuses = results.map((r) => (r.status === 'fulfilled' ? (r.value as ApiRes).status : 599));
    console.log('CONC_STATUS', statuses.join(',')); // debug
    console.log('CONC_BODY0', JSON.stringify((results[0] as { value?: ApiRes }).value?.json)); // debug
    console.log('CONC_COUNTS', JSON.stringify({
      s201: statuses.filter((s) => s === 201).length, s409: statuses.filter((s) => s === 409).length,
      s403: statuses.filter((s) => s === 403).length, s400: statuses.filter((s) => s === 400).length,
    }));
    const r403 = results.filter((r) => r.status === 'fulfilled' && (r.value as ApiRes).status === 403)[0] as { value?: ApiRes } | undefined;
    const r500 = results.filter((r) => r.status === 'fulfilled' && (r.value as ApiRes).status === 500)[0] as { value?: ApiRes } | undefined;
    console.log('CONC_BODY500', JSON.stringify(r500?.value?.json));
    console.log('CONC_BODY403', JSON.stringify(r403?.value?.json));
    expect(statuses.filter((s) => s === 201).length).toBe(20);
    expect(statuses.filter((s) => s === 409).length).toBe(30); // INSUFFICIENT_BALANCE → 409 CONFLICT
    const balF = body(body((await api('GET', '/api/wallet/balance', undefined, f.token)).json).data).balance as number;
    expect(balF).toBe(0);
    const balA = body(body((await api('GET', '/api/wallet/balance', undefined, a.token)).json).data).balance as number;
    expect(balA).toBe(1_900_000 - 11_000 + 20_000); // 20 transfer sukses, tanpa dobel
  });

  itIf('invariant ledger di Postgres: setiap transaksi Σdebit == Σkredit', async () => {
    const entries = await db.ledgerEntry.groupBy({ by: ['transactionId', 'direction'], _sum: { amount: true } });
    const sums = new Map<string, { d: number; c: number }>();
    for (const e of entries) {
      const s = sums.get(e.transactionId) ?? { d: 0, c: 0 };
      if (e.direction === 'DEBIT') s.d += e._sum.amount ?? 0;
      else s.c += e._sum.amount ?? 0;
      sums.set(e.transactionId, s);
    }
    let twoSided = 0;
    for (const s of sums.values()) {
      if (s.c > 0) {
        expect(s.d).toBe(s.c);
        twoSided += 1;
      }
    }
    expect(twoSided).toBeGreaterThan(5);
  });

  itIf('PIN salah 5x di endpoint transaksi → 403 PIN_LOCKED; pin benar pun ditolak', async () => {
    const u = await provisionUser(uniquePhone(), 'Pin Pablo');
    await post('/api/wallet/topup', { amount: 10_000, pin: '123456', idempotencyKey: 'pinlock-warmup' }, u.token);
    for (let i = 0; i < 5; i++) {
      const wrong = await post('/api/wallet/topup', { amount: 1_000, pin: '999999', idempotencyKey: `pinlock-w-${i}` }, u.token);
      expect(wrong.status).toBe(400); // PIN_SALAH
    }
    const locked = await post('/api/wallet/topup', { amount: 1_000, pin: '123456', idempotencyKey: 'pinlock-correct' }, u.token);
    expect(locked.status).toBe(403); // PIN_LOCKED — pin benar ditolak selama window
  });

  itIf('Webhook callback internal: HMAC salah → 403 dan saldo tetap', async () => {
    const u = await provisionUser(uniquePhone(), 'Webhook W');
    const r = await post('/api/wallet/topup', { amount: 1_000, pin: '123456', idempotencyKey: 'wh-topup-1' }, u.token);
    expect(r.status).toBe(201);
    const tid = body(body(r.json).data).id as string;
    const before = body(body((await api('GET', '/api/wallet/balance', undefined, u.token)).json).data).balance as number;
    const sig = createHmac('sha256', 'secret-yang-salah').update(JSON.stringify({ status: 'SUCCESS' })).digest('hex');
    const bad = await api('POST', `/api/internal/callback/topup/${tid}`, { status: 'SUCCESS' }, undefined, { 'x-internal-signature': sig });
    expect(bad.status).toBe(403);
    const after = body(body((await api('GET', '/api/wallet/balance', undefined, u.token)).json).data).balance as number;
    expect(after).toBe(before);
  });
});
