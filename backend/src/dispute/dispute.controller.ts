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
import { DisputeService, type OpenDisputeInput } from './dispute.service';

@Controller('v1')
export class DisputeController {
  constructor(private readonly disputeService: DisputeService) {}

  @UseGuards(AuthGuard)
  @Post('deals/:publicId/disputes')
  @HttpCode(HttpStatus.CREATED)
  async openDispute(
    @Param('publicId') publicId: string,
    @Body() body: OpenDisputeInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.disputeService.openDispute(publicId, user.id, body);
  }

  @UseGuards(AuthGuard, AdminGuard)
  @Post('admin/deals/:id/release')
  @HttpCode(HttpStatus.OK)
  async adminRelease(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.disputeService.adminRelease(id, user.id);
    return { success: true };
  }

  @UseGuards(AuthGuard, AdminGuard)
  @Post('admin/deals/:id/refund')
  @HttpCode(HttpStatus.OK)
  async adminRefund(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.disputeService.adminRefund(id, user.id);
    return { success: true };
  }
}
