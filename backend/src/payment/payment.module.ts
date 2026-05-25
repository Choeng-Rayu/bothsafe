import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { DealModule } from '../deal';
import { KhqrModule } from '../khqr';
import { WalletModule } from '../wallet';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';

@Module({
  imports: [AuditModule, DealModule, KhqrModule, WalletModule],
  controllers: [PaymentController],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentModule {}
