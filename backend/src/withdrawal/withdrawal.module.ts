import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { WalletModule } from '../wallet';
import { WithdrawalController } from './withdrawal.controller';
import { WithdrawalService } from './withdrawal.service';

@Module({
  imports: [AuditModule, WalletModule],
  controllers: [WithdrawalController],
  providers: [WithdrawalService],
  exports: [WithdrawalService],
})
export class WithdrawalModule {}
