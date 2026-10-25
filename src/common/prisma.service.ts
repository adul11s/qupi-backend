import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// Pool guard: tanpa connection_limit, Prisma membuka pool per proses sesuai
// CPU — di bersamaan dengan 50 request paralel + beberapa instance di mesin
// dev, Postgres kehabisan koneksi (P2037 "sorry, too many clients already").
// Limit eksplisit + pool_timeout membuat backpressure jelas (menunggu,
// bukan 500) di bawah tekanan beban; config infrastruktur, bukan logic uang.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const url = process.env.DATABASE_URL ?? '';
    if (url && !/connection_limit=/.test(url)) {
      const sep = url.includes('?') ? '&' : '?';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      super({ datasources: { db: { url: `${url}${sep}connection_limit=10&pool_timeout=15` } } } as any);
      return;
    }
    super();
  }
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
