/* eslint-disable */
import { PrismaService } from '../src/common/prisma.service';
import { ReconciliationService, PrismaReconSource } from '../src/reconciliation/reconciliation.service';

const main = async () => {
  process.env.RECON_OUTPUT_DIR ??= 'data'; // default output dir (gitignored)
  const db = new PrismaService();
  await db.$connect();
  try {
    const source = new PrismaReconSource(db);
    const svc = new ReconciliationService(source, db);
    const report = await svc.run();
    console.log(JSON.stringify(report, null, 2));
    console.log(`balanced=${report.balanced}, differences=${report.differences.length}`);
    process.exitCode = report.balanced ? 0 : 1; // selisih != 0 → exit gagal (utk ci/spesial cron)
  } finally {
    await db.$disconnect();
  }
};

void main().catch((e) => {
  console.error(e);
  process.exitCode = 2;
});
