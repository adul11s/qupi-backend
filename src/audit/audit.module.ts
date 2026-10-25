import { Global, Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AUDIT_STORE } from './audit.store';
import { AuditService } from './audit.service';
import { InMemoryAuditStore } from './in-memory-audit.store';
import { PrismaAuditStore } from './prisma-audit.store';

// AUDIT_STORE: prisma di runtime App; in-memory dipakai langsung di unit test.
@Global()
@Module({
  providers: [
    {
      provide: AUDIT_STORE,
      useFactory: (db: PrismaService) => new PrismaAuditStore(db),
      inject: [PrismaService],
    },
    AuditService,
  ],
  exports: [AuditService, AUDIT_STORE],
})
export class AuditModule {}

// Fallback in-memory module untuk unit test tanpa Postgres:
export const inMemoryAuditProviders = [
  { provide: AUDIT_STORE, useFactory: () => new InMemoryAuditStore() },
  AuditService,
];
