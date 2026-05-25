import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BotService } from './bot.service';
import { BotHandlers } from './bot.handlers';

describe('BotService — token security', () => {
  const FAKE_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';

  it('bot token never appears in log output', async () => {
    const logMessages: string[] = [];
    const originalWarn = console.warn;
    const originalLog = console.log;
    const originalError = console.error;

    // Capture all console output
    console.warn = (...args: unknown[]) => logMessages.push(args.join(' '));
    console.log = (...args: unknown[]) => logMessages.push(args.join(' '));
    console.error = (...args: unknown[]) => logMessages.push(args.join(' '));

    try {
      const module = await Test.createTestingModule({
        providers: [
          BotService,
          {
            provide: ConfigService,
            useValue: { get: (key: string) => key === 'TELEGRAM_BOT_TOKEN' ? FAKE_TOKEN : undefined },
          },
          {
            provide: BotHandlers,
            useValue: {},
          },
        ],
      }).compile();

      const service = module.get(BotService);
      await service.onModuleInit();

      // Check no log message contains the token
      for (const msg of logMessages) {
        expect(msg).not.toContain(FAKE_TOKEN);
      }
    } finally {
      console.warn = originalWarn;
      console.log = originalLog;
      console.error = originalError;
    }
  });

  it('sendMessage does not leak token in debug output', async () => {
    const logMessages: string[] = [];
    const originalDebug = console.debug;
    const originalLog = console.log;
    console.debug = (...args: unknown[]) => logMessages.push(args.join(' '));
    console.log = (...args: unknown[]) => logMessages.push(args.join(' '));

    try {
      const module = await Test.createTestingModule({
        providers: [
          BotService,
          {
            provide: ConfigService,
            useValue: { get: (key: string) => key === 'TELEGRAM_BOT_TOKEN' ? FAKE_TOKEN : undefined },
          },
          {
            provide: BotHandlers,
            useValue: {},
          },
        ],
      }).compile();

      const service = module.get(BotService);
      await service.sendMessage('12345', 'test message');

      for (const msg of logMessages) {
        expect(msg).not.toContain(FAKE_TOKEN);
      }
    } finally {
      console.debug = originalDebug;
      console.log = originalLog;
    }
  });
});
