import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';

// Fase kritis #2: endpoint /admin/* hanya boleh diakses user isAdmin=true.
// (Rapiin: SessionGuard selalu diterapkan global sebelum guard ini.)
@Injectable()
export class AdminRoleGuard implements CanActivate {
  constructor(private readonly db: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req['user'] as { id: string } | undefined;
    if (!user?.id) throw new ForbiddenException('Akses admin ditolak');
    const row = await this.db.user.findUnique({ where: { id: user.id }, select: { isAdmin: true } });
    if (!row?.isAdmin) throw new ForbiddenException('Akses admin ditolak');
    return true;
  }
}
