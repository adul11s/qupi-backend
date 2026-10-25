import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json, type Request } from 'express';
import { AppModule } from './app.module';
import { DomainErrorFilter } from './common/domain-error.filter';

async function bootstrap(): Promise<void> {
  // Fase-4 #1: WALLET_CALLBACK_SECRET fail-closed — tanpa secret, refusi startup
  // di production; di non-production server boleh naik tapi callback tetap 403.
  // Tidak ada default secret.
  const secret = process.env.WALLET_CALLBACK_SECRET;
  if (!secret || secret.length === 0) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('WALLET_CALLBACK_SECRET wajib di-set di production (fail-closed startup)');
    }
    console.warn('[warn] WALLET_CALLBACK_SECRET kosong — endpoint callback internal akan fail-closed 403');
  }
  // Fase-3 #1: rawBody utk HMAC webhook internal. Fase-4 #7: rawBody:true seluruh
  // parser tidak bisa sekaligus naikkan limit — kita pasang body parser json sendiri:
  // limit 6mb (upload KYC base64) + verify untuk capture rawBody sejak parser.
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.setGlobalPrefix('api'); // HTTPS disimulasikan (jalan via http lokal)
  app.use(
    json({
      limit: '6mb',
      verify: (req: Request, _res, buf: Buffer) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.enableCors({ origin: true, credentials: true }); // frontend MFE (localhost:3000 dst)
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: false }));
  app.useGlobalFilters(new DomainErrorFilter());
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  console.log(`qupi-backend berjalan di http://localhost:${port} (HTTPS disimulasikan)`);
}

void bootstrap();
