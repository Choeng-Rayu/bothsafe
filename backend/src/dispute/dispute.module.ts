import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { DealModule } from '../deal';
import { WalletModule } from '../wallet';
import { DisputeController } from './dispute.controller';
import { DisputeService } from './dispute.service';

@Module({
  imports: [AuditModule, DealModule, WalletModule],
  controllers: [DisputeController],
  providers: [DisputeService],
  exports: [DisputeService],
})
export class DisputeModule {}
