import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../prisma';
import { BOT_SERVICE_TOKEN, InAppAdapter, AdminQueueAdapter, TelegramAdapter } from './adapters';
import { NotificationOutboxService } from './notification-outbox.service';
import { NotificationDispatcher } from './notification.dispatcher';

@Module({
  imports: [PrismaModule, ScheduleModule.forRoot()],
  providers: [
    NotificationOutboxService,
    NotificationDispatcher,
    InAppAdapter,
    AdminQueueAdapter,
    TelegramAdapter,
    { provide: BOT_SERVICE_TOKEN, useValue: null },
  ],
  exports: [NotificationOutboxService],
})
export class NotificationModule {}
