import { Controller, Get } from '@nestjs/common';
import { PrismaService } from './prisma';

@Controller()
export class AppController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('health')
  async getHealth() {
    let db: 'ok' | 'fail' = 'fail';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      db = 'ok';
    } catch {}

    return {
      status: db === 'ok' ? 'ok' : 'degraded',
      db,
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? '0.0.0',
    };
  }
}
