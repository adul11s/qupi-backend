import { Global, Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { OUTBOX_STORE } from './outbox.store';
import { OutboxService } from './outbox.service';
import { PrismaOutboxStore } from './prisma-outbox.store';

export { OUTBOX_STORE } from './outbox.store';

@Global()
@Module({
  providers: [
    {
      provide: OUTBOX_STORE,
      useFactory: (db: PrismaService) => new PrismaOutboxStore(db),
      inject: [PrismaService],
    },
    OutboxService,
  ],
  exports: [OutboxService, OUTBOX_STORE],
})
export class OutboxModule {}
