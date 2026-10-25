/**
 * Seed demo data:
 * - 2 user (Andi, Budi), PIN 123456 ter-hash
 * - wallet dengan saldo awal + entry ledger (double entry)
 * - PayLater aktif dengan limit, sebagian dipakai, 1 rencana cicilan 3 bulan
 * Jalankan: npm run seed  (butuh DATABASE_URL & Postgres berjalan)
 */
import { PrismaClient, Direction, TxKind } from '@prisma/client';
import { createHash } from 'crypto';

const prisma = new PrismaClient();
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

async function seedUser(phone: string, name: string, initialBalance: number) {
  const user = await prisma.user.upsert({
    where: { phone },
    update: {},
    create: { phone, name, pinHash: sha('123456'), status: 'ACTIVE' },
  });
  const wallet = await prisma.walletAccount.upsert({
    where: { userId: user.id },
    update: {},
    create: { userId: user.id, balance: 0 },
  });
  let idemCounter = 0;
  const makeTopup = async (amount: number, note: string) => {
    idemCounter++;
    const tx = await prisma.transaction.upsert({
      where: { idempotencyKey: `${phone}-seed-${idemCounter}` },
      update: {},
      create: { idempotencyKey: `${phone}-seed-${idemCounter}`, kind: TxKind.TOPUP, status: 'SUCCESS', amount },
    });
    await prisma.ledgerEntry.upsert({
      where: { id: `seed-ledger-${phone}-${idemCounter}` },
      update: {},
      create: {
        id: `seed-ledger-${phone}-${idemCounter}`,
        accountId: wallet.id,
        transactionId: tx.id,
        direction: Direction.CREDIT,
        amount,
      },
    });
    void note;
  };
  if (initialBalance > 0) await makeTopup(initialBalance, 'seed saldo awal');
  return { user, wallet };
}

async function seedSystemUser(id: string, name: string) {
  const existing = await prisma.user.findUnique({ where: { id } });
  if (existing) return existing;
  return prisma.user.create({
    data: { id, phone: id, name, status: 'ACTIVE' },
  });
}

async function seedPayLater(userId: string) {
  const existing = await prisma.payLaterLine.findUnique({ where: { userId } });
  if (existing) return existing;
  const line = await prisma.payLaterLine.create({
    data: { userId, limitAmount: 5_000_000, used: 0, activated: true },
  });
  const amount = 1_200_000;
  const totalInterest = Math.round((amount * 1 * 3) / 100); // 1% per bulan x 3 bulan
  const totalAmount = amount + totalInterest;
  const per = Math.round(totalAmount / 3);
  const payLaterTx = await prisma.payLaterTx.create({
    data: {
      lineId: line.id,
      amount,
      totalAmount,
      totalInterest,
      tenorMonths: 3,
      idempotencyKey: `${userId}-seed-pairlater-checkout`,
    },
  });
  for (let seq = 1; seq <= 3; seq++) {
    await prisma.payLaterInstallment.create({
      data: {
        payLaterTxId: payLaterTx.id,
        seq,
        amount: seq === 3 ? totalAmount - per * 2 : per,
        dueAt: new Date(Date.now() + seq * 30 * 24 * 3600 * 1000),
        status: seq === 1 ? 'PAID' : 'UNPAID',
      },
    });
  }
  await prisma.payLaterLine.update({ where: { id: line.id }, data: { used: amount } });
  return line;
}

async function main() {
  // user sistem: treasury paylater, treasury bill provider, merchant QRIS stub
  await seedSystemUser('paylater-treasury', 'System: PayLater Treasury');
  await seedSystemUser('bill-provider-treasury', 'System: Bill Provider Treasury');
  await seedSystemUser('MRC-STUB-001', 'Kopi Kuning (merchant stub)');
  const { user: andi } = await seedUser('628123456789', 'Andi', 1_000_000);
  const { user: budi } = await seedUser('628123456790', 'Budi', 500_000);
  await seedPayLater(andi.id);
  console.log('Seed sukses:', { users: [andi.phone, budi.phone] });
}

main().catch((e) => {
  console.error('Seed gagal:', e);
  process.exit(1);
}).finally(() => prisma.$disconnect());
