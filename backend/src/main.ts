import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Forward SIGINT/SIGTERM into Nest's lifecycle so PrismaService.onModuleDestroy
  // (and any other shutdown hooks) actually fire on container stop.
  app.enableShutdownHooks();

  // `cookie-parser` populates `req.cookies` so `SessionCookieMiddleware`
  // (task 4.4) can read the `bothsafe_session` cookie. Mounted before any
  // route-scoped or global Nest middleware so the parsed cookies are
  // available everywhere downstream.
  app.use(cookieParser());

  const configService = app.get(ConfigService);
  const port = configService.get<number>('port') ?? 3000;
  const corsOrigins = configService.get<string[]>('cors.origins') ?? [];

  // CORS — allow configured origins (or all origins in development when list is empty)
  const nodeEnv = configService.get<string>('nodeEnv');
  app.enableCors({
    origin:
      corsOrigins.length > 0
        ? corsOrigins
        : nodeEnv === 'development'
          ? true
          : false,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Access-Token'],
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // API versioning — all routes prefixed with /v1
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
    prefix: 'v',
  });

  // Global validation pipe — validates and transforms all incoming DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,          // strip unknown properties
      forbidNonWhitelisted: false,
      transform: true,          // auto-transform payloads to DTO instances
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  await app.listen(port);
  console.log(`BothSafe backend running on port ${port}`);
}

bootstrap();
