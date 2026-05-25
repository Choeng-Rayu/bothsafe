import { Module } from '@nestjs/common';
import { DealModule } from '../deal';
import { WalletModule } from '../wallet';
import { ConfirmationController } from './confirmation.controller';
import { ConfirmationService } from './confirmation.service';

@Module({
  imports: [DealModule, WalletModule],
  controllers: [ConfirmationController],
  providers: [ConfirmationService],
  exports: [ConfirmationService],
})
export class ConfirmationModule {}
