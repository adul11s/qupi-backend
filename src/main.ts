import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { DomainErrorFilter } from './common/domain-error.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true }); // rawBody utk HMAC webhook internal
  app.setGlobalPrefix('api'); // HTTPS disimulasikan (jalan via http lokal)
  app.enableCors({ origin: true, credentials: true }); // frontend MFE (localhost:3000 dst)
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: false }));
  app.useGlobalFilters(new DomainErrorFilter());
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`qupi-backend berjalan di http://localhost:${port} (HTTPS disimulasikan)`);
}

void bootstrap();
