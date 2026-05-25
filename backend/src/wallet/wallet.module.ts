/**
 * WalletModule — provides {@link WalletService} and the wallet
 * HTTP controller (task 6).
 *
 * Imports `AuditModule` (R20.1 — audit rows for status transitions
 * inside `payDealFromWallet` / `autoReleaseToSeller`) and `DealModule`
 * (single-source-of-truth `DealService.transition` engine).
 */

import { Module } from '@nestjs/common';

import { AuditModule } from '../audit';
import { DealModule } from '../deal';

import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

@Module({
  imports: [AuditModule, DealModule],
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
