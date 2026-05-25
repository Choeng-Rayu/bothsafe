import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { PrismaService } from './prisma';

const mockPrisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };

describe('AppController', () => {
  let controller: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [{ provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    controller = app.get<AppController>(AppController);
  });

  describe('GET /v1/health', () => {
    it('returns ok when db is reachable', async () => {
      const result = await controller.getHealth();
      expect(result.status).toBe('ok');
      expect(result.db).toBe('ok');
      expect(result.timestamp).toBeDefined();
    });

    it('returns degraded when db fails', async () => {
      mockPrisma.$queryRaw.mockRejectedValueOnce(new Error('connection refused'));
      const result = await controller.getHealth();
      expect(result.status).toBe('degraded');
      expect(result.db).toBe('fail');
    });
  });
});
