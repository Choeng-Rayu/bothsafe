import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global Prisma module.
 *
 * `PrismaService` is provided once and re-exported as a global Nest provider
 * so any feature module can inject it without importing `PrismaModule`. This
 * matches the convention referenced by AGENTS.md → "Backend Coding Rules":
 * _"All module services use the shared `PrismaService`."_
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
