import { Module } from '@nestjs/common';
import { KhqrGenerator, KhqrVerifier } from './khqr.service';

@Module({
  providers: [KhqrGenerator, KhqrVerifier],
  exports: [KhqrGenerator, KhqrVerifier],
})
export class KhqrModule {}
