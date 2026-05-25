import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard, AuthGuard, CurrentUser, type AuthenticatedUser } from '../auth';
import { PaymentService } from './payment.service';

@Controller('v1')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @UseGuards(AuthGuard)
  @Post('deals/:publicId/payment/wallet')
  @HttpCode(HttpStatus.OK)
  async payFromWallet(
    @Param('publicId') publicId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const deal = await this.paymentService.payFromWallet(publicId, user.id);
    return { deal_id: deal.id, status: deal.status };
  }

  @UseGuards(AuthGuard)
  @Post('deals/:publicId/payment/khqr')
  @HttpCode(HttpStatus.OK)
  async generateKhqr(
    @Param('publicId') publicId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paymentService.generateKhqr(publicId, user.id);
  }

  @UseGuards(AuthGuard)
  @Post('deals/:publicId/payment/khqr/receipt')
  @HttpCode(HttpStatus.CREATED)
  async submitReceipt(
    @Param('publicId') publicId: string,
    @Body() body: { paid_amount?: string; buyer_note?: string; attachment_key?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paymentService.submitReceipt(publicId, user.id, body);
  }

  @UseGuards(AuthGuard, AdminGuard)
  @Post('admin/payment-proofs/:id/verify')
  @HttpCode(HttpStatus.OK)
  async verifyProof(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.paymentService.adminVerifyProof(id, user.id);
    return { success: true };
  }

  @UseGuards(AuthGuard, AdminGuard)
  @Post('admin/payment-proofs/:id/reject')
  @HttpCode(HttpStatus.OK)
  async rejectProof(
    @Param('id') id: string,
    @Body() body: { reason: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.paymentService.adminRejectProof(id, user.id, body.reason);
    return { success: true };
  }
}
