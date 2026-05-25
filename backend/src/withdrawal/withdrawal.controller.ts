import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard, AuthGuard, CurrentUser, type AuthenticatedUser } from '../auth';
import {
  WithdrawalService,
  type ApproveWithdrawalInput,
  type CreateWithdrawalInput,
  type RejectWithdrawalInput,
} from './withdrawal.service';

@Controller('v1')
export class WithdrawalController {
  constructor(private readonly withdrawalService: WithdrawalService) {}

  // --- Seller endpoints ---

  @UseGuards(AuthGuard)
  @Post('withdrawals')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: CreateWithdrawalInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.withdrawalService.create(user.id, body);
  }

  @UseGuards(AuthGuard)
  @Get('withdrawals')
  async list(@CurrentUser() user: AuthenticatedUser) {
    return this.withdrawalService.listForSeller(user.id);
  }

  @UseGuards(AuthGuard)
  @Get('withdrawals/:id')
  async get(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.withdrawalService.getForSeller(id, user.id);
  }

  // --- Admin endpoints ---

  @UseGuards(AuthGuard, AdminGuard)
  @Get('admin/withdrawals')
  async adminList(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.withdrawalService.adminList(
      status,
      limit ? parseInt(limit, 10) : undefined,
      cursor,
    );
  }

  @UseGuards(AuthGuard, AdminGuard)
  @Get('admin/withdrawals/:id')
  async adminGet(@Param('id') id: string) {
    return this.withdrawalService.adminGet(id);
  }

  @UseGuards(AuthGuard, AdminGuard)
  @Post('admin/withdrawals/:id/approve')
  @HttpCode(HttpStatus.OK)
  async adminApprove(
    @Param('id') id: string,
    @Body() body: ApproveWithdrawalInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.withdrawalService.adminApprove(id, user.id, body);
    return { success: true };
  }

  @UseGuards(AuthGuard, AdminGuard)
  @Post('admin/withdrawals/:id/reject')
  @HttpCode(HttpStatus.OK)
  async adminReject(
    @Param('id') id: string,
    @Body() body: RejectWithdrawalInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.withdrawalService.adminReject(id, user.id, body);
    return { success: true };
  }
}
